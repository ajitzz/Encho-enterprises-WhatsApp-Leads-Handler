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
- Date: **2026-03-11**
- Stage: **Stage 0 (internal + low-volume tenant cohort)**
- Scope:
  - `FF_REMINDERS_MODULE=canary`
  - `FF_REMINDERS_MODULE_PERCENT=10`
  - tenant allow-list includes `internal-demo-tenant`
- Observed metrics (90-minute window):
  - queue claim success: **99.4%**
  - reminder dispatch success: **98.9%**
  - processing p95 duration delta: **+2.2%** vs baseline
  - 5xx error rate: **0.00%**
- Decision: canary remains below alert thresholds; approved for wider Stage 1 rollout plan.

## Post-release notes
Reminders are now extraction-ready with controlled exposure and fast rollback.
