/**
 * ══════════════════════════════════════════════════════════════════
 *  Styr1x Bot — v7 (ground-up rebuild)
 *  Platforms: TikTok + Instagram (reels/posts/stories, same 30-day cache
 *  system as TikTok) + Spotify (single tracks/episodes — no playlists/
 *  albums; permanent cache, never auto-expired or clearable) + YouTube
 *  (video at a chosen quality, or audio-only; button picker since a
 *  format/quality is required — same 30-day cache as TikTok, keyed per
 *  video+format since each is a genuinely different file).
 *  Others get added one at a time.
 * ══════════════════════════════════════════════════════════════════
 *
 * Required secrets (env):
 *   BOT_TOKEN        — Telegram bot token
 *   BOT_SECRET        — random string, used as the webhook path
 *   PAXSENIX_KEY_1..5 — at least one Paxsenix API key (comma-free, separate vars)
 *
 * Optional (enables caching):
 *   LOG_CHANNEL       — chat ID of a channel the bot admins, used as a
 *                        permanent backup/cache. Downloaded media is
 *                        uploaded there first, then copied to the
 *                        requester. Repeat requests for the same item are
 *                        served straight from this channel — no Paxsenix
 *                        call, no re-fetching the original URL.
 *   DB (binding)       — D1 database. Auto-creates its tables on first use:
 *                        tiktok_cache and instagram_cache (video/post id ->
 *                        backup message IDs, 30-day auto-expiry, clearable
 *                        via /clearcache) and spotify_cache (track id ->
 *                        single log message ID, permanent — no expiry, not
 *                        touched by /clearcache).
 *   OWNER_ID          — Telegram chat ID allowed to run /clearcache,
 *                        /admin, and /unlimited. If unset, anyone can run
 *                        them and no one bypasses the daily limit — set
 *                        this if that's not what you want.
 *   DAILY_LIMIT        — max downloads per user per UTC day. Defaults to 15
 *                        if unset. Owner + anyone in unlimited_users (see
 *                        below) bypass this entirely.
 *
 * Cache lifecycle:
 *   - Every cached TikTok/Instagram item auto-expires after 30 days: the
 *     scheduled() handler below deletes the D1 row AND the backup messages
 *     in LOG_CHANNEL, so nothing gets served back stale forever. Requires a
 *     Cron Trigger added in the Cloudflare dashboard (Workers → your worker
 *     → Triggers → Cron Triggers), e.g. "0 0 * * *" for once a day.
 *   - /clearcache <tiktok/instagram link or id>  — wipes one cached item now
 *   - /clearcache all                            — wipes TikTok + Instagram
 *                                                    caches now (Spotify's
 *                                                    permanent cache is
 *                                                    untouched)
 *
 * Rate limiting:
 *   Every user gets DAILY_LIMIT downloads per UTC day (tracked in D1's
 *   daily_usage table, one row per user per day, auto-swept once it's a
 *   couple days old). Owner always bypasses it. To give someone else
 *   unlimited access:
 *     /unlimited add <user_id>     — grant unlimited access
 *     /unlimited remove <user_id>  — put them back on the daily limit
 *     /unlimited list              — see who currently has it
 *
 * Broadcast (owner-only):
 *   /broadcast <message>              — sends HTML text to every user who
 *                                        has ever messaged the bot
 *   (reply to a message) /broadcast   — copies that message (photo, video,
 *                                        poll, etc.) to every user; any text
 *                                        after the command is used as an
 *                                        extra caption
 *   Throttled to stay under Telegram's rate limits; posts a live progress
 *   message to the owner and a final delivered/failed summary.
 *
 * Admin panel:
 *   /admin (owner-only, button navigation) — total users, active today/week,
 *   total requests handled, recent errors by platform, and the current
 *   daily-limit config (limit, unlimited-user count, how many hit the limit
 *   today). Every user interaction and every failed download gets logged to
 *   D1 (bot_users, error_log tables, auto-created) for this to read from.
 *
 * Routes:
 *   GET  /registerWebhook          — (re)registers the Telegram webhook
 *   GET  /unregisterWebhook        — removes it
 *   POST /webhook/<BOT_SECRET>     — Telegram sends updates here
 */

// ── Config ──────────────────────────────────────────────────────────
const PAXSENIX_BASE = "https://api.paxsenix.org";
const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "m.tiktok.com"]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
// Confirmed working path: /dl/ig
const IG_ENDPOINT = "/dl/ig";
const SPOTIFY_HOSTS = new Set(["open.spotify.com", "spotify.link"]);
// Confirmed working path: /dl/spotify. Despite the docs marking "serv" as
// optional, it actually needs to be one of these — leaving it out returns
// "Selected server is not listed". Tries each in order until one works.
const SPOTIFY_ENDPOINT = "/dl/spotify";
const SPOTIFY_SERVERS = ["spotify", "spotdl", "youtube", "deezer"];
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const YT_AUDIO_ENDPOINT = "/dl/ytmp3";
const YT_VIDEO_ENDPOINT = "/dl/ytmp4";
const YT_AUDIO_FORMAT = "mp3"; // only format exposed as a button; API supports more (m4a/webm/aac/flac/opus/ogg/wav)
const YT_VIDEO_QUALITIES = ["360", "480", "720", "1080", "1440"];

const YT_POLL_INTERVAL_MS = 7000;

// Rough time-to-ready model, fit from two real observations on the same
// 3:54 (234s) video: 360p landed in ~15s, 720p in ~29s, mp3 in ~13-15s.
// 720p took ~1.9x as long as 360p — close enough to the 2x height ratio
// (720/360) to treat conversion time as roughly linear in output height.
// That gives two points to fit a line of "seconds of conversion per
// second of video" vs. quality height. Audio doesn't have a height, so it
// gets its own flat rate instead of running through the line.
const YT_TIME_MODEL = {
  slopePerHeight: 0.0001661, // (0.1239 - 0.0641) / (720 - 360)
  intercept: 0.0043,         // 0.0641 - slopePerHeight * 360
  audioRate: 0.0598,         // ~14s / 234s
};

// Estimated seconds until a job is likely ready, given the source video's
// duration and the requested format. Returns null if duration is unknown
// (e.g. the watch-page scrape below failed) — callers just skip showing
// an ETA in that case rather than guessing.
function estimateYtSeconds(durationSec, format) {
  if (!durationSec || durationSec <= 0) return null;
  const rate = format === YT_AUDIO_FORMAT
    ? YT_TIME_MODEL.audioRate
    : YT_TIME_MODEL.slopePerHeight * (parseInt(format, 10) || 360) + YT_TIME_MODEL.intercept;
  return Math.max(5, Math.round(durationSec * rate));
}

function formatEta(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

// Scrapes the watch page for lengthSeconds — the same field yt-dlp itself
// reads duration from — so no extra API key is needed. Best-effort: a
// miss just means no ETA gets shown, it never blocks the download.
async function getYoutubeDuration(videoId) {
  try {
    const resp = await fetchT(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    }, 6000);
    if (!resp.ok) return null;
    const html = await resp.text();
    const m = html.match(/"lengthSeconds":"(\d+)"/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}
const URL_RE = /https?:\/\/[^\s]+/i;

// ── Small helpers ───────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(s ?? "").replace(/&(#(\d+)|#x([0-9a-f]+)|[a-z]+);/gi, (m, whole, dec, hex) => {
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return named[whole.toLowerCase()] ?? m;
  });
}

// Pulls title/artist/cover/duration straight off Spotify's own og:/music:
// meta tags on the track page — a single plain HTML fetch, no OAuth client-
// credentials dance. Handles both attribute orderings since some renders put
// content= before property=.
function parseSpotifyMeta(html) {
  const get = (prop) => {
    let m = html.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"));
    if (m) return m[1];
    m = html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${prop}["']`, "i"));
    return m ? m[1] : null;
  };
  const title = get("og:title");
  let artist = get("music:musician_description");
  if (!artist) {
    // Not every release has the dedicated musician tag (seen on some
    // user-uploaded/remix-style releases). og:description almost always
    // exists though, in "Artist · Album · Type · Year" form — same thing
    // Telegram's own link-preview scraper pulls the artist from.
    const ogDesc = get("og:description") || get("twitter:description");
    if (ogDesc) {
      const seg = ogDesc.split(/\s*[·|]\s*/)[0]?.trim();
      if (seg) artist = seg;
    }
  }
  const image = get("og:image");
  const durationRaw = get("music:duration");
  return {
    title: title ? decodeEntities(title) : null,
    artist: artist ? decodeEntities(artist) : null,
    image: image || null,
    duration: durationRaw ? parseInt(durationRaw, 10) : null,
  };
}

async function fetchSpotifyMeta(url) {
  try {
    const r = await fetchT(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }, 6000);
    if (!r.ok) return null;
    return parseSpotifyMeta(await r.text());
  } catch { return null; }
}

async function fetchT(url, opts = {}, ms = 12000) {
  return fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(ms) });
}

async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json();
}

// TikTok's CDN (tiktokcdn-us.com, tokcdn.com, etc.) often 403s requests with
// no Referer header. Telegram's own server-side URL fetcher doesn't send
// one, so handing it a raw CDN link silently fails — Telegram just skips
// that message with no visible error. This proxies the file through the
// worker instead: fetch it ourselves with the headers TikTok expects, then
// upload the bytes directly via multipart.
async function tgUploadProxied(env, field, chatId, url, extraParams = {}, extOverride, thumbUrl) {
  // AbortSignal-based timeouts below only reliably cover getting the
  // response headers — a slow/stalled body stream (resp.arrayBuffer()) can
  // still hang past that point on some runtimes. Race the whole operation
  // against a hard wall-clock timeout so this function is *guaranteed* to
  // resolve one way or another, instead of leaving the caller's "Sending..."
  // status message frozen forever if any single step stalls.
  // Raised from 25s -> 40s: it must stay comfortably above the source-fetch
  // timeout below (30s) or it can never win the race with a real result —
  // it would just fire first every time.
  const timeout = new Promise(resolve =>
    setTimeout(() => resolve({ ok: false, description: "upload timed out (outer 40s race)" }), 40000)
  );
  return Promise.race([tgUploadProxiedInner(env, field, chatId, url, extraParams, extOverride, thumbUrl), timeout]);
}

async function tgUploadProxiedInner(env, field, chatId, url, extraParams = {}, extOverride, thumbUrl) {
  const t0 = Date.now();
  const tag = `[proxyUpload ${field}]`;
  try {
    // The TikTok CDN needs a tiktok.com Referer or it 403s (see comment
    // above). That header is meaningless — and possibly counterproductive —
    // for other origins (Paxsenix's YouTube/Spotify hosts, etc.), so only
    // attach it when the source URL is actually TikTok's CDN.
    const isTikTokHost = /tiktok/i.test(url);
    const sourceHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    };
    if (isTikTokHost) sourceHeaders["Referer"] = "https://www.tiktok.com/";

    console.log(`${tag} source fetch start url=${url}`);
    // Raised from 15s -> 30s. YouTube's Paxsenix dlUrl can have real
    // time-to-first-byte latency (server-side mux/transcode on first hit)
    // on top of just being a bigger file than a TikTok clip or Spotify
    // track — 15s was routinely too tight for that combination and was
    // the actual source of the "aborted due to timeout" failures.
    const resp = await fetchT(url, { headers: sourceHeaders }, 30000);
    console.log(`${tag} source headers in ${Date.now() - t0}ms status=${resp.status} cl=${resp.headers.get("content-length")}`);
    if (!resp.ok) return { ok: false, description: `proxy fetch HTTP ${resp.status}` };
    const contentLength = parseInt(resp.headers.get("content-length") || "0");
    if (contentLength > 45 * 1024 * 1024) return { ok: false, description: "file too large to proxy (>45MB)" };

    const bufStart = Date.now();
    const buf = await resp.arrayBuffer();
    console.log(`${tag} arrayBuffer done in ${Date.now() - bufStart}ms size=${buf.byteLength} totalSoFar=${Date.now() - t0}ms`);

    const mimeByExt = {
      mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
      mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", wav: "audio/wav",
    };
    const mimeByField = { video: "video/mp4", photo: "image/jpeg", audio: "audio/mpeg" };
    const extByField  = { video: "mp4", photo: "jpg", audio: "mp3" };
    const finalExt = (extOverride && mimeByExt[extOverride]) ? extOverride : extByField[field];
    const mime = mimeByExt[finalExt] || mimeByField[field];
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    for (const [k, v] of Object.entries(extraParams)) if (v !== undefined && v !== "") fd.append(k, String(v));
    fd.append(field, new Blob([buf], { type: mime }), `${field}.${finalExt}`);

    // Cosmetic only (cover art in the player) — Telegram requires thumbnails
    // to be an actual uploaded file, not a URL, so fetch it ourselves. If
    // this fails for any reason, just skip it rather than failing the send.
    if (thumbUrl) {
      const thStart = Date.now();
      try {
        const tr = await fetchT(thumbUrl, {}, 5000);
        console.log(`${tag} thumb fetch ${Date.now() - thStart}ms ok=${tr.ok}`);
        if (tr.ok) {
          const tbuf = await tr.arrayBuffer();
          fd.append("thumbnail", new Blob([tbuf], { type: "image/jpeg" }), "thumb.jpg");
        }
      } catch (e) { console.log(`${tag} thumb FAILED ${Date.now() - thStart}ms: ${e.message}`); }
    }

    const methodName = `send${field[0].toUpperCase()}${field.slice(1)}`;
    const tgStart = Date.now();
    const r = await fetchT(`https://api.telegram.org/bot${env.BOT_TOKEN}/${methodName}`, { method: "POST", body: fd }, 20000);
    console.log(`${tag} tg POST done in ${Date.now() - tgStart}ms total=${Date.now() - t0}ms`);
    return await r.json();
  } catch (e) {
    console.log(`${tag} FAILED at t=${Date.now() - t0}ms: ${e.message}`);
    return { ok: false, description: e.message };
  }
}

// Hands a delivery job off to the SnapDeploy relay service instead of doing
// the download+reupload in the Worker. Only does anything if
// env.SNAPDEPLOY_RELAY_URL is set — leave it unset and every caller falls
// straight back to the existing tgUploadProxied/sendMediaSmart path, so this
// is safe to test alongside the current behavior rather than replacing it.
// The relay call itself just needs to *accept* the job (it responds
// immediately and does the real work in the background) — 8s is generous
// for that.
async function deliverViaRelay(env, { field, chatId, statusMsgId, dlUrl, extraParams, extOverride, thumbUrl }) {
  const relayUrl = env.SNAPDEPLOY_RELAY_URL;
  if (!relayUrl) return false;
  try {
    const r = await fetchT(`${relayUrl.replace(/\/$/, "")}/deliver`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SNAPDEPLOY_RELAY_SECRET ? { "x-relay-secret": env.SNAPDEPLOY_RELAY_SECRET } : {}),
      },
      body: JSON.stringify({ botToken: env.BOT_TOKEN, chatId, statusMsgId, field, dlUrl, extraParams, extOverride, thumbUrl }),
    }, 8000);
    const data = await r.json().catch(() => null);
    if (!data?.ok) console.log(`[relay handoff] rejected: ${data?.description || r.status}`);
    return !!data?.ok;
  } catch (e) {
    console.log(`[relay handoff] failed: ${e.message}`);
    return false;
  }
}

// Tries the cheap path first (hand Telegram the raw URL — no bandwidth cost
// to us). Only falls back to fetching+uploading ourselves if that fails.
// extOverride lets callers hint the real file extension (e.g. "webp" for an
// Instagram image) so the proxied fallback uploads it with the right mime
// type instead of assuming jpg.
async function sendMediaSmart(env, field, chatId, url, extraParams = {}, extOverride) {
  const methodName = `send${field[0].toUpperCase()}${field.slice(1)}`;
  const direct = await tg(env, methodName, { chat_id: chatId, [field]: url, ...extraParams });
  if (direct?.ok) return direct;
  return tgUploadProxied(env, field, chatId, url, extraParams, extOverride);
}

function extractUrl(text) {
  const m = String(text || "").match(URL_RE);
  return m ? m[0] : null;
}

// Shared "we're actually sending it now" status text + Telegram's native
// chat-action indicator (the little "sending video..." bubble), used right
// before the upload step across TikTok/Instagram/Spotify/YouTube so the
// status message reflects what's happening instead of just disappearing.
const SENDING_LABEL = { video: "🎬 Sending video...", photo: "🖼️ Sending photo...", audio: "🎵 Sending music..." };
const SENDING_ACTION = { video: "upload_video", photo: "upload_photo", audio: "upload_document" };

function sendingText(kind) {
  return SENDING_LABEL[kind] || "📤 Sending...";
}

async function tgChatAction(env, chatId, kind) {
  return tg(env, "sendChatAction", { chat_id: chatId, action: SENDING_ACTION[kind] || "upload_document" }).catch(() => {});
}


// 2870 -> "2.87k", 1000000 -> "1m", 93 -> "93"
function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return (Number.isInteger(v) ? v : v.toFixed(2)) + "m";
  }
  if (n >= 1000) {
    const v = n / 1000;
    return (Number.isInteger(v) ? v : v.toFixed(2)) + "k";
  }
  return String(n);
}

function getHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function getKeyPool(env) {
  return [env.PAXSENIX_KEY_1, env.PAXSENIX_KEY_2, env.PAXSENIX_KEY_3, env.PAXSENIX_KEY_4, env.PAXSENIX_KEY_5]
    .filter(Boolean);
}

// Pulls the numeric video ID out of a canonical TikTok URL, e.g.
// https://www.tiktok.com/@d.leonx2/video/7657711517420309768 -> 7657711517420309768
function extractVideoId(url) {
  const m = String(url || "").match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

// Pulls the shortcode out of an Instagram reel/post/tv URL, e.g.
// https://www.instagram.com/reel/DEFabc123XY/ -> DEFabc123XY
function extractInstagramId(url) {
  const m = String(url || "").match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Pulls the 11-char video ID out of any common YouTube URL shape:
// watch?v=, youtu.be/, /shorts/, /embed/, music.youtube.com/watch?v=
function extractYoutubeId(url) {
  const m = String(url || "").match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

// ── D1 cache layer ────────────────────────────────────────────────────
let schemaEnsured = false;
async function ensureSchema(env) {
  if (schemaEnsured || !env.DB) return;
  // tiktok_cache and instagram_cache share the same shape (generic "video_id"
  // column holds whatever id makes sense for that platform — numeric TikTok
  // video id, or Instagram's alphanumeric shortcode) so the cache helper
  // functions below can work against either table via a `table` param.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tiktok_cache (
       video_id TEXT PRIMARY KEY,
       log_msg_ids TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS instagram_cache (
       video_id TEXT PRIMARY KEY,
       log_msg_ids TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`
  ).run();
  // Cache key is "<videoId>:<format>" (e.g. "dQw4w9WgXcQ:720" or
  // "dQw4w9WgXcQ:mp3") since the same video downloaded at different
  // qualities/formats are genuinely different files.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS youtube_cache (
       video_id TEXT PRIMARY KEY,
       log_msg_ids TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`
  ).run();
  // Paxsenix's YT endpoints are async (job id + task_url you have to poll).
  // One row per in-flight job so a "Check again" tap can look up exactly
  // which task_url/key to re-check without needing any of that encoded into
  // the callback_data itself (which has a 64-byte limit). Swept out after a
  // couple hours regardless of outcome — see purgeExpiredCache.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS yt_jobs (
       job_id TEXT PRIMARY KEY,
       chat_id INTEGER NOT NULL,
       msg_id INTEGER NOT NULL,
       user_id INTEGER,
       video_id TEXT NOT NULL,
       format TEXT NOT NULL,
       task_url TEXT NOT NULL,
       api_key TEXT NOT NULL,
       checks INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`
  ).run();
  // Deliberately separate table, with no purge/expiry logic anywhere in this
  // file — the whole point is to keep the first-ever download of a track
  // around forever, since Paxsenix's source audio for a given track can
  // change over time. Never touched by /clearcache or the auto-expiry sweep.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS spotify_cache (
       track_id TEXT PRIMARY KEY,
       log_msg_id INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS bot_users (
       user_id INTEGER PRIMARY KEY,
       username TEXT,
       first_name TEXT,
       first_seen INTEGER NOT NULL,
       last_seen INTEGER NOT NULL,
       request_count INTEGER NOT NULL DEFAULT 0
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS error_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER,
       platform TEXT,
       message TEXT,
       created_at INTEGER NOT NULL
     )`
  ).run();
  // One row per user per UTC day — resets naturally at midnight UTC since
  // the date string just changes and a fresh row gets INSERTed. Old rows
  // get swept out periodically in scheduled() so this doesn't grow forever.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS daily_usage (
       user_id INTEGER NOT NULL,
       date TEXT NOT NULL,
       count INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (user_id, date)
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS unlimited_users (
       user_id INTEGER PRIMARY KEY,
       added_at INTEGER NOT NULL
     )`
  ).run();
  schemaEnsured = true;
}

// Upserts the user's row (bumping last_seen + request_count) every time they
// send the bot a link. Best-effort — a tracking failure should never stop a
// download from working.
async function logUser(env, from) {
  if (!env.DB || !from?.id) return;
  await ensureSchema(env);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO bot_users(user_id, username, first_name, first_seen, last_seen, request_count)
       VALUES(?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         first_name = excluded.first_name,
         last_seen = excluded.last_seen,
         request_count = request_count + 1`
    ).bind(from.id, from.username || null, from.first_name || null, now, now).run();
  } catch { /* tracking is best-effort */ }
}

// Records a failed download so the admin panel can surface it. Best-effort —
// never blocks or throws into the actual error-reporting path.
async function logError(env, userId, platform, message) {
  if (!env.DB) return;
  await ensureSchema(env);
  try {
    await env.DB.prepare(
      "INSERT INTO error_log(user_id, platform, message, created_at) VALUES(?, ?, ?, ?)"
    ).bind(userId || null, platform, String(message || "").slice(0, 500), Date.now()).run();
  } catch { /* tracking is best-effort */ }
}

// ── Daily rate limiting ────────────────────────────────────────────
const DEFAULT_DAILY_LIMIT = 15;
function getDailyLimit(env) {
  const n = parseInt(env.DAILY_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}
function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function isUnlimitedUser(env, userId) {
  if (!env.DB || !userId) return false;
  await ensureSchema(env);
  try {
    const row = await env.DB.prepare("SELECT 1 FROM unlimited_users WHERE user_id = ?").bind(userId).first();
    return !!row;
  } catch { return false; }
}

async function addUnlimitedUser(env, userId) {
  await ensureSchema(env);
  await env.DB.prepare("INSERT OR REPLACE INTO unlimited_users(user_id, added_at) VALUES(?, ?)")
    .bind(userId, Date.now()).run();
}

async function removeUnlimitedUser(env, userId) {
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM unlimited_users WHERE user_id = ?").bind(userId).run();
}

async function listUnlimitedUsers(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT user_id FROM unlimited_users ORDER BY added_at").all()
    .catch(() => ({ results: [] }));
  return (results || []).map(r => r.user_id);
}

// Atomically bumps today's counter for this user and returns the new count.
// Fails open (returns 0, i.e. "not limited yet") on any DB error — a
// tracking hiccup should never be the reason a download gets blocked.
async function bumpDailyUsage(env, userId) {
  if (!env.DB || !userId) return 0;
  await ensureSchema(env);
  const date = todayUTC();
  try {
    await env.DB.prepare(
      `INSERT INTO daily_usage(user_id, date, count) VALUES(?, ?, 1)
       ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1`
    ).bind(userId, date).run();
    const row = await env.DB.prepare(
      "SELECT count FROM daily_usage WHERE user_id = ? AND date = ?"
    ).bind(userId, date).first();
    return row ? row.count : 1;
  } catch { return 0; }
}

// Checks + bumps in one call. Returns { allowed, count, limit }. Owners and
// anyone in unlimited_users always pass with no counter touched at all.
async function checkDailyLimit(env, userId) {
  const limit = getDailyLimit(env);
  if (isOwner(userId, env) || await isUnlimitedUser(env, userId)) {
    return { allowed: true, count: 0, limit: Infinity };
  }
  const count = await bumpDailyUsage(env, userId);
  return { allowed: count <= limit, count, limit };
}

async function spotifyCacheGet(env, trackId) {
  if (!env.DB || !trackId) return null;
  try {
    const row = await env.DB.prepare("SELECT log_msg_id FROM spotify_cache WHERE track_id = ?")
      .bind(trackId).first();
    return row ? row.log_msg_id : null;
  } catch { return null; }
}

async function spotifyCacheSet(env, trackId, logMsgId) {
  if (!env.DB || !trackId || !logMsgId) return;
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO spotify_cache(track_id, log_msg_id, created_at) VALUES(?, ?, ?)"
    ).bind(trackId, logMsgId, Date.now()).run();
  } catch { /* caching is best-effort — never block a download over it */ }
}

// Pulls the track/episode ID out of a Spotify URL, e.g.
// https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=... -> 0VjIjW4GlUZAMYd2vXMi3b
function extractSpotifyId(url) {
  const m = String(url).match(/\/(?:track|episode)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

async function cacheGet(env, table, itemId) {
  if (!env.DB || !itemId) return null;
  try {
    const row = await env.DB.prepare(`SELECT log_msg_ids FROM ${table} WHERE video_id = ?`)
      .bind(itemId).first();
    return row ? JSON.parse(row.log_msg_ids) : null;
  } catch { return null; }
}

async function cacheSet(env, table, itemId, logMsgIds) {
  if (!env.DB || !itemId || !logMsgIds.length) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ${table}(video_id, log_msg_ids, created_at) VALUES(?, ?, ?)`
    ).bind(itemId, JSON.stringify(logMsgIds), Date.now()).run();
  } catch { /* caching is best-effort — never block a download over it */ }
}

async function cacheDeleteRow(env, table, itemId) {
  if (!env.DB || !itemId) return;
  try {
    await env.DB.prepare(`DELETE FROM ${table} WHERE video_id = ?`).bind(itemId).run();
  } catch { /* best-effort */ }
}

async function cacheGetAll(env, table) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT video_id, log_msg_ids, created_at FROM ${table}`
    ).all();
    return results || [];
  } catch { return []; }
}

// Deletes the backup messages in LOG_CHANNEL for one cached item, then drops
// its D1 row. This is the only place that actually removes the cached files —
// both the manual command and the auto-expiry sweep below call into this.
async function purgeCacheEntry(env, table, itemId, logMsgIds) {
  if (env.LOG_CHANNEL) {
    for (const id of logMsgIds || []) {
      await tg(env, "deleteMessage", { chat_id: env.LOG_CHANNEL, message_id: id }).catch(() => {});
    }
  }
  await cacheDeleteRow(env, table, itemId);
}

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CACHED_TABLES = ["tiktok_cache", "instagram_cache", "youtube_cache"]; // spotify_cache is permanent, excluded

// Wipes every cache entry older than 30 days across both TikTok and
// Instagram tables — D1 row + its backup messages in LOG_CHANNEL. Meant to
// be triggered on a schedule (see scheduled() at the bottom) so old cached
// files don't get served back forever. Returns how many entries it purged.
async function purgeExpiredCache(env) {
  await ensureSchema(env);
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  let purged = 0;
  for (const table of CACHED_TABLES) {
    const rows = await cacheGetAll(env, table);
    for (const row of rows) {
      if ((row.created_at || 0) < cutoff) {
        let ids = [];
        try { ids = JSON.parse(row.log_msg_ids); } catch { /* skip bad row */ }
        await purgeCacheEntry(env, table, row.video_id, ids);
        purged++;
      }
    }
  }

  // Housekeeping: daily_usage rows are only ever queried for "today", so
  // anything older just accumulates dead weight. Keep a 2-day buffer instead
  // of deleting same-day rows to be safe against any clock skew.
  try {
    const cutoffDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM daily_usage WHERE date < ?").bind(cutoffDate).run();
  } catch { /* best-effort */ }

  // Housekeeping: any yt_jobs row left over from a conversion the user never
  // came back to check on (job abandoned, message deleted, etc.) — 2 hours
  // is generous for even a very slow conversion.
  try {
    await env.DB.prepare("DELETE FROM yt_jobs WHERE created_at < ?")
      .bind(Date.now() - 2 * 60 * 60 * 1000).run();
  } catch { /* best-effort */ }

  return purged;
}

// Manual cache wipe — /clearcache <tiktok or instagram link, or raw id>, or
// /clearcache all to nuke everything (TikTok + Instagram; Spotify's cache is
// permanent and deliberately untouched by this command). Restricted to
// OWNER_ID if that env var is set.
async function handleClearCache(env, chatId, arg) {
  await ensureSchema(env);

  if (!arg || arg.toLowerCase() === "all") {
    let total = 0;
    for (const table of CACHED_TABLES) {
      const rows = await cacheGetAll(env, table);
      for (const row of rows) {
        let ids = [];
        try { ids = JSON.parse(row.log_msg_ids); } catch { /* skip bad row */ }
        await purgeCacheEntry(env, table, row.video_id, ids);
        total++;
      }
    }
    await tg(env, "sendMessage", { chat_id: chatId,
      text: `🗑️ Cleared ${total} cached item${total === 1 ? "" : "s"} (TikTok + Instagram + YouTube).` });
    return;
  }

  const trimmed = arg.trim();
  const host = getHost(trimmed) || "";
  // Figure out which table this belongs to: a link's host tells us directly;
  // a raw ID is TikTok if purely numeric, YouTube if it's exactly the
  // 11-char video-id shape, otherwise assumed to be an Instagram shortcode.
  let table, itemId, isYoutubeTarget = false;
  if (TIKTOK_HOSTS.has(host)) { table = "tiktok_cache"; itemId = extractVideoId(trimmed); }
  else if (INSTAGRAM_HOSTS.has(host)) { table = "instagram_cache"; itemId = extractInstagramId(trimmed); }
  else if (YT_HOSTS.has(host)) { table = "youtube_cache"; itemId = extractYoutubeId(trimmed); isYoutubeTarget = true; }
  else if (/^\d+$/.test(trimmed)) { table = "tiktok_cache"; itemId = trimmed; }
  else if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) { table = "youtube_cache"; itemId = trimmed; isYoutubeTarget = true; }
  else { table = "instagram_cache"; itemId = trimmed; }

  if (!itemId) {
    await tg(env, "sendMessage", { chat_id: chatId,
      text: "⚠️ Send a TikTok/Instagram/YouTube link, a raw video id / IG shortcode, or /clearcache all." });
    return;
  }

  // YouTube caches by "<videoId>:<format>" — a video can have several
  // cached entries (one per quality/format requested), so this clears all
  // of them for that video rather than needing the format specified too.
  if (isYoutubeTarget) {
    const { results } = await env.DB.prepare(
      "SELECT video_id, log_msg_ids FROM youtube_cache WHERE video_id LIKE ?"
    ).bind(`${itemId}:%`).all().catch(() => ({ results: [] }));
    if (!results || !results.length) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "ℹ️ Nothing cached for that video." });
      return;
    }
    for (const row of results) {
      let ids = [];
      try { ids = JSON.parse(row.log_msg_ids); } catch { /* skip bad row */ }
      await purgeCacheEntry(env, "youtube_cache", row.video_id, ids);
    }
    await tg(env, "sendMessage", { chat_id: chatId,
      text: `🗑️ Cache cleared (${results.length} format${results.length === 1 ? "" : "s"}) — next request will re-fetch fresh.` });
    return;
  }

  const cached = await cacheGet(env, table, itemId);
  if (!cached) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "ℹ️ Nothing cached for that." });
    return;
  }

  await purgeCacheEntry(env, table, itemId, cached);
  await tg(env, "sendMessage", { chat_id: chatId,
    text: "🗑️ Cache cleared — next request will re-fetch fresh." });
}

// ── Paxsenix call layer ─────────────────────────────────────────────
async function dlCall(endpoint, url, key, extraParams = {}, ms = 12000) {
  const params = new URLSearchParams({ url, ...extraParams });
  const r = await fetchT(`${PAXSENIX_BASE}${endpoint}?${params}`,
    { headers: { Authorization: `Bearer ${key}` } }, ms);
  if (r.status === 429) throw new Error("RATE_LIMITED");
  if (!r.ok) {
    // Paxsenix usually explains itself in the body even on a non-2xx status
    // (e.g. "This account is private.") — surface that plainly instead of a
    // meaningless "HTTP 500" that tells the user nothing useful.
    let detail = "";
    try {
      const body = await r.json();
      detail = body?.message || body?.error || "";
    } catch { /* body wasn't JSON — fall through to generic message */ }
    throw new Error(detail || `Download failed (HTTP ${r.status}).`);
  }
  return r.json();
}

async function dlCallWithFallback(endpoint, url, keys, extraParams = {}) {
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(Math.floor(Date.now() / 1000) + i) % keys.length];
    try { return await dlCall(endpoint, url, key, extraParams); }
    catch (e) {
      lastErr = e;
      if (e.message === "RATE_LIMITED" && i < keys.length - 1) continue;
      throw e;
    }
  }
  throw lastErr || new Error("NO_KEYS");
}

// Single instant check against a Paxsenix task_url — no sleep loop. Each
// Telegram button tap is its own fresh invocation, so "waiting" is done by
// the user re-tapping, not by holding the worker open.
async function dlCheckTask(taskUrl, key) {
  try {
    const tr = await fetchT(taskUrl, { headers: { Authorization: `Bearer ${key}` } }, 8000);
    if (!tr.ok) return null;
    return await tr.json();
  } catch { return null; }
}

// ── Response parsing ─────────────────────────────────────────────────
// Paxsenix's exact response shape varies by provider/version, so this tries
// several known shapes in order. Kept intentionally defensive.
function extractMedia(data) {
  if (!data) return null;

  if (Array.isArray(data.downloadUrls) && data.downloadUrls.length) {
    const out = [];
    for (const item of data.downloadUrls) {
      if (!item.url) continue;
      const ext = (item.ext || item.type || "").toLowerCase();
      if (["mp4", "mov", "webm"].includes(ext)) out.push({ url: item.url, type: "video", ext });
      else if (["mp3", "audio"].includes(ext)) out.push({ url: item.url, type: "audio", ext });
      else out.push({ url: item.url, type: "photo", ext });
    }
    if (out.length) return out;
  }

  if (data.downloadUrls && !Array.isArray(data.downloadUrls)) {
    const du = data.downloadUrls;
    const isImagePost = data.detail?.type === "image";
    const musicUrl = du.music || du.audio || du.mp3 || null;

    if (isImagePost && Array.isArray(du.images) && du.images.length) {
      const items = du.images.map(u => ({ url: u, type: "photo" }));
      if (musicUrl) items.push({ url: musicUrl, type: "audio", isMusic: true });
      return items;
    }
    if (Array.isArray(du.images) && du.images.length) {
      const items = du.images.map(u => ({ url: u, type: "photo" }));
      if (musicUrl) items.push({ url: musicUrl, type: "audio", isMusic: true });
      return items;
    }

    // Keys per Paxsenix: video = HD, video_standard = SD.
    const hd = du.video;
    const sd = du.video_standard || du.sd || du.mp4;
    const videoUrl = (hd && typeof hd === "string" && hd.startsWith("http")) ? hd
                    : (sd && typeof sd === "string" && sd.startsWith("http")) ? sd : null;
    if (videoUrl) {
      const items = [{ url: videoUrl, type: "video" }];
      if (musicUrl) items.push({ url: musicUrl, type: "audio", isMusic: true });
      return items;
    }
    if (musicUrl) return [{ url: musicUrl, type: "audio", isMusic: true }];
  }

  if (data.detail?.download) return [{ url: data.detail.download, type: "video" }];
  if (data.url) return [{ url: data.url, type: "video" }];
  if (data.video) return [{ url: data.video, type: "video" }];
  if (data.download) return [{ url: data.download, type: "video" }];

  if (Array.isArray(data.medias) && data.medias.length) {
    const best = data.medias.find(m => m.url && m.quality !== "audio") || data.medias[0];
    if (best?.url) return [{ url: best.url, type: "video" }];
  }

  return null;
}

function extractMeta(data, platform = "tiktok") {
  const d = data.detail || {};

  if (platform === "instagram") {
    // Stories reuse the same detail shape but have no real caption (title is
    // just a generic "Instagram <user> stories <id>" placeholder) and no
    // like/comment counts, so both are left undefined and buildCaption skips them.
    const isStory = Array.isArray(d.story_links);
    return {
      authorUsername: d.username || "",
      desc: isStory ? "" : (d.title || ""),
      likes: isStory ? undefined : d.like_count,
      comments: isStory ? undefined : d.comment_count,
    };
  }

  return {
    author:           d.author || data.author || data.uploader || "",
    authorUsername:   d.authorUsername || "",
    authorProfileLink: d.authorProfileLink || "",
    desc:             d.description || data.description || data.caption || "",
    cover:            d.cover || data.thumbnail || data.thumb || data.info?.thumbnail || data.info?.image || "",
    views:            d.view ?? d.views ?? 0,
    likes:            d.like ?? d.likes ?? 0,
    shares:           d.share ?? d.shares ?? 0,
  };
}

// platform: "tiktok" keeps the original views/likes/shares line. "instagram"
// drops shares entirely (Paxsenix's IG response has no share count) and
// shows likes/comments instead, only when those values are actually present.
function buildCaption(meta, platform = "tiktok") {
  const displayName = meta.authorUsername || meta.author || "Unknown";
  const profileLink = meta.authorProfileLink
    || (platform === "instagram" && meta.authorUsername ? `https://www.instagram.com/${meta.authorUsername}/` : "");
  const nameLine = profileLink
    ? `👤 <a href="${esc(profileLink)}">${esc(displayName)}</a>`
    : `👤 ${esc(displayName)}`;

  let statsLine = "";
  if (platform === "instagram") {
    const parts = [];
    if (meta.likes !== undefined) parts.push(`♥: ${formatCount(meta.likes)}`);
    if (meta.comments !== undefined) parts.push(`💬: ${formatCount(meta.comments)}`);
    statsLine = parts.join(" ");
  } else {
    statsLine = `👁️‍🗨️: ${formatCount(meta.views)} ♥: ${formatCount(meta.likes)} ➦: ${formatCount(meta.shares)}`;
  }

  let caption = statsLine ? `${nameLine}\n${statsLine}` : nameLine;
  if (meta.desc && meta.desc.trim()) {
    const trimmed = meta.desc.length > 600 ? meta.desc.slice(0, 597) + "…" : meta.desc;
    caption += `\n---------\n<blockquote expandable>${esc(trimmed)}</blockquote>`;
  }
  return caption.length > 1024 ? caption.slice(0, 1021) + "…" : caption;
}

// TikTok short links (vm./vt.) need resolving to the canonical URL before
// Paxsenix can reliably parse them.
async function resolveCanonicalUrl(url, host) {
  if (host !== "vm.tiktok.com" && host !== "vt.tiktok.com") return url;
  try {
    const r = await fetchT(url, { method: "HEAD", redirect: "follow" }, 6000);
    if (r.url && r.url !== url) return r.url;
  } catch { /* fall through to original url */ }
  return url;
}

// spotify.link short URLs (what the Spotify app actually generates when you
// hit Share) don't contain /track/<id> or /episode/<id> anywhere, so
// extractSpotifyId() always returned null for them — which silently broke
// caching for every short-link request (no id => cacheGet/cacheSet never
// engage, so it re-downloads and re-uploads to Paxsenix every single time).
// Resolving to the canonical open.spotify.com/track/<id> URL first fixes it.
async function resolveSpotifyCanonical(url, host) {
  if (host !== "spotify.link") return url;
  try {
    const r = await fetchT(url, { method: "HEAD", redirect: "follow" }, 6000);
    if (r.url && r.url !== url) return r.url;
  } catch { /* fall through to original url */ }
  return url;
}

// ── Core: download + send ────────────────────────────────────────────
async function handleTikTok(env, chatId, url, userId) {
  const keys = getKeyPool(env);
  if (!keys.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ No download keys configured — tell the owner." });
    return;
  }

  await ensureSchema(env);

  const host = getHost(url) || "";
  // vt./vm. short links resolve to the canonical @user/video/id form, e.g.
  // https://vt.tiktok.com/ZSXse9a1K/ -> https://www.tiktok.com/@d.leonx2/video/7657711517420309768
  const canonicalUrl = await resolveCanonicalUrl(url, host);
  const videoId = extractVideoId(canonicalUrl);

  // Cache hit: resend from the backup channel, no Paxsenix call needed.
  if (videoId) {
    const cached = await cacheGet(env, "tiktok_cache", videoId);
    if (cached && cached.length && env.LOG_CHANNEL) {
      for (const logMsgId of cached) {
        await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: env.LOG_CHANNEL, message_id: logMsgId })
          .catch(() => {});
      }
      return;
    }
  }

  const statusMsg = await tg(env, "sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: `🎵 <b>Downloading...</b>\n<code>${esc(host)}</code>`,
  });
  const statusMsgId = statusMsg?.result?.message_id;
  const deleteStatus = () => statusMsgId
    ? tg(env, "deleteMessage", { chat_id: chatId, message_id: statusMsgId }).catch(() => {})
    : Promise.resolve();

  let data;
  try {
    data = await dlCallWithFallback("/dl/tiktok", canonicalUrl, keys);
  } catch (e) {
    await deleteStatus();
    await logError(env, userId, "tiktok", e.message);
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `❌ <b>Download failed</b>\n${esc(e.message)}` });
    return;
  }

  // Some Paxsenix endpoints are async and return { jobId, task_url } instead
  // of media directly. Give it a moment (a fresh job can't be ready instantly)
  // then check once. If still pending, hand the user a "check again" button
  // instead of blocking the request open.
  if (data?.ok && data?.task_url) {
    await new Promise(r => setTimeout(r, 4000));
    const key = keys[Math.floor(Date.now() / 1000) % keys.length];
    const td = await dlCheckTask(data.task_url, key);
    if (td && ["done", "completed", "success"].includes(td.status)) {
      data = td;
    } else if (td && ["failed", "error"].includes(td.status)) {
      await deleteStatus();
      await logError(env, userId, "tiktok", td.message || td.error || "Conversion failed upstream.");
      await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
        text: `❌ <b>Failed</b>\n${esc(td.message || td.error || "Conversion failed upstream.")}` });
      return;
    } else {
      await deleteStatus();
      await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
        text: `⏳ <b>Still converting.</b>\nSend the link again in a few seconds.` });
      return;
    }
  }

  if (!data || data.ok === false) {
    await deleteStatus();
    await logError(env, userId, "tiktok", data?.message || "No media found — link may be private or invalid.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `❌ <b>Download failed</b>\n${esc(data?.message || "No media found — link may be private or invalid.")}` });
    return;
  }

  const media = extractMedia(data);
  if (!media || !media.length) {
    await deleteStatus();
    await logError(env, userId, "tiktok", "No downloadable media found for that link.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: "❌ <b>No downloadable media found</b> for that link." });
    return;
  }

  const meta = extractMeta(data);
  const caption = buildCaption(meta);

  const videos = media.filter(m => m.type === "video");
  const photos = media.filter(m => m.type === "photo");
  const audios = media.filter(m => m.type === "audio");

  // Reflect what's actually about to be sent instead of just deleting the
  // status message and going quiet during the upload.
  const sendKind = videos.length ? "video" : audios.length ? "audio" : "photo";
  await tg(env, "editMessageText", { chat_id: chatId, message_id: statusMsgId, parse_mode: "HTML",
    text: sendingText(sendKind) }).catch(() => {});
  await tgChatAction(env, chatId, sendKind);

  // If a backup channel is configured, upload there first — this gives us
  // permanent Telegram file_ids/message_ids to cache and copyMessage from on
  // future requests, instead of re-hitting Paxsenix's API every time the
  // same video is requested again.
  const destChatId = env.LOG_CHANNEL || chatId;
  const logMsgIds = [];

  for (const v of videos) {
    const r = await sendMediaSmart(env, "video", destChatId, v.url,
      { caption, parse_mode: "HTML", supports_streaming: true });
    if (r?.ok) logMsgIds.push(r.result.message_id);
  }
  if (photos.length === 1) {
    const r = await sendMediaSmart(env, "photo", destChatId, photos[0].url, { caption, parse_mode: "HTML" }, photos[0].ext);
    if (r?.ok) logMsgIds.push(r.result.message_id);
  } else if (photos.length > 1) {
    const chunks = [];
    for (let i = 0; i < photos.length; i += 10) chunks.push(photos.slice(i, i + 10));
    for (let ci = 0; ci < chunks.length; ci++) {
      const isLast = ci === chunks.length - 1;
      const r = await tg(env, "sendMediaGroup", {
        chat_id: destChatId,
        media: chunks[ci].map((p, idx) => ({
          type: "photo", media: p.url,
          ...(isLast && idx === chunks[ci].length - 1 ? { caption, parse_mode: "HTML" } : {}),
        })),
      });
      if (r?.ok) {
        for (const m of r.result) logMsgIds.push(m.message_id);
      } else {
        // Group send failed (likely the same CDN-referer issue) — fall back
        // to sending each photo individually through the proxy path.
        for (let idx = 0; idx < chunks[ci].length; idx++) {
          const p = chunks[ci][idx];
          const isLastPhoto = isLast && idx === chunks[ci].length - 1;
          const pr = await sendMediaSmart(env, "photo", destChatId, p.url,
            isLastPhoto ? { caption, parse_mode: "HTML" } : {}, p.ext);
          if (pr?.ok) logMsgIds.push(pr.result.message_id);
        }
      }
    }
  }
  for (const a of audios) {
    const r = await sendMediaSmart(env, "audio", destChatId, a.url,
      { caption: a.isMusic ? "" : caption, parse_mode: "HTML" });
    if (r?.ok) logMsgIds.push(r.result.message_id);
  }


  if (env.LOG_CHANNEL) {
    // Deliver to the actual requester by copying from the backup channel —
    // cheap for Telegram (no re-fetch from the origin URL) and gives the
    // user the exact same message that's now cached.
    if (videoId) await cacheSet(env, "tiktok_cache", videoId, logMsgIds);
    for (const logMsgId of logMsgIds) {
      await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: env.LOG_CHANNEL, message_id: logMsgId })
        .catch(() => {});
    }
  }
  await deleteStatus();
  // If LOG_CHANNEL isn't set, destChatId was chatId directly above, so the
  // media has already reached the user — nothing further to do, and nothing
  // gets cached (no backup channel to copy from later).
}

// ── Core: Instagram download + send ─────────────────────────────────
// Covers reels, single/carousel posts, and stories — Paxsenix returns the
// same detail/downloadUrls shape for all three (stories just omit
// like_count/comment_count and their "title" isn't a real caption).
// Cached the same way as TikTok: uploaded to LOG_CHANNEL first, then copied
// to the requester, with a 30-day auto-expiry and /clearcache support.
async function handleInstagram(env, chatId, url, userId) {
  const keys = getKeyPool(env);
  if (!keys.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ No download keys configured — tell the owner." });
    return;
  }

  await ensureSchema(env);
  const postId = extractInstagramId(url);

  // Cache hit: resend from the backup channel, no Paxsenix call needed.
  if (postId) {
    const cached = await cacheGet(env, "instagram_cache", postId);
    if (cached && cached.length && env.LOG_CHANNEL) {
      for (const logMsgId of cached) {
        await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: env.LOG_CHANNEL, message_id: logMsgId })
          .catch(() => {});
      }
      return;
    }
  }

  const statusMsg = await tg(env, "sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: `📸 <b>Downloading...</b>\n<code>instagram.com</code>`,
  });
  const statusMsgId = statusMsg?.result?.message_id;
  const deleteStatus = () => statusMsgId
    ? tg(env, "deleteMessage", { chat_id: chatId, message_id: statusMsgId }).catch(() => {})
    : Promise.resolve();

  let data;
  try {
    data = await dlCallWithFallback(IG_ENDPOINT, url, keys);
  } catch (e) {
    await deleteStatus();
    await logError(env, userId, "instagram", e.message);
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `❌ <b>Download failed</b>\n${esc(e.message)}` });
    return;
  }

  if (!data || data.ok === false) {
    await deleteStatus();
    await logError(env, userId, "instagram", data?.message || "No media found — link may be private, expired, or invalid.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `❌ <b>Download failed</b>\n${esc(data?.message || "No media found — link may be private, expired, or invalid.")}` });
    return;
  }

  const media = extractMedia(data);
  if (!media || !media.length) {
    await deleteStatus();
    await logError(env, userId, "instagram", "No downloadable media found for that link.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: "❌ <b>No downloadable media found</b> for that link." });
    return;
  }

  const meta = extractMeta(data, "instagram");
  const caption = buildCaption(meta, "instagram");

  const videos = media.filter(m => m.type === "video");
  const photos = media.filter(m => m.type === "photo");

  const sendKind = videos.length ? "video" : "photo";
  await tg(env, "editMessageText", { chat_id: chatId, message_id: statusMsgId, parse_mode: "HTML",
    text: sendingText(sendKind) }).catch(() => {});
  await tgChatAction(env, chatId, sendKind);

  // Same backup-then-copy pattern as TikTok: upload to LOG_CHANNEL first (if
  // configured) so we get permanent message ids to cache and copy from next
  // time, instead of sending straight to the user with nothing saved.
  const destChatId = env.LOG_CHANNEL || chatId;
  const logMsgIds = [];

  for (const v of videos) {
    const r = await sendMediaSmart(env, "video", destChatId, v.url,
      { caption, parse_mode: "HTML", supports_streaming: true }, v.ext);
    if (r?.ok) logMsgIds.push(r.result.message_id);
  }

  if (photos.length === 1) {
    const r = await sendMediaSmart(env, "photo", destChatId, photos[0].url, { caption, parse_mode: "HTML" }, photos[0].ext);
    if (r?.ok) logMsgIds.push(r.result.message_id);
  } else if (photos.length > 1) {
    // Carousel post — chunk into groups of 10 (Telegram's sendMediaGroup limit).
    const chunks = [];
    for (let i = 0; i < photos.length; i += 10) chunks.push(photos.slice(i, i + 10));
    for (let ci = 0; ci < chunks.length; ci++) {
      const isLast = ci === chunks.length - 1;
      const r = await tg(env, "sendMediaGroup", {
        chat_id: destChatId,
        media: chunks[ci].map((p, idx) => ({
          type: "photo", media: p.url,
          ...(isLast && idx === chunks[ci].length - 1 ? { caption, parse_mode: "HTML" } : {}),
        })),
      });
      if (r?.ok) {
        for (const m of r.result) logMsgIds.push(m.message_id);
      } else {
        // Group send failed — fall back to sending each photo individually
        // through the proxy path, same as the TikTok carousel fallback.
        for (let idx = 0; idx < chunks[ci].length; idx++) {
          const p = chunks[ci][idx];
          const isLastPhoto = isLast && idx === chunks[ci].length - 1;
          const pr = await sendMediaSmart(env, "photo", destChatId, p.url,
            isLastPhoto ? { caption, parse_mode: "HTML" } : {}, p.ext);
          if (pr?.ok) logMsgIds.push(pr.result.message_id);
        }
      }
    }
  }

  if (env.LOG_CHANNEL) {
    if (postId) await cacheSet(env, "instagram_cache", postId, logMsgIds);
    for (const logMsgId of logMsgIds) {
      await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: env.LOG_CHANNEL, message_id: logMsgId })
        .catch(() => {});
    }
  }
  await deleteStatus();
  // If LOG_CHANNEL isn't set, destChatId was chatId directly above, so the
  // media has already reached the user — nothing further to do, and nothing
  // gets cached (no backup channel to copy from later).
}

// ── Core: Spotify download + send ───────────────────────────────────
// Single tracks/episodes only — Paxsenix doesn't support playlists or full
// albums, so both get rejected before ever touching the API. No metadata
// comes back from this endpoint at all, so it just gets sent as a bare
// music file with no caption/title/performer.
async function handleSpotify(env, chatId, url, userId) {
  const host = getHost(url) || "";
  // spotify.link short URLs don't contain /track/, /playlist/, etc. anywhere,
  // so both the playlist/album rejection below and cache-key extraction need
  // the resolved canonical URL to work at all.
  const canonicalUrl = await resolveSpotifyCanonical(url, host);

  if (/\/(playlist|album)\//i.test(canonicalUrl)) {
    await tg(env, "sendMessage", { chat_id: chatId,
      text: "❌ Can't download playlists or albums — only single tracks and episodes are supported." });
    return;
  }

  // Already logged from a previous request? Just copy that straight over —
  // no need to hit Paxsenix again for a track we already have saved.
  const trackId = extractSpotifyId(canonicalUrl);
  if (env.LOG_CHANNEL && trackId) {
    await ensureSchema(env);
    const cachedMsgId = await spotifyCacheGet(env, trackId);
    if (cachedMsgId) {
      const copied = await tg(env, "copyMessage",
        { chat_id: chatId, from_chat_id: env.LOG_CHANNEL, message_id: cachedMsgId });
      if (copied?.ok) return;
      // Copy failed (e.g. someone deleted it from the channel manually) —
      // fall through and re-download fresh below.
    }
  }

  const keys = getKeyPool(env);
  if (!keys.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ No download keys configured — tell the owner." });
    return;
  }

  const statusMsg = await tg(env, "sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: `🎧 <b>Downloading...</b>\n<code>spotify.com</code>\nThis one takes a bit longer, hang tight.`,
  });
  const statusMsgId = statusMsg?.result?.message_id;
  const deleteStatus = () => statusMsgId
    ? tg(env, "deleteMessage", { chat_id: chatId, message_id: statusMsgId }).catch(() => {})
    : Promise.resolve();

  // Fired off now so it resolves in parallel with the download attempts
  // below rather than adding its own wait afterward — it's just a plain page
  // fetch, not a full OAuth Web API round trip, so this costs ~nothing extra.
  const metaPromise = fetchSpotifyMeta(canonicalUrl);

  let data = null;
  let lastMessage = "Track not found — link may be invalid.";
  for (const serv of SPOTIFY_SERVERS) {
    try {
      const attempt = await dlCallWithFallback(SPOTIFY_ENDPOINT, canonicalUrl, keys, { serv });
      if (attempt?.ok && (attempt.directUrl || attempt.url)) { data = attempt; break; }
      if (attempt?.message) lastMessage = attempt.message;
    } catch (e) {
      lastMessage = e.message;
    }
  }

  if (!data) {
    await deleteStatus();
    await logError(env, userId, "spotify", lastMessage);
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `❌ <b>Download failed</b>\n${esc(lastMessage)}` });
    return;
  }

  const audioUrl = data.directUrl || data.url;
  if (!audioUrl) {
    await deleteStatus();
    await logError(env, userId, "spotify", "No downloadable audio found for that link.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: "❌ <b>No downloadable audio found</b> for that link." });
    return;
  }

  // No filename/metadata comes back from Paxsenix — pull the extension off
  // the URL itself (it's a tmpfiles.paxsenix.org link like ".../xyz.m4a") so
  // the upload uses the right mime type.
  let ext;
  try { ext = new URL(audioUrl).pathname.split(".").pop().toLowerCase(); } catch { /* leave undefined */ }

  const meta = await metaPromise; // almost certainly already resolved by now
  const extraParams = {};
  if (meta?.title) extraParams.title = meta.title;
  if (meta?.artist) extraParams.performer = meta.artist;
  if (meta?.duration) extraParams.duration = meta.duration;

  await tg(env, "editMessageText", { chat_id: chatId, message_id: statusMsgId, parse_mode: "HTML",
    text: sendingText("audio") }).catch(() => {});
  await tgChatAction(env, chatId, "audio");

  // Uploaded to LOG_CHANNEL first (when configured) rather than straight to
  // the user, same backup pattern as TikTok — Spotify swaps out the actual
  // audio file behind a track URL sometimes, so this keeps a permanent copy
  // of exactly what was downloaded. Registered in spotify_cache (separate
  // table from TikTok's, no purge logic anywhere) so the next request for
  // the same track just copies this instead of hitting Paxsenix again.
  const destChatId = env.LOG_CHANNEL || chatId;

  // Deliberately skip sendMediaSmart's "hand Telegram the raw URL" shortcut
  // here. tmpfiles.paxsenix.org serves these with a generic
  // application/octet-stream Content-Type, so when Telegram fetches the URL
  // itself it can't tell it's audio and drops it in as a plain document.
  // Downloading and re-uploading ourselves lets us set the mime type
  // explicitly (audio/mp4) so it shows up as an actual playable music message,
  // with proper title/artist/cover pulled from Spotify's own page.
  const uploaded = await tgUploadProxied(env, "audio", destChatId, audioUrl, extraParams, ext, meta?.image);
  await deleteStatus();
  if (!uploaded?.ok) {
    await logError(env, userId, "spotify", uploaded?.description || "Could not send the audio.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `❌ <b>Upload failed</b>\n${esc(uploaded?.description || "Could not send the audio.")}` });
    return;
  }

  if (destChatId === env.LOG_CHANNEL && trackId) {
    await spotifyCacheSet(env, trackId, uploaded.result.message_id);
  }

  // If it went to LOG_CHANNEL, forward a copy to the actual requester.
  if (destChatId !== chatId) {
    const copied = await tg(env, "copyMessage",
      { chat_id: chatId, from_chat_id: destChatId, message_id: uploaded.result.message_id });
    if (!copied?.ok) {
      await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
        text: "❌ <b>Saved but couldn't deliver it to you</b> — check bot permissions in the log channel." });
    }
  }
}

// ── Core: YouTube ──────────────────────────────────────────────────
// Unlike TikTok/Instagram/Spotify, YouTube needs a format/quality choice
// before anything can download — so this doesn't auto-download on link
// paste. It shows a button picker instead. Both endpoints are async
// (job id + task_url to poll), same "one instant check per tap, no sleep
// loops" pattern established for TikTok's earlier iteration.

function buildYoutubeKeyboard(videoId) {
  return {
    inline_keyboard: [
      [{ text: "🎵 Audio (MP3)", callback_data: `ytf:${YT_AUDIO_FORMAT}:${videoId}` }],
      YT_VIDEO_QUALITIES.slice(0, 3).map(q => ({ text: `📹 ${q}p`, callback_data: `ytf:${q}:${videoId}` })),
      YT_VIDEO_QUALITIES.slice(3).map(q => ({ text: `📹 ${q}p`, callback_data: `ytf:${q}:${videoId}` })),
    ],
  };
}

async function handleYoutubePrompt(env, chatId, url) {
  const videoId = extractYoutubeId(url);
  if (!videoId) {
    await tg(env, "sendMessage", { chat_id: chatId,
      text: "❌ Couldn't find a video in that link — playlists/channels aren't supported, just single videos." });
    return;
  }
  await tg(env, "sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: "🎬 <b>Pick a format:</b>",
    reply_markup: buildYoutubeKeyboard(videoId),
  });
}

function ytStatusKeyboard(jobId, checks) {
  const btns = [[{ text: "🔄 Check again", callback_data: `ytc:${jobId}` }]];
  if (checks >= 8) btns.push([{ text: "♻️ Restart job", callback_data: `ytx:${jobId}` }]);
  return { inline_keyboard: btns };
}

function ytStatusText(checks) {
  if (checks >= 8) return "⚠️ <b>Taking unusually long.</b>\nMight be stuck — you can keep checking, or restart the job.";
  if (checks >= 4) return "⏳ <b>Taking a bit longer than usual.</b>\nBe patient, tap to check again.";
  return "⏳ <b>Still processing...</b>\nTap to check again in a few seconds.";
}

// Creates a fresh Paxsenix job for <videoId> at <format>, using one specific
// key (not the fallback rotator) so that exact key can be saved and reused
// for every subsequent poll of the same job.
async function ytCreateJob(env, videoId, format) {
  const keys = getKeyPool(env);
  if (!keys.length) return { ok: false, message: "No download keys configured — tell the owner." };

  const isAudio = format === YT_AUDIO_FORMAT;
  const endpoint = isAudio ? YT_AUDIO_ENDPOINT : YT_VIDEO_ENDPOINT;
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const key = keys[Math.floor(Date.now() / 1000) % keys.length];
  const extraParams = isAudio ? { format } : { quality: format };

  let resp;
  try {
    resp = await dlCall(endpoint, canonicalUrl, key, extraParams);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  if (!resp?.ok || !resp?.task_url) {
    const opts = resp?.formats || resp?.qualities;
    return { ok: false, message: resp?.message || (opts ? `Not available. Options: ${opts.join(", ")}` : "Could not start job.") };
  }
  return { ok: true, jobId: resp.jobId, taskUrl: resp.task_url, key };
}

// Delivers a finished job's media (backup-then-copy, same pattern as
// TikTok/Instagram) and caches it under "<videoId>:<format>". Metadata is
// kept minimal, same spirit as Spotify's: title + thumbnail cover — that's
// all Paxsenix's task response actually provides for YouTube (no
// channel/artist field), so there's no "performer" to set.
async function ytDeliverResult(env, chatId, msgId, videoId, format, taskData, userId) {
  const dlUrl = taskData?.url;
  if (!dlUrl) {
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: msgId }).catch(() => {});
    await logError(env, userId, "youtube", "Task finished but returned no download URL.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: "❌ <b>Download failed</b>\nTask finished but returned no file — try again." });
    return;
  }

  const isAudio = format === YT_AUDIO_FORMAT;
  const title = taskData.info?.title || "";
  const image = taskData.info?.image || "";
  const destChatId = env.LOG_CHANNEL || chatId;

  const sendKind = isAudio ? "audio" : "video";
  await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
    text: sendingText(sendKind) }).catch(() => {});
  await tgChatAction(env, chatId, sendKind);

  // TEST PATH: hand off to the SnapDeploy relay if configured. It streams
  // the file instead of buffering it, owns the status-message cleanup and
  // success/failure messaging from here, and reports back nothing further —
  // this Worker invocation is done once the hand-off is accepted.
  // Scoped to going straight to the requester's chat (skips the
  // LOG_CHANNEL backup-then-copy dance and youtube_cache write that the
  // Worker-side path below does) — fine for validating the relay itself,
  // worth closing before this replaces the real path.
  const relayExtraParams = isAudio
    ? (title ? { title } : {})
    : { caption: title ? `🎬 <b>${esc(title)}</b>` : "", parse_mode: "HTML", supports_streaming: true };
  const relayHandled = await deliverViaRelay(env, {
    field: sendKind, chatId, statusMsgId: msgId, dlUrl,
    extraParams: relayExtraParams,
    extOverride: isAudio ? YT_AUDIO_FORMAT : "mp4",
    thumbUrl: image,
  });
  if (relayHandled) return;

  let uploaded;
  if (isAudio) {
    // Same reasoning as Spotify: Paxsenix's proxy URL doesn't reliably report
    // a real audio Content-Type, so skip the "hand Telegram the raw URL"
    // shortcut and go straight to fetch-then-upload so the mime type and
    // ID3-style title/thumbnail can be set explicitly.
    const extraParams = {};
    if (title) extraParams.title = title;
    uploaded = await tgUploadProxied(env, "audio", destChatId, dlUrl, extraParams, YT_AUDIO_FORMAT, image);
  } else {
    // Unlike audio, video doesn't have Paxsenix's generic-Content-Type
    // problem in the same way — Telegram's own fetcher can often sniff an
    // mp4 container directly, so try handing it the raw dlUrl first (same
    // "cheap path first" pattern already used for TikTok/Instagram). Falls
    // back to tgUploadProxied automatically if Telegram can't fetch it
    // itself, so this is a strict improvement: same result on failure,
    // skips the Worker's own download+reupload (and its timeout risk)
    // entirely on success.
    const caption = title ? `🎬 <b>${esc(title)}</b>` : "";
    uploaded = await sendMediaSmart(env, "video", destChatId, dlUrl,
      { caption, parse_mode: "HTML", supports_streaming: true }, "mp4");
  }

  await tg(env, "deleteMessage", { chat_id: chatId, message_id: msgId }).catch(() => {});

  if (!uploaded?.ok) {
    await logError(env, userId, "youtube", uploaded?.description || "Could not send the file.");
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `❌ <b>Upload failed</b>\n${esc(uploaded?.description || "Could not send the file.")}` });
    return;
  }

  if (env.LOG_CHANNEL) {
    await cacheSet(env, "youtube_cache", `${videoId}:${format}`, [uploaded.result.message_id]);
    if (destChatId !== chatId) {
      const copied = await tg(env, "copyMessage",
        { chat_id: chatId, from_chat_id: destChatId, message_id: uploaded.result.message_id });
      if (!copied?.ok) {
        await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
          text: "❌ <b>Saved but couldn't deliver it to you</b> — check bot permissions in the log channel." });
      }
    }
  }
}


// Routes the three YouTube callback actions: ytf: (format picked on a fresh
// link), ytc: (check an existing job), ytx: (restart a stuck job).
async function handleYoutubeCallback(env, cq) {
  const [prefix, a, b] = cq.data.split(":");
  const userId = cq.from?.id;
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (prefix === "ytf") {
    const [, format, videoId] = cq.data.split(":");
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

    const limitCheck = await checkDailyLimit(env, userId);
    if (!limitCheck.allowed) {
      await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text: `⏳ <b>Daily limit reached</b> (${limitCheck.limit}/day).\nResets at midnight UTC.` }).catch(() => {});
      return;
    }

    // Cache hit — resend from the backup channel, no job needed at all.
    const cached = await cacheGet(env, "youtube_cache", `${videoId}:${format}`);
    if (cached && cached.length && env.LOG_CHANNEL) {
      for (const logMsgId of cached) {
        await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: env.LOG_CHANNEL, message_id: logMsgId }).catch(() => {});
      }
      return;
    }

    const label = format === YT_AUDIO_FORMAT ? "🎵 Audio (MP3)" : `📹 ${format}p`;
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
      text: `⏳ <b>Processing ${label}...</b>` }).catch(() => {});

    // Duration scrape runs alongside job creation instead of after it, so
    // getting an ETA doesn't add any extra latency before the job starts.
    const [job, durationSec] = await Promise.all([
      ytCreateJob(env, videoId, format),
      getYoutubeDuration(videoId),
    ]);
    if (!job.ok) {
      await logError(env, userId, "youtube", job.message);
      await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text: `❌ <b>Failed</b>\n${esc(job.message)}` }).catch(() => {});
      return;
    }

    await ensureSchema(env);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO yt_jobs(job_id, chat_id, msg_id, user_id, video_id, format, task_url, api_key, checks, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(job.jobId, chatId, msgId, userId || null, videoId, format, job.taskUrl, job.key, Date.now()).run().catch(() => {});

    const estimateSec = estimateYtSeconds(durationSec, format);
    if (estimateSec) {
      await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text: `⏳ <b>Processing ${label}...</b>\n⏱ Estimated: ~${formatEta(estimateSec)}` }).catch(() => {});
    }

    // Checks every 7s up to the estimate, then twice as often (half the
    // interval) once it's actually due — see autoPollJob.
    await autoPollJob(env, job, videoId, format, chatId, msgId, userId, estimateSec);
    return;
  }

  if (prefix === "ytc" || prefix === "ytx") {
    const jobId = a;
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT * FROM yt_jobs WHERE job_id = ?").bind(jobId).first().catch(() => null);
    if (!row) {
      await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text: "⚠️ This job expired — send the link again." }).catch(() => {});
      return;
    }

    if (prefix === "ytx") {
      // Stuck-job escape hatch: throw away the old job and start clean.
      await env.DB.prepare("DELETE FROM yt_jobs WHERE job_id = ?").bind(jobId).run().catch(() => {});
      const label = row.format === YT_AUDIO_FORMAT ? "🎵 Audio (MP3)" : `📹 ${row.format}p`;
      await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text: `⏳ <b>Restarting ${label}...</b>` }).catch(() => {});
      const [job, durationSec] = await Promise.all([
        ytCreateJob(env, row.video_id, row.format),
        getYoutubeDuration(row.video_id),
      ]);
      if (!job.ok) {
        await logError(env, row.user_id, "youtube", job.message);
        await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          text: `❌ <b>Failed</b>\n${esc(job.message)}` }).catch(() => {});
        return;
      }
      await env.DB.prepare(
        `INSERT INTO yt_jobs(job_id, chat_id, msg_id, user_id, video_id, format, task_url, api_key, checks, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      ).bind(job.jobId, chatId, msgId, row.user_id, row.video_id, row.format, job.taskUrl, job.key, Date.now()).run().catch(() => {});

      const estimateSec = estimateYtSeconds(durationSec, row.format);
      if (estimateSec) {
        await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          text: `⏳ <b>Restarting ${label}...</b>\n⏱ Estimated: ~${formatEta(estimateSec)}` }).catch(() => {});
      }

      await autoPollJob(env, job, row.video_id, row.format, chatId, msgId, row.user_id, estimateSec);
      return;
    }

    // ytc: "Check again" — shows immediate feedback, then does 2 quick
    // re-checks 4s apart (8s total) instead of just one instant check, so a
    // tap is more likely to actually catch the job finishing.
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
      text: "🔄 <b>Checking...</b>" }).catch(() => {});
    const taskData = await pollTaskWithRetries(row.task_url, row.api_key, 2, 4000);
    await resolveJobResult(env, jobId, chatId, msgId, row.video_id, row.format, row.checks, row.user_id, taskData);
  }
}

// Checks a task up to `attempts` times, waiting `intervalMs` before each
// attempt, stopping early the moment it's done/failed. Used by "Check
// again" so one tap covers a bit more ground than a single instant check.
async function pollTaskWithRetries(taskUrl, key, attempts, intervalMs) {
  let taskData = null;
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    taskData = await dlCheckTask(taskUrl, key);
    if (taskData && ["done", "completed", "success", "failed", "error"].includes(taskData.status)) return taskData;
  }
  return taskData;
}

// Automatically watches a freshly created job instead of waiting for a
// manual "Check again" tap: checks every YT_POLL_INTERVAL_MS (7s) until
// the estimated ready time, then — since that's exactly when the job is
// actually likely to land — switches to checking twice as often (half
// the original interval). A generous hard cap stops the loop from running
// forever if the estimate was way off; past that it falls back to the
// existing manual "Check again" flow, same as before this feature existed.
async function autoPollJob(env, job, videoId, format, chatId, msgId, userId, estimateSec) {
  const start = Date.now();
  const estimateMs = (estimateSec || 20) * 1000;
  // Cloudflare Workers can't hold a single invocation (even inside
  // waitUntil) open indefinitely — the Free plan kills it well before a
  // minute — and whatever's left over after this loop still has to cover
  // the actual download-then-upload step (which now has its own 25s hard
  // timeout, see tgUploadProxied). Keep this short so delivery always has
  // real headroom; anything not ready in time correctly falls back to the
  // manual "Check again" button, which gets a fresh invocation (and fresh
  // time budget) on every tap.
  const hardCapMs = 12000;
  let interval = YT_POLL_INTERVAL_MS;
  let halved = false;
  let checks = 0;

  while (Date.now() - start < hardCapMs) {
    await new Promise(r => setTimeout(r, interval));
    checks++;
    const taskData = await dlCheckTask(job.taskUrl, job.key);
    if (taskData && ["done", "completed", "success", "failed", "error"].includes(taskData.status)) {
      await resolveJobResult(env, job.jobId, chatId, msgId, videoId, format, checks, userId, taskData);
      return;
    }
    if (!halved && Date.now() - start >= estimateMs) {
      halved = true;
      interval = Math.max(2000, Math.round(YT_POLL_INTERVAL_MS / 2));
    }
  }
  // Ran out of safe budget for this invocation — hand off to the normal
  // "Check again" UI so the user can keep going with fresh invocations.
  await resolveJobResult(env, job.jobId, chatId, msgId, videoId, format, checks, userId, null);
}

// Shared by the initial job check, a restart, and every "Check again" tap —
// takes an already-fetched task result and either delivers it, reports a
// hard failure, or shows the staged "still processing" message.
async function resolveJobResult(env, jobId, chatId, msgId, videoId, format, checks, userId, taskData) {
  if (taskData && ["done", "completed", "success"].includes(taskData.status)) {
    await env.DB.prepare("DELETE FROM yt_jobs WHERE job_id = ?").bind(jobId).run().catch(() => {});
    await ytDeliverResult(env, chatId, msgId, videoId, format, taskData, userId);
    return;
  }
  if (taskData && ["failed", "error"].includes(taskData.status)) {
    await env.DB.prepare("DELETE FROM yt_jobs WHERE job_id = ?").bind(jobId).run().catch(() => {});
    await logError(env, userId, "youtube", taskData.message || taskData.error || "Conversion failed upstream.");
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
      text: `❌ <b>Failed</b>\n${esc(taskData.message || taskData.error || "Conversion failed upstream.")}` }).catch(() => {});
    return;
  }

  // Still pending (or the check itself failed/timed out) — bump the counter
  // and show staged messaging, same job, no progress lost.
  const newChecks = checks + 1;
  await env.DB.prepare("UPDATE yt_jobs SET checks = ? WHERE job_id = ?").bind(newChecks, jobId).run().catch(() => {});
  await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
    text: ytStatusText(newChecks), reply_markup: ytStatusKeyboard(jobId, newChecks) }).catch(() => {});
}

// ── Update routing ────────────────────────────────────────────────────
function buildWelcomeMessage(name) {
  return [
    `👋 <b>Hey${name ? " " + esc(name) : ""}!</b>`,
    `I'm <b>Styr1x Bot</b> — send me a link and I'll grab the media for you, no watermarks, no ads.`,
    ``,
    `<b>Supported right now:</b>`,
    `🎵 TikTok — videos, photo slideshows, and the background music`,
    `📸 Instagram — reels, posts, carousels, and stories`,
    `🎧 Spotify — single tracks and episodes <i>(no playlists/albums)</i>`,
    `📺 YouTube — video (pick a quality) or audio-only <i>(no playlists)</i>`,
    ``,
    `Just paste a link — that's it, no commands needed.`,
  ].join("\n");
}

// ── Admin panel ────────────────────────────────────────────────────
function isOwner(userId, env) {
  return env.OWNER_ID && String(userId) === String(env.OWNER_ID);
}

async function buildAdminOverview(env) {
  await ensureSchema(env);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const totals = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(request_count),0) AS reqs FROM bot_users"
  ).first().catch(() => ({ n: 0, reqs: 0 }));
  const activeToday = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bot_users WHERE last_seen >= ?"
  ).bind(now - day).first().catch(() => ({ n: 0 }));
  const activeWeek = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bot_users WHERE last_seen >= ?"
  ).bind(now - 7 * day).first().catch(() => ({ n: 0 }));
  const errors24h = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM error_log WHERE created_at >= ?"
  ).bind(now - day).first().catch(() => ({ n: 0 }));
  const errors7d = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM error_log WHERE created_at >= ?"
  ).bind(now - 7 * day).first().catch(() => ({ n: 0 }));
  const hitLimitToday = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM daily_usage WHERE date = ? AND count > ?"
  ).bind(todayUTC(), getDailyLimit(env)).first().catch(() => ({ n: 0 }));
  const unlimitedCount = (await listUnlimitedUsers(env)).length;

  return [
    `📊 <b>Admin Overview</b>`,
    ``,
    `👥 Users: <b>${totals?.n ?? 0}</b> total (${activeToday?.n ?? 0} today, ${activeWeek?.n ?? 0} this week)`,
    `📥 Requests handled: <b>${totals?.reqs ?? 0}</b>`,
    `❌ Errors: <b>${errors24h?.n ?? 0}</b> today, <b>${errors7d?.n ?? 0}</b> this week`,
    `⏳ Daily limit: <b>${getDailyLimit(env)}</b>/day · ${unlimitedCount} unlimited user(s) · ${hitLimitToday?.n ?? 0} hit the limit today`,
  ].join("\n");
}

async function buildAdminErrors(env, limit = 10) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    "SELECT user_id, platform, message, created_at FROM error_log ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all().catch(() => ({ results: [] }));

  if (!results || !results.length) return `✅ <b>No errors logged.</b>`;

  const lines = [`❌ <b>Last ${results.length} error(s):</b>`, ``];
  for (const r of results) {
    const when = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16);
    lines.push(`<b>${esc(r.platform || "?")}</b> · <code>${when}</code> · user <code>${esc(r.user_id ?? "?")}</code>`);
    lines.push(`<i>${esc((r.message || "").slice(0, 200))}</i>`);
    lines.push(``);
  }
  return lines.join("\n").trim();
}

async function buildAdminUsers(env, limit = 10) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    "SELECT user_id, username, first_name, last_seen, request_count FROM bot_users ORDER BY last_seen DESC LIMIT ?"
  ).bind(limit).all().catch(() => ({ results: [] }));

  if (!results || !results.length) return `👥 <b>No users tracked yet.</b>`;

  const lines = [`👥 <b>Most recently active (${results.length}):</b>`, ``];
  for (const u of results) {
    const name = u.username ? `@${esc(u.username)}` : esc(u.first_name || "unknown");
    const when = new Date(u.last_seen).toISOString().replace("T", " ").slice(0, 16);
    lines.push(`${name} · <code>${u.user_id}</code> · ${u.request_count} req · last seen <code>${when}</code>`);
  }
  return lines.join("\n");
}

const ADMIN_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔄 Refresh", callback_data: "admin:overview" }],
    [{ text: "❌ Recent Errors", callback_data: "admin:errors" }, { text: "👥 Users", callback_data: "admin:users" }],
  ],
};
const ADMIN_BACK_KEYBOARD = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin:overview" }]] };

async function handleAdminCallback(env, cq) {
  if (!isOwner(cq.from?.id, env)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Not authorized." });
    return;
  }
  const view = cq.data.split(":")[1];
  let text, keyboard;
  try {
    if (view === "errors") { text = await buildAdminErrors(env); keyboard = ADMIN_BACK_KEYBOARD; }
    else if (view === "users") { text = await buildAdminUsers(env); keyboard = ADMIN_BACK_KEYBOARD; }
    else { text = await buildAdminOverview(env); keyboard = ADMIN_KEYBOARD; }
  } catch (e) {
    text = `❌ Admin panel error: ${esc(e.message)}`;
    keyboard = ADMIN_BACK_KEYBOARD;
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  await tg(env, "editMessageText", {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    parse_mode: "HTML", text, reply_markup: keyboard,
  }).catch(() => {});
}

// Sends a message to every user who has ever messaged the bot (bot_users
// table). Two modes:
//   /broadcast <text>            — sends the text (HTML) to everyone
//   reply to a message + /broadcast  — copies that message (photo, video,
//                                       poll, etc.) to everyone as-is, with
//                                       any text after the command used as
//                                       an extra caption
// Throttled to ~25 sends/sec to stay under Telegram's rate limits, with
// automatic backoff on 429s. Users who blocked the bot / deleted their
// account just fail that one send — the run keeps going.
async function handleBroadcast(env, ownerChatId, text, replyMsg) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT user_id FROM bot_users").all();
  const ids = (results || []).map((r) => r.user_id);

  if (!ids.length) {
    await tg(env, "sendMessage", { chat_id: ownerChatId, text: "No users to broadcast to yet." });
    return;
  }

  const status = await tg(env, "sendMessage", {
    chat_id: ownerChatId, parse_mode: "HTML",
    text: `📣 Broadcasting to <b>${ids.length}</b> user(s)...`,
  });
  const statusMsgId = status?.result?.message_id;

  let sent = 0, failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const uid = ids[i];
    try {
      const res = replyMsg
        ? await tg(env, "copyMessage", {
            chat_id: uid,
            from_chat_id: replyMsg.chat.id,
            message_id: replyMsg.message_id,
            ...(text ? { caption: text, parse_mode: "HTML" } : {}),
          })
        : await tg(env, "sendMessage", {
            chat_id: uid, parse_mode: "HTML", text,
            link_preview_options: { is_disabled: true },
          });

      if (res?.ok) {
        sent++;
      } else {
        failed++;
        if (res?.parameters?.retry_after) {
          await new Promise((r) => setTimeout(r, (res.parameters.retry_after + 1) * 1000));
        }
      }
    } catch {
      failed++;
    }

    await new Promise((r) => setTimeout(r, 40)); // ~25/sec, under Telegram's cap

    if (statusMsgId && (i + 1) % 200 === 0) {
      await tg(env, "editMessageText", {
        chat_id: ownerChatId, message_id: statusMsgId, parse_mode: "HTML",
        text: `📣 Broadcasting... ${i + 1}/${ids.length} (✅ ${sent} ❌ ${failed})`,
      }).catch(() => {});
    }
  }

  const summary = `📣 <b>Broadcast complete</b>\n✅ Delivered: ${sent}\n❌ Failed: ${failed}\n👥 Total: ${ids.length}`;
  if (statusMsgId) {
    await tg(env, "editMessageText", { chat_id: ownerChatId, message_id: statusMsgId, parse_mode: "HTML", text: summary }).catch(() => {});
  } else {
    await tg(env, "sendMessage", { chat_id: ownerChatId, parse_mode: "HTML", text: summary }).catch(() => {});
  }
}

async function handleUpdate(update, env) {
  if (update.callback_query?.data?.startsWith("admin:")) {
    return handleAdminCallback(env, update.callback_query);
  }
  if (/^yt[fcx]:/.test(update.callback_query?.data || "")) {
    return handleYoutubeCallback(env, update.callback_query);
  }

  const msg = update.message;
  if (!msg || !msg.text) return;

  await logUser(env, msg.from);

  if (msg.text.startsWith("/start")) {
    await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
      text: buildWelcomeMessage(msg.from?.first_name), link_preview_options: { is_disabled: true } });
    return;
  }

  if (msg.text.startsWith("/admin")) {
    if (!isOwner(msg.from?.id, env)) return; // silently ignore for non-owners
    try {
      const text = await buildAdminOverview(env);
      await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML", text, reply_markup: ADMIN_KEYBOARD });
    } catch (e) {
      await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
        text: `❌ <b>Admin panel error:</b> ${esc(e.message)}` }).catch(() => {});
    }
    return;
  }

  if (msg.text.startsWith("/clearcache")) {
    if (env.OWNER_ID && String(msg.chat.id) !== String(env.OWNER_ID)) return;
    const arg = msg.text.slice("/clearcache".length).trim();
    try { await handleClearCache(env, msg.chat.id, arg); }
    catch (e) {
      await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
        text: `❌ <b>Clearcache error:</b> ${esc(e.message)}` }).catch(() => {});
    }
    return;
  }

  if (msg.text.startsWith("/unlimited")) {
    if (!isOwner(msg.from?.id, env)) return; // silently ignore for non-owners
    const parts = msg.text.split(/\s+/).slice(1);
    const [sub, idArg] = parts;
    try {
      if (sub === "list" || !sub) {
        const ids = await listUnlimitedUsers(env);
        await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
          text: ids.length
            ? `♾️ <b>Unlimited users:</b>\n${ids.map(id => `<code>${id}</code>`).join("\n")}`
            : "♾️ No unlimited users set — only you (owner) bypass the daily limit.\n\nUsage: <code>/unlimited add &lt;user_id&gt;</code>" });
      } else if (sub === "add" && idArg) {
        await addUnlimitedUser(env, idArg);
        await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
          text: `✅ <code>${esc(idArg)}</code> now has unlimited access.` });
      } else if (sub === "remove" && idArg) {
        await removeUnlimitedUser(env, idArg);
        await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
          text: `🗑️ <code>${esc(idArg)}</code> is back on the daily limit.` });
      } else {
        await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
          text: "Usage:\n<code>/unlimited add &lt;user_id&gt;</code>\n<code>/unlimited remove &lt;user_id&gt;</code>\n<code>/unlimited list</code>" });
      }
    } catch (e) {
      await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
        text: `❌ <b>Error:</b> ${esc(e.message)}` }).catch(() => {});
    }
    return;
  }

  if (msg.text.startsWith("/broadcast")) {
    if (!isOwner(msg.from?.id, env)) return; // silently ignore for non-owners
    const text = msg.text.slice("/broadcast".length).trim();
    const replyMsg = msg.reply_to_message;
    if (!text && !replyMsg) {
      await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
        text: "Usage:\n<code>/broadcast &lt;message&gt;</code> — sends HTML-formatted text to every user\n\nOr reply to any message (photo, video, poll, etc.) with <code>/broadcast</code> to copy it to every user, optionally adding <code>/broadcast &lt;extra caption&gt;</code>." });
      return;
    }
    try { await handleBroadcast(env, msg.chat.id, text, replyMsg); }
    catch (e) {
      await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
        text: `❌ <b>Broadcast error:</b> ${esc(e.message)}` }).catch(() => {});
    }
    return;
  }

  const url = extractUrl(msg.text);
  if (!url) return;

  const host = getHost(url) || "";
  const isTikTok = TIKTOK_HOSTS.has(host);
  const isInstagram = !isTikTok && INSTAGRAM_HOSTS.has(host);
  const isSpotify = !isTikTok && !isInstagram && SPOTIFY_HOSTS.has(host);
  const isYoutube = !isTikTok && !isInstagram && !isSpotify && YT_HOSTS.has(host);
  if (!isTikTok && !isInstagram && !isSpotify && !isYoutube) return; // silently ignore unsupported platforms

  const userId = msg.from?.id;

  // YouTube needs a format/quality choice first, so it shows a button picker
  // instead of downloading immediately — the daily limit gets checked later,
  // at the actual button-tap step in handleYoutubeCallback, not here.
  if (isYoutube) {
    try { await handleYoutubePrompt(env, msg.chat.id, url); }
    catch (e) {
      await logError(env, userId, "youtube", `Unexpected: ${e.message}`);
      await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
        text: `❌ <b>Unexpected error:</b> ${esc(e.message)}` }).catch(() => {});
    }
    return;
  }

  const limitCheck = await checkDailyLimit(env, userId);
  if (!limitCheck.allowed) {
    await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
      text: `⏳ <b>Daily limit reached</b> (${limitCheck.limit}/day).\nResets at midnight UTC.` });
    return;
  }

  try {
    if (isTikTok) await handleTikTok(env, msg.chat.id, url, userId);
    else if (isInstagram) await handleInstagram(env, msg.chat.id, url, userId);
    else await handleSpotify(env, msg.chat.id, url, userId);
  } catch (e) {
    const platform = isTikTok ? "tiktok" : isInstagram ? "instagram" : "spotify";
    await logError(env, userId, platform, `Unexpected: ${e.message}`);
    await tg(env, "sendMessage", { chat_id: msg.chat.id, parse_mode: "HTML",
      text: `❌ <b>Unexpected error:</b> ${esc(e.message)}` }).catch(() => {});
  }
}

// ── Webhook (de)registration ─────────────────────────────────────────
async function registerWebhook(req, env) {
  const url = new URL(req.url);
  const webhookUrl = `${url.origin}/webhook/${env.BOT_SECRET}`;
  const r = await tg(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.BOT_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  return new Response(JSON.stringify(r, null, 2), { headers: { "Content-Type": "application/json" } });
}

// ── Entry point ────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/registerWebhook") return registerWebhook(request, env);
    if (url.pathname === "/unregisterWebhook")
      return new Response(JSON.stringify(await tg(env, "deleteWebhook", {})));

    if (url.pathname === `/webhook/${env.BOT_SECRET}`) {
      if (request.method !== "POST") return new Response("ok");
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (secret && secret !== env.BOT_SECRET) return new Response("unauthorized", { status: 401 });
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    return new Response("Styr1x Bot v7 🤖 — TikTok + Instagram + Spotify, more coming");
  },

  // Fires on the Cron Trigger you set up in the dashboard (Workers → this
  // worker → Triggers → Cron Triggers). Sweeps out any cached TikTok or
  // Instagram entry older than 30 days — D1 row + backup messages in
  // LOG_CHANNEL. Spotify's cache is permanent and untouched.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpiredCache(env));
  },
};
