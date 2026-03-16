# Risk Register Operational Status

## Top risks operational status

| Risk | Owner | Mitigation status | Residual risk score (1-5) | Trend | Linked monitor/runbook | Last incident/postmortem | Next review |
|---|---|---|---:|---|---|---|---|
| Webhook latency regression | Backend Lead | p95/p99 canary budgets enforced in release gate and evidence docs | 2 | improving | `scripts/check-performance-canary.js`, `docs/release-evidence/canary-rollout-stages-2026-03-15.md` | none in current cycle | 2026-03-22 |
| Dedupe drift | Ingestion Owner | Deterministic dedupe key contract + critical tests active | 2 | stable | `tests/critical-flows.test.js`, `scripts/check-contract-versioning.js` | none in current cycle | 2026-03-22 |
| Reminder misses during extraction | Reminders Owner | Canary + reconciliation metrics + rollback drill evidence complete | 2 | improving | `docs/release-evidence/rollback-drill-2026-03-15.md`, `scripts/run-rollback-validation.js` | none in current cycle | 2026-03-22 |
| Flag misconfiguration | Release Manager | Safe defaults + startup flag validation + rollback checklist | 3 | stable | `scripts/check-rollout-modes.js`, `docs/release-evidence/rollback-playbook-modules.md` | none in current cycle | 2026-03-22 |
| Operational blind spots | SRE | Health, queue, error, and latency checks embedded in release gate | 2 | improving | `scripts/release-gate.js`, `scripts/run-smoke-checks.js` | none in current cycle | 2026-03-22 |
