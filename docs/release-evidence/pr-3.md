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
Verified rollback by setting `FF_LEAD_INGESTION_MODULE=off`, restoring legacy-only path.

## Metrics impact
Adds module-path observability and parity comparison opportunity with minimal latency impact.

## Test evidence
Critical test suite confirms facade delegation and deterministic contract behavior.

## Canary evidence
Canary-ready through tenant/percent mode controls; production cohort rollout pending release window.

## Post-release notes
Facade enables controlled migration while keeping emergency fallback immediate.
