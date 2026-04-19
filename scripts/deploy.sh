#!/usr/bin/env bash
# scripts/deploy.sh — build + deploy the Flora Worker via Cloudflare API
#
# Requires environment variables (sourced from .env if present):
#   CLOUDFLARE_API_TOKEN  — token with Workers Scripts:Edit + Zone DNS:Edit
#   CLOUDFLARE_ACCOUNT_ID — Cloudflare account ID
#   ANTHROPIC_API_KEY     — set as a Worker secret
#
# Optional:
#   FLORA_WORKER_NAME  (default: flora)
#   FLORA_HOSTNAME     (default: flora.clydeford.net)
#   FLORA_ZONE_NAME    (default: clydeford.net)

set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env if present (without exporting secrets globally)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY not set}"

WORKER_NAME="${FLORA_WORKER_NAME:-flora}"
HOSTNAME="${FLORA_HOSTNAME:-flora.clydeford.net}"
ZONE_NAME="${FLORA_ZONE_NAME:-clydeford.net}"
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

say() { printf '\033[0;36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── 1. BUILD ────────────────────────────────────────────────────────
say "Building bundle"
bash scripts/build.sh
[[ -f build/worker.js ]] || die "build/worker.js not produced"

# ─── 2. RESOLVE ZONE ID ──────────────────────────────────────────────
say "Resolving zone ID for ${ZONE_NAME}"
ZONE_ID=$(curl -s "${AUTH[@]}" "${API}/zones?name=${ZONE_NAME}" |
  grep -oE '"id":"[a-f0-9]{32}"' | head -1 | cut -d'"' -f4)
[[ -n "${ZONE_ID}" ]] || die "Could not resolve zone ID for ${ZONE_NAME}"
ok "Zone ID: ${ZONE_ID}"

# ─── 3. UPLOAD WORKER SCRIPT ─────────────────────────────────────────
say "Uploading Worker: ${WORKER_NAME}"
METADATA=$(cat <<EOF
{
  "main_module": "worker.js",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "keep_bindings": ["secret_text"]
}
EOF
)

UPLOAD_RESP=$(curl -s -X PUT "${AUTH[@]}" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}" \
  -F "metadata=${METADATA};type=application/json" \
  -F "worker.js=@build/worker.js;type=application/javascript+module")

echo "${UPLOAD_RESP}" | grep -qE '"success":\s*true' || {
  echo "${UPLOAD_RESP}" >&2
  die "Worker upload failed"
}
ok "Worker uploaded"

# ─── 4. SET SECRET ───────────────────────────────────────────────────
# The Anthropic API key uses safe characters (alnum + `-_`), so inline JSON is fine.
# Verify before sending, so a bad key doesn't silently ship.
if [[ ! "${ANTHROPIC_API_KEY}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  die "ANTHROPIC_API_KEY contains unexpected characters — refusing to embed in JSON without escaping"
fi
say "Setting ANTHROPIC_API_KEY secret"
SECRET_BODY=$(printf '{"name":"ANTHROPIC_API_KEY","text":"%s","type":"secret_text"}' "${ANTHROPIC_API_KEY}")
SECRET_RESP=$(curl -s -X PUT "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets" \
  --data "${SECRET_BODY}")
echo "${SECRET_RESP}" | grep -qE '"success":\s*true' || {
  echo "${SECRET_RESP}" >&2
  die "Failed to set secret"
}
ok "Secret set"

# ─── 5. BIND CUSTOM DOMAIN ───────────────────────────────────────────
say "Binding custom domain ${HOSTNAME} (creates DNS + route)"
DOMAIN_BODY=$(cat <<EOF
{
  "zone_id": "${ZONE_ID}",
  "hostname": "${HOSTNAME}",
  "service": "${WORKER_NAME}",
  "environment": "production"
}
EOF
)
DOMAIN_RESP=$(curl -s -X PUT "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" \
  --data "${DOMAIN_BODY}")
if echo "${DOMAIN_RESP}" | grep -qE '"success":\s*true'; then
  ok "Custom domain bound"
elif echo "${DOMAIN_RESP}" | grep -q 'already exists'; then
  ok "Custom domain already bound"
else
  echo "${DOMAIN_RESP}" >&2
  die "Custom domain binding failed"
fi

# ─── 6. PURGE EDGE CACHE ─────────────────────────────────────────────
say "Purging zone cache"
PURGE_RESP=$(curl -s -X POST "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  "${API}/zones/${ZONE_ID}/purge_cache" \
  --data '{"purge_everything":true}')
if echo "${PURGE_RESP}" | grep -qE '"success":\s*true'; then
  ok "Cache purged"
else
  echo "${PURGE_RESP}" >&2
  echo "(non-fatal — new deploys may take up to a minute to propagate)" >&2
fi

echo ""
ok "Flora deployed → https://${HOSTNAME}"
