# Serverless Performance Audit (Vercel) — 2026-04-11

## Scope
Focused on unnecessary API calls, excessive executions, webhook/idempotency behavior, polling load, and potential runtime leaks.

## Highest-impact findings

### 1) Client triggers queue processor every 10s per logged-in live session
- **Where:** `App.tsx` triggers `GET /api/cron/process-queue` every 10 seconds.
- **Why it is costly:** With N concurrent users, this becomes `N * 6 req/min` to a serverless function intended for queue processing. This scales linearly with active browsers and can dominate invocation count/CPU.
- **Fix:** Move scheduling to Vercel Cron (single producer) or gate this endpoint behind leader election/visibility state and exponential backoff when queue is empty.
- **Estimated impact:** **Very high** (often 50%+ reduction in queue-function invocations for multi-user dashboards).

### 2) SSE stream sends full snapshots on every update + every 10s fallback
- **Where:** `/api/updates/stream` refreshes full snapshot on each event and also on a 10s interval.
- **Why it is costly:** Each open SSE connection repeatedly executes full-driver queries and per-driver message/scheduled enrichment. For many connected clients, this multiplies DB and function work.
- **Fix:** Send deltas keyed by changed candidate ID, throttle update fanout (e.g., coalesce to 250–500ms), and only run interval fallback when no push updates seen for a grace window.
- **Estimated impact:** **Very high** for active teams (substantial CPU + DB reduction under chat-heavy workloads).

### 3) Duplicate heartbeat route definitions + mismatched client contract
- **Where:** Two `POST /staff/heartbeat` handlers are defined; the first one will match first.
- **Why it is costly/risky:** Second route (which stores active/idle seconds) is effectively dead; clients still ping frequently. This causes wasted design complexity and inconsistent telemetry, making tuning harder.
- **Fix:** Consolidate into one handler and one service method signature; keep payload minimal and sampled.
- **Estimated impact:** **Medium** direct usage reduction, **high** operational clarity.

### 4) 2-second sync-status polling in Driver Excel report
- **Where:** `DriverExcelReport.tsx` polls `loadSyncStatus` every 2 seconds.
- **Why it is costly:** Aggressive polling for mostly unchanged state creates continuous traffic and function compute.
- **Fix:** Poll only while sync state is `running/queued` (2–5s), otherwise back off to 30–60s or switch to SSE/websocket event.
- **Estimated impact:** **High** for users leaving report screens open.

### 5) Due-alert polling effects are re-created on alert changes
- **Where:** Due-alert polling hooks depend on `activeDueAlert?.event_id` in both `App.tsx` and `StaffPortal.tsx`.
- **Why it is costly:** Every alert transition tears down and recreates intervals and forces an immediate fetch; this can burst extra calls during busy periods.
- **Fix:** Remove `activeDueAlert` from effect deps, keep one stable polling loop, use refs for active alert checks.
- **Estimated impact:** **Medium** (spike smoothing + fewer duplicate calls).

### 6) Bulk status updates are fully sequential
- **Where:** `handleBulkStatusUpdate` loops `await` one-by-one.
- **Why it is costly:** Long wall-clock duration increases client waiting and can increase overlapping serverless runtimes under user retries.
- **Fix:** Batch API endpoint or bounded parallelism (`Promise.allSettled` with concurrency limit 3–5).
- **Estimated impact:** **Medium** per bulk operation.

### 7) Webhook deferred bot queue uses 1ms spin when saturated
- **Where:** `setTimeout(drainLoop, 1)` while at concurrency cap.
- **Why it is costly:** Busy re-checking can burn CPU in hot webhook bursts, especially in single-threaded Node runtime.
- **Fix:** Replace with event-driven wakeup (on slot release) or adaptive backoff (e.g., 25ms→100ms).
- **Estimated impact:** **Medium to high** during burst traffic.

## Additional architecture notes
- Webhook dedupe exists in memory + DB path, which is good, but memory dedupe resets on cold starts and cannot prevent cross-instance duplicates. Persisted idempotency key table with unique constraint would harden this for serverless fanout.
- `Cache-Control` is configured for SSE; for read-heavy JSON endpoints (e.g., static-ish status/config), consider short-lived cache headers + ETag where acceptable.
