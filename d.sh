#!/data/data/com.termux/files/usr/bin/bash
# ══════════════════════════════════════════════════════════════════
#  deploy.sh — Termux deployer for the cdw bot Worker
#
#  Why this doesn't use wrangler:
#  wrangler's CLI hard-requires the "workerd" native binary at module
#  load time for every command (not just `wrangler dev`), and workerd
#  ships no Android/arm64 build ("Unsupported platform: android arm64").
#  There is no working npm-only fix for this on stock Termux. So instead
#  of fighting Node's platform detection, this script talks to
#  Cloudflare's plain REST API with curl — no native binaries involved,
#  works on any platform that has curl + jq.
#
#  (If you have a real Linux userland available — e.g. via
#  `proot-distro install ubuntu` — wrangler works fine in there, and
#  wrangler.toml in this repo is ready for that path too. This script
#  is for everyone else.)
# ══════════════════════════════════════════════════════════════════
#
# One-time setup:
#   1. Run once to get templates written: ./deploy.sh
#   2. cp cf.env.example .cf.env             and fill in your Cloudflare creds
#   3. cp secrets.env.example .secrets.env   and fill in your bot secrets
#   4. ./deploy.sh
#
# Flags:
#   --webhook   also register the Telegram webhook after deploying
#   --schema    force-(re)apply schema.sql to the D1 database (safe:
#               uses CREATE TABLE IF NOT EXISTS)
#
set -euo pipefail
cd "$(dirname "$0")"

WORKER_FILE="cdw.js"
CF_API="https://api.cloudflare.com/client/v4"
METADATA_FILE=".deploy_metadata.tmp.json"
trap 'rm -f "$METADATA_FILE"' EXIT

# ── 0. Dependencies ───────────────────────────────────────────────────
IS_TERMUX=false
[ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *"com.termux"* ]] && IS_TERMUX=true

need_pkg() {
  command -v "$1" >/dev/null 2>&1 && return 0
  echo "▶ Installing $1..."
  if [ "$IS_TERMUX" = true ]; then pkg install -y "$1"
  else echo "❌ Please install '$1' manually." >&2; exit 1; fi
}
need_pkg curl
need_pkg jq

# ── 1. Load Cloudflare account credentials ────────────────────────────
# Accepts either a .cf.env file OR already-exported env vars
# (export CLOUDFLARE_API_TOKEN=... / CLOUDFLARE_ACCOUNT_ID=...).
if [ ! -f .cf.env ]; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    echo "▶ No .cf.env yet — creating one from your exported env vars."
    cat > .cf.env <<EOF
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
WORKER_NAME=${WORKER_NAME:-cdw-bot}
D1_DATABASE_ID=
EOF
  else
    cat > cf.env.example <<'EOF'
# Cloudflare account credentials (deploy-time only — NOT sent to Telegram
# or bundled into the worker). Get a token at:
#   https://dash.cloudflare.com/profile/api-tokens
# -> "Create Token" -> Edit Cloudflare Workers template (needs Workers
#    Scripts:Edit, D1:Edit, Account Settings:Read)
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
WORKER_NAME=cdw-bot
# Leave blank the first run -- the script creates the D1 DB and fills
# this in automatically for you.
D1_DATABASE_ID=
EOF
    echo "❌ No .cf.env and no CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID exported."
    echo "   Either: cp cf.env.example .cf.env   and fill it in, then re-run"
    echo "   Or:     export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...   and re-run"
    exit 1
  fi
fi
set -a; source .cf.env; set +a
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN in .cf.env}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID in .cf.env}"
WORKER_NAME="${WORKER_NAME:-cdw-bot}"

AUTH_HDR="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

cf_get()      { curl -sS -X GET  "$CF_API$1" -H "$AUTH_HDR"; }
cf_post()     { curl -sS -X POST "$CF_API$1" -H "$AUTH_HDR" -H "Content-Type: application/json" -d "$2"; }
cf_put_json() { curl -sS -X PUT  "$CF_API$1" -H "$AUTH_HDR" -H "Content-Type: application/json" -d "$2"; }

check_ok() { # $1 = json response, $2 = human label
  if ! echo "$1" | jq -e '.success == true' >/dev/null 2>&1; then
    echo "❌ $2 failed:" >&2
    echo "$1" | jq . >&2 2>/dev/null || echo "$1" >&2
    exit 1
  fi
}

# ── 2. Ensure a D1 database exists ─────────────────────────────────────
if [ -z "${D1_DATABASE_ID:-}" ]; then
  echo "▶ No D1_DATABASE_ID set — creating a new D1 database..."
  RESP="$(cf_post "/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database" "$(jq -n --arg n "${WORKER_NAME}-db" '{name:$n}')")"
  check_ok "$RESP" "D1 database creation"
  D1_DATABASE_ID="$(echo "$RESP" | jq -r '.result.uuid')"
  echo "▶ Created D1 database: $D1_DATABASE_ID"
  if grep -q '^D1_DATABASE_ID=' .cf.env; then
    sed -i "s/^D1_DATABASE_ID=.*/D1_DATABASE_ID=$D1_DATABASE_ID/" .cf.env
  else
    echo "D1_DATABASE_ID=$D1_DATABASE_ID" >> .cf.env
  fi
fi

# ── 3. Apply schema (idempotent — CREATE TABLE IF NOT EXISTS) ─────────
if [[ "${1:-}" == "--schema" ]] || [ ! -f .schema_applied ]; then
  if [ ! -f schema.sql ]; then
    echo "❌ schema.sql not found next to deploy.sh. Re-download/copy it into this folder and re-run." >&2
    exit 1
  fi
  echo "▶ Applying schema.sql to D1..."
  STMT_COUNT=0
  while IFS= read -r stmt; do
    [ -z "$stmt" ] && continue
    STMT_COUNT=$((STMT_COUNT + 1))
    RESP="$(cf_post "/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$D1_DATABASE_ID/query" \
      "$(jq -n --arg sql "$stmt" '{sql:$sql}')")"
    check_ok "$RESP" "Schema statement ($stmt)"
  done < <(grep -v '^--' schema.sql | tr ';' '\n' | sed '/^[[:space:]]*$/d')
  if [ "$STMT_COUNT" -eq 0 ]; then
    echo "❌ schema.sql was found but no SQL statements were parsed from it." >&2
    exit 1
  fi
  touch .schema_applied
  echo "▶ Schema OK ($STMT_COUNT statements)."
fi

# ── 4. Load worker secrets (.secrets.env → KEY=VALUE bindings) ─────────
if [ ! -f .secrets.env ]; then
  cat > secrets.env.example <<'EOF'
# Worker runtime secrets -- these become env.KEY inside cdw.js.
BOT_TOKEN=
OWNER_IDS=
BOT_SECRET=
OWNER_USERNAME=
TIKTOK_URL=
YOUTUBE_URL=
LOG_CHANNEL=
FILES_CHANNEL=
PAXSENIX_KEY_1=
PAXSENIX_KEY_2=
PAXSENIX_KEY_3=
PAXSENIX_KEY_4=
PAXSENIX_KEY_5=
# Optional: only needed if you've deployed the SnapDeploy relay service
# (snapdeploy-yt-relay/) for streaming YouTube delivery. Leave blank to
# keep using the Worker's own tgUploadProxied/sendMediaSmart path.
SNAPDEPLOY_RELAY_URL=
SNAPDEPLOY_RELAY_SECRET=
EOF
  echo "❌ .secrets.env not found. A template was written to secrets.env.example."
  echo "   cp secrets.env.example .secrets.env   then fill it in and re-run."
  exit 1
fi

BINDINGS_JSON="$(jq -n '[]')"
while IFS='=' read -r key val; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [ -z "$val" ] && continue
  BINDINGS_JSON="$(echo "$BINDINGS_JSON" | jq --arg n "$key" --arg t "$val" \
    '. + [{"type":"secret_text","name":$n,"text":$t}]')"
done < .secrets.env

# D1 binding
BINDINGS_JSON="$(echo "$BINDINGS_JSON" | jq --arg id "$D1_DATABASE_ID" \
  '. + [{"type":"d1","name":"DB","id":$id}]')"

# ── 5. Build metadata & upload the worker (multipart module upload) ───
echo "▶ Deploying $WORKER_FILE as '$WORKER_NAME'..."
jq -n --argjson bindings "$BINDINGS_JSON" --arg main "$WORKER_FILE" '{
  main_module: $main,
  compatibility_date: "2026-07-01",
  bindings: $bindings,
  observability: { enabled: true },
  limits: { cpu_ms: 300000 }
}' > "$METADATA_FILE"

DEPLOY_RESP="$(curl -sS -X PUT \
  "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  -H "$AUTH_HDR" \
  -F "metadata=@$METADATA_FILE;type=application/json" \
  -F "$WORKER_FILE=@$WORKER_FILE;type=application/javascript+module")"

if ! echo "$DEPLOY_RESP" | jq -e '.success == true' >/dev/null 2>&1; then
  echo "⚠️  Deploy with cpu_ms limit failed — retrying without it"
  echo "   (raising limits.cpu_ms requires Workers Paid on some accounts):"
  echo "$DEPLOY_RESP" | jq . 2>/dev/null || echo "$DEPLOY_RESP"
  jq -n --argjson bindings "$BINDINGS_JSON" --arg main "$WORKER_FILE" '{
    main_module: $main, compatibility_date: "2026-07-01",
    bindings: $bindings, observability: { enabled: true }
  }' > "$METADATA_FILE"
  DEPLOY_RESP="$(curl -sS -X PUT \
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
    -H "$AUTH_HDR" \
    -F "metadata=@$METADATA_FILE;type=application/json" \
    -F "$WORKER_FILE=@$WORKER_FILE;type=application/javascript+module")"
  check_ok "$DEPLOY_RESP" "Worker deploy"
fi
echo "▶ Worker uploaded."

# ── 6. Cron trigger (D1 cleanup every 30 min) ──────────────────────────
echo "▶ Setting cron trigger..."
CRON_RESP="$(cf_put_json "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/schedules" \
  '[{"cron":"*/30 * * * *"}]')"
check_ok "$CRON_RESP" "Cron trigger"

# ── 7. Enable workers.dev subdomain & figure out the URL ───────────────
cf_post "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/subdomain" '{"enabled":true}' >/dev/null
SUBDOMAIN_RESP="$(cf_get "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain")"
SUBDOMAIN="$(echo "$SUBDOMAIN_RESP" | jq -r '.result.subdomain // empty')"
if [ -n "$SUBDOMAIN" ]; then
  WORKER_URL="https://$WORKER_NAME.$SUBDOMAIN.workers.dev"
  echo "▶ Worker URL: $WORKER_URL"
else
  echo "⚠️  Couldn't resolve your workers.dev subdomain automatically."
  echo "   Check it at: https://dash.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain"
  WORKER_URL=""
fi

# ── 8. Optionally register the Telegram webhook ────────────────────────
if [[ "${1:-}" == "--webhook" || "${2:-}" == "--webhook" ]] && [ -n "$WORKER_URL" ]; then
  echo "▶ Registering webhook..."
  curl -sS "$WORKER_URL/registerWebhook"
  echo
fi

echo "✅ Done."
