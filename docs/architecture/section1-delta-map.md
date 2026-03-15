# Section 1 Delta Map (Current -> Target)

## Target state reference
Target architecture is defined in `docs/modular-monolith-migration-plan.md` Section 1 (bootstrap-only app server and module-isolated domain logic).

## Current deltas
1. `server.js` still contains business routes and logic for media/reporting/driver workspace and system admin flows.
2. Lead ingestion/reminders/auth-config/system-health have facade/module routing, but remaining route families need extraction.
3. Import-direction checks exist, but extraction completion for all route families is pending.

## Migration slices
- Slice A: Extract agent-workspace route handlers to `backend/modules/agent-workspace/api.js`.
- Slice B: Extract reporting-export routes to module API + service + adapters.
- Slice C: Extract media routes to module API + service + adapters.
- Slice D: Extract lead-lifecycle and campaign-broadcast route families.
- Slice E: Reduce root `server.js` to wiring + app exports; run app entry from `backend/app/server.js`.

## Exit criteria
- Root server file contains bootstrap + middleware + mount wiring only.
- No direct DB/provider business logic in route handlers.
- CI boundary checks and critical integration suite remain green.
