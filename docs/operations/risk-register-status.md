# Risk Register Operational Status

## Top risks operational status

| Risk | Trigger | Owner | Mitigation status | Kill-switch mapping | Next review |
|---|---|---|---|---|---|
| Webhook latency regression | p95 delta > +5% or p99 delta > +8% | Backend Lead | p95/p99 canary budgets enforced in release gate and evidence docs | `FF_LEAD_INGESTION_MODULE=off` | 2026-03-22 |
| Dedupe drift | duplicate ratio +0.2% over baseline | Ingestion Owner | Deterministic dedupe key contract + critical tests active | `FF_LEAD_INGESTION_MODULE=off` | 2026-03-22 |
| Reminder misses during extraction | dispatch success < 99% or queue lag > budget | Reminders Owner | Canary + reconciliation metrics + rollback drill evidence complete | `FF_REMINDERS_MODULE=off` | 2026-03-22 |
| Flag misconfiguration | invalid rollout mode at startup | Release Manager | Safe defaults + startup flag validation + rollback checklist | `FF_AUTH_CONFIG_MODULE=off` and `FF_SYSTEM_HEALTH_MODULE=off` | 2026-03-22 |
| Operational blind spots | missing parity evidence in release gate | SRE | Health, queue, error, and latency checks embedded in release gate | disable module rollout (`off`) until evidence recovers | 2026-03-22 |

## Stale review guard
- This register is considered stale after 14 days and will fail `npm run check:sections-4-7`.
