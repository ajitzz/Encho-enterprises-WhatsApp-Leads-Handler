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
2. If critical path impacted (webhook/reminders/stage transitions) -> on-call lead engaged immediately.
3. If canary SLO breach persists 2 intervals -> flip module flag to `off` and run smoke/critical suite.
4. Document rollback evidence in release notes before re-attempting canary.
