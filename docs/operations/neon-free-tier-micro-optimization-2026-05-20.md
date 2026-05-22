# Neon Free Tier Micro-Optimization Plan (2026-05-20)

## Current risk signal
- Neon dashboard snapshot shows **72.72 / 100 CU-hrs** used mid-cycle, with storage and transfer still safe.
- Main pressure is compute-hour consumption, usually caused by always-on connections, repeated hot-path reads, and analytics endpoints doing repeated full scans.

## Project-level request pressure map

### 1) High-frequency write path: WhatsApp ingestion
- `LeadIngestionService.distributeLeadAutomatically` reads `system_settings` every time auto-distribution runs.
- It then executes multiple queries (staff selection, lead update, staff update, activity log).
- In high message volume this path can run continuously and keep Neon compute active.

### 2) Always-available API analytics path
- `/analytics/action-center` executes 3 independent candidate/reminder queries for every request.
- `/analytics/command-center` executes heavy aggregates over 14 days for each request.
- `/analytics/hierarchy-overview` computes grouped totals across managers/staff/candidates.
- If frontend polls these endpoints aggressively, compute usage rises even when no business event changes.

### 3) Connection pool profile
- DB pool previously allowed up to 20 connections by default.
- For Neon free tier this is high; connection churn and many idle-but-open sessions can increase compute wake time.

## Implemented code optimizations in this patch

1. **Reduced default DB pool footprint and made it env-tunable**
   - Added `PG_POOL_MAX` and `PG_IDLE_TIMEOUT_MS` with conservative defaults (`5`, `10000ms`).
   - Keeps fewer concurrent connections and releases idle clients faster.

2. **Added in-memory TTL cache for lead-distribution settings**
   - Added `LEAD_DISTRIBUTION_CACHE_TTL_MS` (default `60000ms`).
   - Avoids querying `system_settings` on every auto-distribution decision.
   - Reduces one read query per eligible inbound flow.

## Next optimizations you should apply (no-code + small-code)

### A) Frontend/API behavior (biggest quick win)
1. Stop blind polling for analytics pages:
   - Action Center refresh: every 30-60s only when tab is visible.
   - Command Center refresh: every 2-5 min or manual refresh.
2. Use ETag/If-None-Match or a `lastUpdatedAt` lightweight endpoint.
3. For inactive sessions, disable periodic refresh entirely.

### B) Query/index tuning for hot analytics reads
Create or validate these indexes:
- `candidates (assigned_to, lead_status, created_at DESC)`
- `candidates (assigned_to, lead_status, last_action_at)`
- `lead_reminders (staff_id, status, scheduled_at)`
- `lead_activity_log (staff_id, action, created_at)`
- `staff_members (manager_id)`

### C) Caching policy
1. Cache command-center aggregates for 30-120 seconds per manager.
2. Cache hierarchy-overview for 60-180 seconds per role scope.
3. Invalidate on lead status transitions and assignment updates.

### D) Move heavy analytics off request path
1. Add periodic materialized snapshot tables (minute-level).
2. Serve dashboards from snapshots; keep live detail endpoints on-demand.
3. Schedule refresh jobs during low-traffic windows.

### E) Guardrails to prevent free-tier overrun
1. Add internal metric for query count per endpoint.
2. Add alert when monthly CU consumption > 75%.
3. Auto-degrade analytics refresh rates above threshold.

## Environment variable recommendations
- `PG_POOL_MAX=3` to `5` (start with `4`).
- `PG_IDLE_TIMEOUT_MS=5000` to `10000`.
- `LEAD_DISTRIBUTION_CACHE_TTL_MS=60000` (raise to `120000` if config rarely changes).

## Validation checklist
1. Track 24h before/after:
   - Neon CU/hr trend
   - Avg/95p API latency
   - Error rates
2. Confirm no operational regression in lead assignment.
3. Adjust cache TTL and pool size by observed latency vs compute tradeoff.
