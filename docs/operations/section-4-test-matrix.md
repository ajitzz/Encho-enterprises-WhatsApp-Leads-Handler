# Section 4 Test Matrix (Industrial Standard)

## Unit tests
- Contract validators and schema-version guards for all module contracts under `backend/modules/*/contracts.js`.
- Idempotency helper tests for deterministic dedupe and transition fingerprints.
- Flag-routing tests for `resolveModuleMode` safety defaults (`off`, scoped canary, legacy fallback).

## Integration tests
- Webhook ingest -> dedupe -> upsert -> bot engine trigger.
- Reminder schedule/tick -> dispatch transitions and reconciliation counts.
- Stage transition validation and stable error-contract mapping.
- Auth/system-health/module ingress validation for invalid payload rejection.

## Smoke tests
- Route surface checks for health (`system-health`), webhook (`lead-ingestion`), media, and reporting modules.
- Basic release artifact checks executed by CI as part of `test:smoke`.

## Rollback validation
- Validate module flags force legacy path with `FF_*_MODULE=off`.
- Validate canary scope is tenant-gated and does not leak to non-allowlisted tenants.
- Confirm rollback command path and post-rollback smoke checks are documented and reproducible.
