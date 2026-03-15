# Escalation Runbook (Module Ownership + Incident Path)

## Ownership model
- lead-ingestion: Ingestion Owner
- reminders-escalations: Reminders Owner
- auth-config/system-health: Platform Owner
- reporting/media/workspace/lifecycle/campaign: Domain owner per module OWNERSHIP.md

## Severity path
1. S1/S2 alert -> on-call triage within 5 minutes.
2. If module-flagged path is suspect, flip module to `off` immediately.
3. Run smoke and critical checks after rollback toggle.
4. Escalate to module owner + release manager for canary freeze decision.

## Standard rollback command flow
- Set `FF_<MODULE>_MODULE=off`
- Re-run `npm run test:smoke`
- Re-run `npm run test:critical`
- Confirm error/latency normalized in 10–15 minutes.
