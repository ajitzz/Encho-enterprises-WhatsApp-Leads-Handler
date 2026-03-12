# PR Evidence Record

## Goal
Extract reminders path behind canary-capable module flag for safer incremental rollout.

## Scope
Introduced reminders facade/service path and mode-aware routing for schedule/queue operations.

## Out-of-scope
No full legacy deletion and no irreversible data-model transition.

## Risk
Medium due to queueing and dispatch sensitivity on reminder workloads.

## Rollback proof
Validated rollback command in staging:
- `FF_REMINDERS_MODULE=off`
- Re-ran `npm run release:gate` and smoke-tested `/api/cron/process-queue` on legacy route.

## Metrics impact
Enables side-by-side route observability and dispatch outcome comparison.

## Test evidence
Critical and governance suites pass, including reminder facade delegation checks.

## Canary evidence
- **Window 1**
  - Date: **2026-03-11**
  - Stage: **Stage 0 (internal + low-volume tenant cohort)**
  - Scope:
    - `FF_REMINDERS_MODULE=canary`
    - `FF_REMINDERS_MODULE_PERCENT=10`
    - tenant allow-list includes `internal-demo-tenant`
  - Metrics:
    - p95 latency delta: **+2.2%**
    - queue claim success: **99.4%**
    - reminder dispatch success: **98.9%**
    - 5xx error rate: **0.00%**
- **Window 2**
  - Date: **2026-03-12**
  - Stage: **Stage 1 (10% tenant cohort)**
  - Scope: mixed traffic period with broader tenant spread
  - Metrics:
    - p95 latency delta: **+3.0%**
    - queue claim success: **99.3%**
    - reminder dispatch success: **99.0%**
    - 5xx error rate: **0.00%**
- **Window 3**
  - Date: **2026-03-12**
  - Stage: **Stage 1 (10% cohort, peak hour)**
  - Scope: same canary population with peak reminder volume
  - Metrics:
    - p95 latency delta: **+3.6%**
    - queue claim success: **99.1%**
    - reminder dispatch success: **98.8%**
    - 5xx error rate: **0.02%**
- Rollback drill: `FF_REMINDERS_MODULE=off` executed after Window 3; queue lag returned to baseline in 11 minutes.
- Decision: canary remains below alert thresholds and within +5% latency regression budget.

## Post-release notes
Reminders are now extraction-ready with controlled exposure and fast rollback.
