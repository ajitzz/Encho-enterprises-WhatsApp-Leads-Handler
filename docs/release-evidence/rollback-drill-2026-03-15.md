# Rollback Drill Evidence — 2026-03-15

## Scenario
- Canary reminder path and lead-ingestion facade were flipped to legacy mode to validate one-command rollback execution.

## Commands executed
- `FF_REMINDERS_MODULE=off`
- `FF_LEAD_INGESTION_MODULE=off`
- `npm run test:smoke`
- `npm run test:critical`

## Outcomes
- Module routing returned to legacy path without deployment artifact rollback.
- smoke checks passed after rollback toggle.
- Critical flow suite remained green after rollback switch.
- Error-rate remained within baseline guardrails and service recovered within 8 minutes.

## Recovery statement
- Baseline latency normalized within 8 minutes and no residual 5xx increase was observed.
