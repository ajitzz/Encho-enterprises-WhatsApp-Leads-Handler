# Cloudflare Backend Runbook (Section-by-Section)

This runbook explains exactly what to configure so your backend actually runs (and why `VITE_API_BASE_URL` currently fails).

---

## Section 0 — Confirm your current state (what is broken now)

In this repository, both Cloudflare config files are currently **static-assets-only**:

- `wrangler.toml` contains `assets.directory = "./dist"` and no `main` Worker entrypoint.
- `wrangler.jsonc` also contains only `assets` and no `main` Worker entrypoint.

That means Cloudflare treats your deployment as static frontend hosting, so runtime Worker variables/secrets are disabled (`Variables cannot be added to a Worker that only has static assets`).

---

## Section 1 — Decide architecture first (required)

Pick one of these two valid architectures:

### Option A (recommended for this repo now): Static frontend + Node backend host
Use Cloudflare only for frontend and run backend on Render/Railway/Fly/VPS.

Use this if your backend is still Express/Node (`server.ts`) with Node-specific packages.

### Option B: Full Cloudflare Worker backend
Move backend endpoints to Worker-compatible code and deploy with a real `main` Worker script.

Use this only after adapting Node/Express patterns to Worker APIs.

---

## Section 2 — If you choose Option A (fastest production path)

### 2.1 Backend host setup (Render/Railway/etc)
1. Deploy this repo as a Node service.
2. Set:
   - Install: `npm install`
   - Start: `npm run start` (or `npm run dev`)
3. Add backend secrets on that host (`DATABASE_URL`, WhatsApp/Meta, Google, AWS, Upstash, etc).
4. Verify health endpoint from public URL:
   - `https://<backend-domain>/api/health`

### 2.2 Cloudflare frontend environment variable (build-time)
1. In Cloudflare project settings, add:
   - `VITE_API_BASE_URL=https://<backend-domain>`
2. Redeploy frontend (required because Vite injects `VITE_*` at build-time).

### 2.3 CORS allowlist on backend
Allow your Cloudflare frontend origin in backend CORS config, otherwise auth/API calls fail.

---

## Section 3 — If you choose Option B (run backend inside Cloudflare Workers)

### 3.1 Add a real Worker entrypoint
In **one** Wrangler config (recommended: `wrangler.jsonc`), add:

```jsonc
{
  "name": "encho-enterprises-whatsapp-leads-handler",
  "main": "src/worker.ts",
  "compatibility_date": "2026-04-16"
}
```

Then create `src/worker.ts` with a Worker `fetch()` handler.

### 3.2 Keep static assets optional
If serving frontend from same Worker, keep `assets.directory = "./dist"` **plus** `main`.
Without `main`, Cloudflare still treats it as static only.

### 3.3 Move env usage to Worker runtime
Use Worker bindings (`env.MY_SECRET`) for runtime secrets.
Do **not** expect Worker runtime vars to populate `import.meta.env.VITE_*` in already-built frontend JS.

### 3.4 Deploy Worker
Use:

```bash
npx wrangler deploy
```

After deploy, Variables/Secrets section should allow runtime bindings.

---

## Section 4 — Build-time vs runtime quick rule (critical)

- `VITE_*` → frontend build-time substitution.
- Worker/Cloudflare Variables & Secrets → backend runtime bindings.

So:
- Frontend API URL belongs in build env (`VITE_API_BASE_URL`) and requires rebuild.
- Sensitive keys belong in backend runtime secrets (Node host env or Worker bindings), never in `VITE_*`.

---

## Section 5 — Practical “what to do now” checklist

For the current codebase, the lowest-risk sequence is:

1. Keep Cloudflare as frontend host.
2. Deploy backend (`server.ts`) on Render/Railway.
3. Set `VITE_API_BASE_URL` in Cloudflare build env to backend URL.
4. Redeploy Cloudflare frontend.
5. Confirm in browser network tab requests go to backend domain (not same-origin `/api` on workers.dev static app).
6. Rotate any secrets that were exposed in screenshots.

---

## Section 6 — Verification commands

From your local machine (replace domain):

```bash
curl -i https://<backend-domain>/api/health
curl -i -X OPTIONS https://<backend-domain>/api/auth/google -H "Origin: https://<your-cloudflare-frontend-domain>" -H "Access-Control-Request-Method: POST"
```

Expected:
- Health endpoint responds with JSON.
- CORS preflight returns allowed origin/method headers.

---

## Section 7 — Common failure map

- **Cloudflare says static-assets-only:** missing Worker `main` entrypoint.
- **`VITE_API_BASE_URL` ignored:** variable added after build; redeploy needed, or set in wrong env scope.
- **405 on `/api/*` from workers.dev domain:** frontend hitting static site origin instead of real backend API.
- **CORS blocked:** backend allowlist missing Cloudflare origin.

---

## Section 8 — Repository implementation status (updated)

The repository now includes a Worker entrypoint proxy:

- `src/worker.ts` proxies `/api/*` to `BACKEND_API_ORIGIN` and serves frontend assets from `ASSETS`.
- `wrangler.jsonc` and `wrangler.toml` now define `main = "src/worker.ts"`, so Cloudflare no longer classifies deployment as static-assets-only.

### Required dashboard/runtime values

- `BACKEND_API_ORIGIN`: your Node backend domain (for example Render/Railway URL).
- `ALLOWED_ORIGINS`: comma-separated origins allowed by the edge proxy CORS logic (`*` default).

After setting `BACKEND_API_ORIGIN`, redeploy with `npx wrangler deploy`.

