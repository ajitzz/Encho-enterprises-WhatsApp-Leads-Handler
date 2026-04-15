# Cloudflare Pages + Workers Migration Fix Guide (2026-04-15)

## What your screenshots show

### 1) `POST /api/auth/google` returns 405
- Browser error: `POST https://...workers.dev/api/auth/google 405 (Method Not Allowed)`.
- Cloudflare dashboard screenshot shows messages like:
  - "Variables cannot be added to a Worker that only has static assets"
  - "Triggers cannot be added to a Worker that only has static assets"
- This indicates the current deployment is **static-assets-only**, so `/api/*` is not backed by your Express API runtime.

**Root cause:** frontend is deployed, but backend API is not running on this domain.

---

### 2) `Cross-Origin-Opener-Policy policy would block the window.postMessage call`
- This warning appears during Google Identity popup flows.
- On strict COOP settings, popup communication (`window.postMessage`) can be restricted.

**Root cause:** COOP/COEP headers not aligned for Google popup auth.

---

### 3) `google.accounts.id.initialize() is called multiple times`
- Usually appears when Google Identity script is initialized more than once (rerender/retry/remount).
- In your current case, this is likely secondary to failed auth flow caused by API 405 / popup communication issues.

## Concrete fixes applied in this repo

1. **Frontend can now target external API origin via env**
   - Added `VITE_API_BASE_URL` support (falls back to same-origin when unset).
   - This allows Cloudflare-hosted frontend to call a separately-hosted API.

2. **Added static headers for Google popup compatibility**
   - Added `public/_headers` with:
     - `Cross-Origin-Opener-Policy: same-origin-allow-popups`
     - `Cross-Origin-Embedder-Policy: unsafe-none`

## Required deployment settings (Cloudflare)

### A) If using static frontend + separate Node API (recommended fast path)
1. Keep current static deploy for frontend.
2. Host Node/Express API on a Node-compatible runtime (not static assets mode).
3. Set frontend env var:
   - `VITE_API_BASE_URL=https://<your-api-domain>`
4. Ensure API CORS allows your Cloudflare frontend origin.
5. Rebuild/redeploy frontend.

### B) If using single Cloudflare domain for both frontend+API
- You need a real Worker/Pages Functions API implementation for `/api/*`.
- Static-assets-only configuration will continue returning 405 for non-file paths/methods.

## Validation checklist

1. `POST /api/auth/google` returns 200/401 JSON from API (not 405).
2. Response headers include:
   - `Cross-Origin-Opener-Policy: same-origin-allow-popups`
3. Google login completes and stores token.
4. `/api/auth/me` returns user profile.
5. Dashboard data endpoints (`/api/drivers`, `/api/bot/settings`) return JSON from API origin.

## Security reminder

Your screenshot appears to expose many secret values in plaintext in Cloudflare UI captures. Rotate all exposed credentials immediately:
- DB URLs/passwords
- Meta API tokens
- Google service account private key
- AWS keys
- Upstash tokens/signing keys
