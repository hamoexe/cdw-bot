# yt-relay (Python / FastAPI) — a small always-running service whose only
# job is the part Cloudflare Workers is a bad fit for: fetching a (possibly
# large, possibly slow-to-start) file and re-uploading it to Telegram.
#
# Streaming end to end: requests.get(dlUrl, stream=True) gives a file-like
# `.raw` object that MultipartEncoder reads lazily, chunk by chunk, as the
# outbound request body is generated — the file is never fully loaded into
# memory regardless of size, same idea as the Node version, just done with
# Python's stack instead.

import logging
import os
import time

import requests
from fastapi import BackgroundTasks, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from requests_toolbelt.multipart.encoder import MultipartEncoder

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("yt-relay")

app = FastAPI()

# Shared-secret check so this endpoint isn't wide open to the internet —
# set the same value in the Worker's env as SNAPDEPLOY_RELAY_SECRET.
RELAY_SECRET = os.environ.get("RELAY_SECRET", "")

MIME_BY_EXT = {
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg", "flac": "audio/flac", "wav": "audio/wav",
}
MIME_BY_FIELD = {"video": "video/mp4", "photo": "image/jpeg", "audio": "audio/mpeg"}
EXT_BY_FIELD = {"video": "mp4", "photo": "jpg", "audio": "mp3"}


class DeliverPayload(BaseModel):
    botToken: str
    chatId: str | int
    field: str
    dlUrl: str
    statusMsgId: int | None = None
    extraParams: dict = {}
    extOverride: str | None = None
    thumbUrl: str | None = None


def tg(bot_token: str, method: str, params: dict) -> dict:
    try:
        r = requests.post(f"https://api.telegram.org/bot{bot_token}/{method}", json=params, timeout=15)
        return r.json()
    except Exception as e:
        return {"ok": False, "description": str(e)}


def esc_html(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def run_delivery(payload: DeliverPayload):
    t0 = time.monotonic()
    tag = f"[relay {payload.field} chat={payload.chatId}]"
    log.info(f"{tag} accepted job url={payload.dlUrl}")

    try:
        is_tiktok_host = "tiktok" in payload.dlUrl.lower()
        source_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        }
        if is_tiktok_host:
            source_headers["Referer"] = "https://www.tiktok.com/"

        # stream=True is what keeps this from buffering — src.raw below is a
        # lazily-read file-like object, not the full response body.
        src = requests.get(payload.dlUrl, headers=source_headers, stream=True, timeout=30)
        log.info(f"{tag} source headers in {time.monotonic()-t0:.2f}s status={src.status_code} cl={src.headers.get('content-length')}")

        if not src.ok:
            raise RuntimeError(f"source fetch HTTP {src.status_code}")
        src.raw.decode_content = True  # transparently handle gzip/deflate if the origin sends it

        final_ext = payload.extOverride if (payload.extOverride and payload.extOverride in MIME_BY_EXT) else EXT_BY_FIELD.get(payload.field, "bin")
        mime = MIME_BY_EXT.get(final_ext, MIME_BY_FIELD.get(payload.field, "application/octet-stream"))

        fields = {"chat_id": str(payload.chatId)}
        for k, v in (payload.extraParams or {}).items():
            if v not in (None, ""):
                fields[k] = str(v)
        fields[payload.field] = (f"{payload.field}.{final_ext}", src.raw, mime)

        thumb_resp = None
        if payload.thumbUrl:
            try:
                thumb_resp = requests.get(payload.thumbUrl, stream=True, timeout=10)
                if thumb_resp.ok:
                    thumb_resp.raw.decode_content = True
                    fields["thumbnail"] = ("thumb.jpg", thumb_resp.raw, "image/jpeg")
                else:
                    thumb_resp = None
            except Exception as e:
                log.info(f"{tag} thumb fetch failed: {e}")
                thumb_resp = None

        encoder = MultipartEncoder(fields=fields)
        method_name = f"send{payload.field[0].upper()}{payload.field[1:]}"
        tg_start = time.monotonic()
        tg_resp = requests.post(
            f"https://api.telegram.org/bot{payload.botToken}/{method_name}",
            data=encoder,
            headers={"Content-Type": encoder.content_type},
            timeout=None,  # this is the whole point — no arbitrary cutoff on the actual transfer
        )
        tg_json = tg_resp.json()
        log.info(f"{tag} tg upload done in {time.monotonic()-tg_start:.2f}s total={time.monotonic()-t0:.2f}s ok={tg_json.get('ok')}")

        if payload.statusMsgId:
            tg(payload.botToken, "deleteMessage", {"chat_id": payload.chatId, "message_id": payload.statusMsgId})

        if not tg_json.get("ok"):
            tg(payload.botToken, "sendMessage", {
                "chat_id": payload.chatId, "parse_mode": "HTML",
                "text": f"❌ <b>Upload failed</b>\n{esc_html(tg_json.get('description') or 'Could not send the file.')}",
            })

    except Exception as e:
        log.info(f"{tag} FAILED at t={time.monotonic()-t0:.2f}s: {e}")
        if payload.statusMsgId:
            tg(payload.botToken, "deleteMessage", {"chat_id": payload.chatId, "message_id": payload.statusMsgId})
        tg(payload.botToken, "sendMessage", {
            "chat_id": payload.chatId, "parse_mode": "HTML",
            "text": f"❌ <b>Upload failed</b>\n{esc_html(str(e))}",
        })


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/deliver")
async def deliver(payload: DeliverPayload, background_tasks: BackgroundTasks, request: Request,
                   x_relay_secret: str | None = Header(default=None)):
    if RELAY_SECRET and x_relay_secret != RELAY_SECRET:
        return JSONResponse(status_code=401, content={"ok": False, "description": "bad relay secret"})

    # Hand the HTTP response back to the Worker immediately — everything
    # below runs in the background (FastAPI's BackgroundTasks run a sync
    # function like this one in a thread pool, so it doesn't block other
    # requests) and talks to Telegram directly from here.
    background_tasks.add_task(run_delivery, payload)
    return {"ok": True, "accepted": True}
