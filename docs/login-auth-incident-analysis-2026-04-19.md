# Login Incident Analysis (Google Sign-In) — 2026-04-19

## Executive summary

Primary login failure is **backend capacity/quota exhaustion**, not a Google OAuth credential problem.

Observed chain:
1. Browser obtains Google credential.
2. Frontend calls `POST /api/auth/google`.
3. Backend returns a payload indicating upstream quota exhaustion (`data transfer quota`), and login fails.

## Evidence and micro-level trace

### 1) Frontend sends Google credential to backend
- `components/Login.tsx` calls `liveApiService.verifyLogin(credential)` after Google success callback.
- `services/liveApiService.ts` maps `verifyLogin` to `POST /api/auth/google`.

### 2) Backend auth path performs DB read/write during login
- `server.ts` `handleAuthGoogleLegacy` verifies Google ID token, then queries `staff_members` and may insert super-admin user record.
- This means auth depends on database network/data transfer availability.

### 3) Why error surfaced as 401 before this patch
- Previous catch block in `handleAuthGoogleLegacy` returned `401` for all exceptions, including infra/quota outages.
- That status code incorrectly implied invalid credentials instead of backend outage.

## Secondary console messages (noise vs blocker)

- `Cross-Origin-Opener-Policy ... would block postMessage`  
  Usually browser policy warning from GIS popup internals; not the root blocker for this case.

- `google.accounts.id.initialize() is called multiple times`  
  Indicates multiple GIS init cycles (often non-fatal). Should be cleaned up but does not explain this specific hard failure.

- `/favicon.ico 500`  
  Asset/config issue and unrelated to auth control path.

- `[Cloudflare API Hint] ... Set VITE_API_BASE_URL ...`  
  In this deployment, same-origin `/api/*` can be valid when Worker proxy is configured. Emitting this warning before every request was misleading.

## Changes made in this patch

1. **Auth error classification improvement**
   - Added quota-specific detection and response:
     - `503` + code `UPSTREAM_QUOTA_EXCEEDED`
   - Added recoverable infra degradation response:
     - `503` + code `AUTH_BACKEND_DEGRADED`
   - Keeps `401` only for genuine auth/token failures.

2. **Removed misleading pre-request Cloudflare warning**
   - Stop warning before request on workers.dev.
   - Keep warning logic for true failure signatures (e.g., 405 with same-origin `/api`).

## Resolution plan (ordered)

### P0 — Restore backend quota/capacity (required to unblock login)
1. Identify the exact upstream service producing the quota error (likely managed Postgres provider).
2. Increase data-transfer quota or temporarily scale plan.
3. Add provider-side alerting at 70% / 85% / 95% quota consumption.

### P1 — Improve operational observability
1. Add structured logging counter for:
   - `UPSTREAM_QUOTA_EXCEEDED`
   - `AUTH_BACKEND_DEGRADED`
2. Add dashboard panel: auth success rate + auth 5xx rate + DB connectivity errors.
3. Add on-call runbook: “auth outage triage in < 15 min”.

### P1 — UX hardening
1. Map known backend `code` values in UI to human-readable actions:
   - quota exceeded → “service temporarily unavailable; contact admin”.
2. Avoid showing raw JSON error blobs to end users.

### P2 — Reduce auth DB dependency blast radius
1. Cache authorized staff emails/roles for short TTL (e.g., 5–15 min) to survive transient DB instability.
2. Consider decoupling super-admin auto-registration from sign-in critical path.

### P2 — Policy and platform cleanup
1. Add/serve a stable `/favicon.ico` asset.
2. Review COOP/COEP headers only if popup/login UX issues persist.
3. Keep `VITE_API_BASE_URL` optional for Worker-proxy deployments; document deployment matrix.

## Validation checklist after quota fix

1. Login happy-path returns `200` with `success: true`.
2. Force simulated DB failure and confirm `503` with `AUTH_BACKEND_DEGRADED`.
3. Force simulated quota exception and confirm `503` with `UPSTREAM_QUOTA_EXCEEDED`.
4. Verify browser no longer prints misleading pre-request Cloudflare API hint.
