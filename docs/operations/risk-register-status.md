# Risk Register Operational Status

## Top risks operational status

| Risk | Owner | Mitigation status | Next review |
|---|---|---|---|
| Webhook latency regression | Backend Lead | p95/p99 canary budgets enforced in release gate and evidence docs | 2026-03-22 |
| Dedupe drift | Ingestion Owner | Deterministic dedupe key contract + critical tests active | 2026-03-22 |
| Reminder misses during extraction | Reminders Owner | Canary + reconciliation metrics + rollback drill evidence complete | 2026-03-22 |
| Flag misconfiguration | Release Manager | Safe defaults + startup flag validation + rollback checklist | 2026-03-22 |
| Operational blind spots | SRE | Health, queue, error, and latency checks embedded in release gate | 2026-03-22 |
