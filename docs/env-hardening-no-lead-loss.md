# Environment hardening checklist (Render + Cloudflare Worker)

This checklist is for a production WhatsApp webhook path where low latency and lead-capture durability matter.

## Cloudflare Worker variables/secrets

Required:
- `BACKEND_API_ORIGIN` — primary backend/API base URL (for example your Render backend `https://<service>.onrender.com`).
- `ALLOWED_ORIGINS` — comma-separated frontend origins (or `*` when appropriate).

Strongly recommended:
- `BACKEND_API_FALLBACK_ORIGIN` — secondary healthy origin used when primary times out/fails.
- `UPSTREAM_TIMEOUT_MS` — upstream fetch timeout in milliseconds. Recommended `8000` to `12000`.

If using Upstash/QStash pipeline:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`

## Render environment variables

Required:
- `PORT` (provided automatically by Render runtime; do not hardcode)
- `DATABASE_URL` (Neon pooled connection)
- `WHATSAPP_TOKEN`
- `VERIFY_TOKEN` (this project currently uses `VERIFY_TOKEN`; if backend code expects `WHATSAPP_VERIFY_TOKEN`, set both to same value)

Recommended:
- `NODE_ENV=production`
- `LOG_LEVEL=info`

Optional:
- `WEBHOOK_SECRET` (only if backend validates request signatures with this env key)

## What to use for `BACKEND_API_ORIGIN` and `BACKEND_API_FALLBACK_ORIGIN`

Use full HTTPS origins (scheme + host, no path):

- `BACKEND_API_ORIGIN=https://<primary-backend-domain>`
- `BACKEND_API_FALLBACK_ORIGIN=https://<secondary-backend-domain>`

Examples:
- Primary Render service + secondary Render service (different region/service)
- Primary Render service + secondary Railway/Fly service

If you only have one backend right now, set just `BACKEND_API_ORIGIN` first. Add fallback once second healthy deployment exists.

## No-lead-loss posture (recommended)

1. Configure primary + fallback origin when available.
2. Keep `UPSTREAM_TIMEOUT_MS` bounded (`8000`–`12000`) to avoid long edge stalls.
3. Ensure backend stores inbound webhook payload quickly before heavy processing.
4. Use QStash/queue path for async processing and retries.
5. Alert on 5xx/504 spikes in Cloudflare + Render.

## Quick validation

1. Trigger webhook test to `/webhook` and verify non-5xx edge status.
2. Disable primary backend briefly and verify fallback origin handles traffic.
3. Re-enable primary backend and verify traffic recovery.
