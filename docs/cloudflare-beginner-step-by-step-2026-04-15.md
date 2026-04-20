# Cloudflare Migration — Beginner Step-by-Step (No-Assumptions Guide)

> Goal: Make your app work reliably with Cloudflare frontend + working backend API, even if you are new.

This walkthrough uses the safest path first:

- **Frontend:** Cloudflare Pages/Workers static hosting.
- **Backend API:** Keep your existing Node/Express backend on a Node-compatible host.
- **Connect them:** `VITE_API_BASE_URL` + CORS.

---

## Before you start (10-minute prep)

You need:
1. Cloudflare account (you already have this).
2. GitHub repo connected to Cloudflare.
3. One backend host for Node API (choose one):
   - Railway, Render, Fly.io, or VPS.
4. Your backend environment variables ready (DB, Meta, Google, AWS, Upstash, etc).

---

## Step 1 — Deploy backend API first (Node-compatible runtime)

Your backend is Express/Node. Do **not** deploy API as static files.

### 1.1 Choose backend host (easy option: Railway/Render)
- Create a new service from your GitHub repo.
- Set root/project to this repo.

### 1.2 Backend build/start settings
Use these values:
- **Install command:** `npm install`
- **Build command:** *(optional)* `npm run build`
- **Start command:** `npm run dev` or `npm run start`

> In this repo, `start` and `dev` both run `tsx server.ts`.

### 1.3 Add backend env vars
In backend host dashboard, add all server env vars (from your old deployment):
- `DATABASE_URL`, `POSTGRES_*`
- `META_API_TOKEN`, `WHATSAPP_*`
- `GOOGLE_*`
- `AWS_*`
- `UPSTASH_*`
- any `FF_*` flags you use in production

### 1.4 Deploy and test backend URL
After deploy, you get URL like:
- `https://your-api-name.onrender.com`

Open in browser:
- `https://your-api-name.onrender.com/api/health`

Expected: JSON/health response (not 404 HTML, not 405 for GET).

If `/api/health` fails, fix backend first before moving on.

Important: opening only the base Render URL (without `/api/...`) may show:
- `{"error":"Route not found"}`
This is normal for an API-only backend and does not mean the service is down.

Tip: For your Render URL, test:
- `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com/api/health`

---

## Step 2 — Set frontend API URL in Cloudflare

Now connect Cloudflare frontend to your backend.

### 2.1 Open Cloudflare project settings
- Cloudflare Dashboard → Workers & Pages → your project.
- Go to **Settings** → **Variables and Secrets** (or Build settings variables section).

### 2.2 Add variable
Add:
- **Name:** `VITE_API_BASE_URL`
- **Value:** `https://your-api-name.onrender.com`

No trailing slash is required.

✅ Example for your current case:
- `VITE_API_BASE_URL=https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com`

Do **not** include `/api` in this variable. The app already appends `/api/...` per request.

### 2.3 Save for Production (and Preview if needed)
- Ensure variable is available for production environment.

---

## Step 3 — Configure backend CORS (must do)

Your backend must allow your Cloudflare frontend origin.

### 3.1 Find frontend domain
Example:
- `https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev`

### 3.2 Add allowed origin in backend CORS config
In your backend runtime config, allow:
- your Cloudflare domain above
- optionally localhost for local testing

If you keep restrictive CORS and forget this step, login/API calls fail with CORS errors.

---

## Step 4 — Rebuild and redeploy frontend on Cloudflare

Because `VITE_*` vars are compile-time in Vite, you **must redeploy** after setting them.

- Trigger new deployment from Cloudflare (or push small commit).
- Wait for deployment to finish.

---

## Step 5 — Verify with browser DevTools (exact checks)

Open app and press `F12` → Network tab.

### Check A: Google login API
- Action: click Google Sign-in.
- Request should be:
  - `POST https://your-api-name.onrender.com/api/auth/google`
  - or same origin if you later move API there.
- Must return 200/401 JSON, **not 405**.

### Check B: Profile API
- `GET /api/auth/me` returns user JSON.

### Check C: Main dashboard data
- `GET /api/drivers`
- `GET /api/bot/settings`
- Must return JSON.

---

## Step 6 — If you still see errors, use this quick diagnosis table

### Error: `405 /api/auth/google`
Cause:
- Frontend is still calling static Cloudflare domain without live API route.
Fix:
- Check `VITE_API_BASE_URL` exists in Cloudflare env.
- Confirm new deployment happened after setting var.

### Error: CORS blocked
Cause:
- Backend does not allow frontend origin.
Fix:
- Add Cloudflare frontend URL in backend CORS allowlist.

### Error: COOP postMessage warning
Cause:
- Popup isolation headers.
Fix:
- Keep `public/_headers` in repo and ensure fresh deploy includes it.

### Error: Google initialize called multiple times
Cause:
- Usually secondary warning after auth failures/retries.
Fix:
- Resolve API 405 + CORS first, then re-check.

---

## Step 7 — Recommended final architecture (for your case)

Right now, use this stable setup:
1. Cloudflare hosts static frontend.
2. Node host runs Express API.
3. Frontend calls API via `VITE_API_BASE_URL`.

Later, if needed, migrate API endpoints one by one to Workers/Pages Functions.

---

## Safety checklist (important)

If any secrets were visible in screenshots, rotate immediately:
- DB passwords/URLs
- Meta/WhatsApp tokens
- Google private keys
- AWS keys
- Upstash tokens/signing keys

---

## "I am stuck" fallback plan

If you share these 4 items, I can give exact values/where to click next:
1. Your chosen backend host (Render/Railway/Fly/VPS)
2. Backend URL you got after deploy
3. Cloudflare project screenshot of Variables section
4. First failing Network request details (URL + status + response)


---

## Step 8 — What to do right after setting `VITE_API_BASE_URL` (your exact situation)

If you already set:
- `VITE_API_BASE_URL=https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com`
- and `/api/health` returns `{"status":"ok"...}`

then do this exact sequence:

1. **Trigger a new Cloudflare production deployment now** (required).
2. Open your Cloudflare frontend URL in an Incognito window.
3. Open DevTools → Network.
4. Click Google Sign-In.
5. Confirm request URL is:
   - `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com/api/auth/google`
   - (not your Cloudflare static domain `/api/auth/google`)
6. If response is 200/401 JSON, continue login flow.
7. After login, confirm these API calls work:
   - `/api/auth/me`
   - `/api/drivers`
   - `/api/bot/settings`

If any call fails with **CORS**:
- add your Cloudflare frontend origin to backend CORS allowlist,
- redeploy backend,
- refresh frontend and test again.


### Important interpretation of Network tab
If `Request URL` is still:
- `https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev/api/auth/google`

then `VITE_API_BASE_URL` is **not present in the deployed frontend build**.

Most common causes:
1. Variable added only for Preview, not Production.
2. Variable added after last deploy, but no new production deploy was triggered.
3. Typo in variable name (must be exactly `VITE_API_BASE_URL`).
4. Browser still serving old JS bundle (hard refresh/cache issue).

Fix sequence:
1. Confirm variable exists in **Production** env.
2. Trigger new production deploy manually.
3. Open site in Incognito and hard refresh.
4. Re-test `/api/auth/google` in Network tab.


---

## Step 9 — Cloudflare UI click-by-click (exact buttons)

Use this if your request still hits `workers.dev/api/auth/google`.

1. Go to Cloudflare Dashboard.
2. Left sidebar → **Workers & Pages**.
3. Click your project: `encho-whatsapp-lead-handler`.
4. Open **Settings** tab.
5. Scroll to **Variables and Secrets** (Build variables section).
6. Verify a variable exists with:
   - Name: `VITE_API_BASE_URL`
   - Value: `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com`
7. Ensure it is set for **Production** environment.
8. Click **Save**.
9. Go to **Deployments** tab.
10. Click **Create deployment** / **Retry deployment** for Production.
11. Wait until status shows success.
12. Open site in **Incognito**.
13. Press `Ctrl+Shift+R` (hard refresh).
14. Open DevTools → Network → click Google Sign-In.
15. Click request `google`/`auth/google` and verify:
    - Request URL starts with `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com`
    - Not `https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev/api/...`

If still wrong after this, clear Cloudflare build cache and redeploy once more.


---

## Visual forensics companion

For screenshot-by-screenshot diagnostics, see: `docs/cloudflare-screenshot-forensics-2026-04-15.md`.


---

## URL meaning — Production vs Preview vs local developer mode

For Cloudflare Workers/Pages, URL pattern helps identify environment:

1. **Production workers.dev URL** (your current one):
   - `https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev`
   - This is your **production** service URL.

2. **Preview URL**:
   - Usually appears as a branch/commit-style preview subdomain (different from the main production workers.dev hostname).
   - Cloudflare dashboard Deployments page labels these as preview/non-production deployments.

3. **Developer/local mode**:
   - Local dev usually runs from `localhost` via wrangler/vite (`wrangler dev` or `npm run dev`).
   - It is not the public workers.dev production hostname.

So for your exact question: the URL
`https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev/`
indicates the deployed public Workers domain (production target), not localhost developer mode.

---

## Step 10 — Render + Cloudflare + Google OAuth (click-by-click, from zero)

Follow this exact order. Doing this out of order is the #1 cause of `405` and Google auth failure.

### Part A: Render backend (API)

1. Open **Render Dashboard**.
2. Click **New +** → **Web Service**.
3. Connect your GitHub repo.
4. In setup form, choose:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm run start`
5. Click **Create Web Service**.
6. Wait for deploy to finish.
7. Open:
   - `https://<your-render-service>.onrender.com/api/health`
8. Confirm you get JSON (or success health response).

If `/api/health` fails, stop and fix Render first.

### Part B: Cloudflare frontend variable

1. Open **Cloudflare Dashboard**.
2. Go to **Workers & Pages**.
3. Open project **encho-whatsapp-lead-handler**.
4. Click **Settings**.
5. Open **Variables and Secrets**.
6. Under production environment, add:
   - Name: `VITE_API_BASE_URL`
   - Value: `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com`
7. Click **Save**.
8. Go to **Deployments**.
9. Click **Retry deployment** (or create a new production deployment).
10. Wait until deployment is green/success.

Important: `VITE_*` values are baked at build time; saving variable without redeploy does nothing.

### Part C: Google Cloud OAuth setup (must match your live domain)

1. Open **Google Cloud Console**.
2. Select your project.
3. Go to **APIs & Services** → **Credentials**.
4. Click your **OAuth 2.0 Client ID** (Web type).
5. In **Authorized JavaScript origins**, add:
   - `https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev`
6. If you also use a custom frontend domain, add it too.
7. Click **Save**.

For this app's current `google.accounts.id` token flow, **origins** are the critical setting.

### Part D: Verify request target (the key test)

1. Open app in Incognito.
2. Press `F12` → **Network** tab.
3. Click Google Sign-In.
4. Click the `google` request row.
5. In Headers, check **Request URL**:
   - ✅ Correct: `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com/api/auth/google`
   - ❌ Wrong: `https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev/api/auth/google`

If it is still the workers.dev URL, your deployed frontend bundle still does not have `VITE_API_BASE_URL`.

### Part E: If you want one single domain later (advanced)

If you want Cloudflare domain to serve both UI and API, you must add a real Worker/Pages Function proxy for `/api/*` to Render (or migrate API to Workers). Static assets alone cannot handle `POST /api/auth/google` and will keep returning `405`.

