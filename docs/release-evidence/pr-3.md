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
- **Window 1**
  - Date: **2026-03-10**
  - Stage: **Stage 0 (internal tenant cohort)**
  - Scope: `FF_LEAD_INGESTION_MODULE=canary` for tenant `internal-demo-tenant`
  - Metrics:
    - p95 latency delta: **+1.8%**
    - ingest success rate: **99.8%**
    - 5xx error rate: **0.00%**
- **Window 2**
  - Date: **2026-03-11**
  - Stage: **Stage 1 (5% tenant cohort)**
  - Scope: low-volume production hours, allow-list + percent strategy
  - Metrics:
    - p95 latency delta: **+2.6%**
    - ingest success rate: **99.7%**
    - 5xx error rate: **0.01%**
- **Window 3**
  - Date: **2026-03-12**
  - Stage: **Stage 1 (5% tenant cohort, peak traffic hour)**
  - Scope: same cohort, higher inbound burst period
  - Metrics:
    - p95 latency delta: **+3.1%**
    - ingest success rate: **99.6%**
    - 5xx error rate: **0.01%**
- Rollback drill: `FF_LEAD_INGESTION_MODULE=off` executed after Window 3 and baseline latency normalized within 8 minutes.
- Decision: keep canary enabled and promote only if next peak window remains <= +5% p95 regression budget.

## Post-release notes
Facade enables controlled migration while keeping emergency fallback immediate.
