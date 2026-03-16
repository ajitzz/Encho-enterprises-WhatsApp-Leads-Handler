# Module Ownership and Escalation Runbook

## Ownership map
- lead-ingestion: Ingestion owner
- bot-conversation: Bot owner
- lead-lifecycle: Lifecycle owner
- reminders-escalations: Reminders owner
- reporting-export: Reporting owner
- media: Media owner
- system-health: SRE owner

## Escalation path
1. Route-level regression detected -> module owner triage within 15 minutes.
2. Validate effective module mode (`on/canary/off`) from startup posture logs for the affected tenant before changing flags.
3. If critical path impacted (webhook/reminders/stage transitions) -> on-call lead engaged immediately.
4. If canary SLO breach persists 2 intervals -> flip module flag to `off` and run smoke/critical suite.
5. Lead-ingestion legacy processor is emergency fallback only; enable `FF_LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK=true` only during incident containment and disable after recovery.
6. Document rollback evidence in release notes before re-attempting canary.

## Release + incident checklist
- Verify `FF_LEAD_INGESTION_MODULE=on` for production baseline.
- Attach `startup.module_mode_posture` log evidence with tenant context.
- During triage, explicitly state whether runtime is `on`, `canary`, or `off` before mitigation steps.
