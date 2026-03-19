# Release Preflight Checklist

Run one command before any migration rollout:

- `npm run check:release-preflight`

The preflight blocks promotion unless boundaries, contracts, sections 1-3 and 4-7 readiness, canary performance, and governance checks are green.

## Rollback objective
- Release gate enforces rollback recovery evidence <= 15 minutes from `docs/release-evidence/rollback-drill-2026-03-15.md`.
