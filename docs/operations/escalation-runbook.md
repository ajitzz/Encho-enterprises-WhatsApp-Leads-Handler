# Escalation Runbook (Module Ownership + Incident Path)

## Ownership model
- lead-ingestion: Ingestion Owner
- reminders-escalations: Reminders Owner
- auth-config/system-health: Platform Owner
- reporting/media/workspace/lifecycle/campaign: Domain owner per module OWNERSHIP.md

## Severity path
1. S1/S2 alert -> on-call triage within 5 minutes.
2. Verify runtime posture from startup logs (`lead-ingestion` `startup.module_mode_posture`) and confirm effective mode (`on/canary/off`) for impacted tenant context.
3. If module-flagged path is suspect, flip module to `off` immediately.
4. If lead-ingestion module is intentionally `off`, enable emergency fallback only when needed (`FF_LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK=true`) and time-box usage.
5. Run smoke and critical checks after rollback toggle.
6. Escalate to module owner + release manager for canary freeze decision.

## Standard rollback command flow
- Set `FF_<MODULE>_MODULE=off`
- For lead-ingestion only: set `FF_LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK=true` **only** for emergency continuity and disable once recovered.
- Re-run `npm run test:smoke`
- Re-run `npm run test:critical`
- Confirm error/latency normalized in 10–15 minutes.

## Release checklist (required)
- Confirm `FF_LEAD_INGESTION_MODULE=on` in production before release completion.
- Record startup `startup.module_mode_posture` log evidence showing effective mode for default + canary tenants.
- If temporary fallback was used during release/incident, record enable/disable timestamps and owner sign-off.
