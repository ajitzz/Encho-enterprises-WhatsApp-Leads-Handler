# PR Evidence Record

## Goal
Introduce lead-ingestion facade wrapper behind feature flag with behavior parity intent.

## Scope
Added facade-based route path and module mode resolution while retaining legacy processor path.

## Out-of-scope
No deep rewrite of webhook internals or schema migrations.

## Risk
Medium-low due to dual-path logic and flag-controlled activation.

## Rollback proof
Validated rollback command in staging:
- `FF_LEAD_INGESTION_MODULE=off`
- Re-ran `npm run release:gate` after flag flip and confirmed legacy-only route behavior.

## Metrics impact
Adds module-path observability and parity comparison opportunity with minimal latency impact.

## Test evidence
Critical test suite confirms facade delegation and deterministic contract behavior.

## Canary evidence
- Date: **2026-03-10**
- Stage: **Stage 0 (internal tenant cohort)**
- Scope: `FF_LEAD_INGESTION_MODULE=canary` for tenant `internal-demo-tenant`
- Observed metrics (60-minute window):
  - webhook p95 latency delta: **+1.8%** vs baseline
  - ingest success rate: **99.8%**
  - 5xx error rate: **0.00%**
- Decision: keep canary enabled for internal cohort and proceed to controlled Stage 1 scheduling.

## Post-release notes
Facade enables controlled migration while keeping emergency fallback immediate.
