# Contract Version Changelog

## 1.0.0
- Established internal event envelope baseline in `backend/shared/contracts/internalEvents.js`.
- Added module contract snapshots for lead-ingestion and reminders-escalations.
- Added governance checks for schema version presence and changelog enforcement.
- Expanded schema-versioned contract validators for bot-conversation, agent-workspace, campaign-broadcast, system-health, and auth-config modules.
- Expanded critical-flow contract tests to cover the above module boundaries and stricter ingress validation paths.
