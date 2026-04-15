# Cloudflare Screenshot Forensics & Exact Next Actions (2026-04-15)

This note analyzes the screenshots provided and gives exact next actions.

## Screenshot-by-screenshot findings

### Screenshot A (Deployments tab)
Observed:
- Active deployment exists (`3a6aa914`) with 100% traffic.
- Deploy time shown as ~4 hours ago.

Interpretation:
- A deployment happened, but this alone does **not** prove the production build included updated `VITE_API_BASE_URL`.

Action:
- Trigger **one more manual production deploy** after confirming variable scope (Production).

---

### Screenshot B (Overview tab)
Observed:
- "Metrics is unavailable for Workers with only static assets".
- `Workers 0`, `Queues 0`, `Bindings 0`.

Interpretation:
- This confirms static-assets-only serving mode.
- `/api/*` on the same workers.dev origin will not run your Express backend.

Action:
- Frontend must call external backend origin (`onrender.com`) via `VITE_API_BASE_URL`.

---

### Screenshot C/D (Settings tab + Variables)
Observed:
- Top panel says "Variables cannot be added to a Worker that only has static assets".
- Build section lower down shows variables list is present.

Interpretation:
- Runtime Worker vars are disabled for static-only Worker.
- Build-time variables are still valid and are the correct place for `VITE_*`.

Action:
- Keep `VITE_API_BASE_URL` in Build variables (Production scope), then redeploy.

---

### Screenshot E (Deployments list again)
Observed:
- Same recent version IDs around the same timestamp window.

Interpretation:
- Possible that variable changes and deployment timing did not align, or browser still has old JS bundle.

Action:
- Do a forced fresh cycle: verify variable -> clear build cache -> redeploy -> incognito hard refresh.

## Exact click-by-click recovery sequence

1. Cloudflare Dashboard → Workers & Pages → `encho-whatsapp-lead-handler`.
2. Open **Settings** tab.
3. In **Build** section, find **Variables and secrets**.
4. Confirm exact variable:
   - Name: `VITE_API_BASE_URL`
   - Value: `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com`
   - Environment: **Production**
5. Save changes.
6. In Build section, click **Clear cache** (if available).
7. Go to **Deployments** tab.
8. Click **New deployment**.
9. Wait for production deployment success.
10. Open app in Incognito.
11. Hard refresh (`Ctrl+Shift+R`).
12. DevTools → Network → click Google Sign-In.
13. Open the `POST /api/auth/google` request.
14. Verify `Request URL` starts with:
   - `https://encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com/api/auth/google`
15. If URL still points to workers.dev, repeat from step 2 and verify no env var typo.

## What success looks like

- Request URL points to Render domain.
- `/api/auth/google` no longer returns 405 from workers.dev.
- Login proceeds to `/api/auth/me` and dashboard API calls.

## If you still fail after all steps

Collect and share these exact items:
1. Screenshot of variable row for `VITE_API_BASE_URL` showing env scope.
2. Deployment details page timestamp after the change.
3. Network request details for `/api/auth/google` (Headers tab with full Request URL).
