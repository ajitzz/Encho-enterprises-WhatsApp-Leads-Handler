# Environment hardening checklist (Render + Cloudflare Worker)

This checklist is for a production WhatsApp webhook path where low latency and lead-capture durability matter.

## Cloudflare Worker variables/secrets

Required:
- `BACKEND_API_ORIGIN` — primary backend origin (Render API base URL, no trailing slash preferred).
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
- `PORT` (provided by Render runtime)
- `DATABASE_URL` (Neon pooled connection)
- `WHATSAPP_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`

Strongly recommended:
- `NODE_ENV=production`
- `WEBHOOK_SECRET` (if backend validates signatures itself)
- `LOG_LEVEL=info`

## No-lead-loss posture (recommended)

1. Configure **both** `BACKEND_API_ORIGIN` and `BACKEND_API_FALLBACK_ORIGIN`.
2. Keep `UPSTREAM_TIMEOUT_MS` bounded (`8000`–`12000`) to avoid long edge stalls.
3. Ensure backend stores inbound webhook payload quickly before heavy processing.
4. Use QStash/queue path for async processing and retries.
5. Alert on 5xx/504 spikes in Cloudflare + Render.

## Quick validation

1. Trigger webhook test to `/webhook` and verify non-5xx edge status.
2. Disable primary backend briefly and verify fallback origin handles traffic.
3. Re-enable primary backend and verify traffic recovery.
