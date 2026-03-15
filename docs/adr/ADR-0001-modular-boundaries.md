# ADR-0001: Modular Monolith Boundaries and Extraction Strategy

## Status
Accepted

## Context
The backend currently centralizes infrastructure, route handlers, and business logic in `server.js`. This raises blast radius and slows safe extraction.

## Decision
1. Use `backend/app/server.js` as canonical runtime bootstrap entry.
2. Keep module boundaries at `api/service/contracts/adapters`.
3. Enforce import direction (`app -> modules -> shared`) through CI checks.
4. Route all behavior-moving changes behind default-safe feature flags (`off` by default, then shadow/canary/full progression).
5. Require rollback evidence and canary non-regression for each extraction train.

## Consequences
- Improves rollback safety and ownership clarity.
- Requires phased extraction and stronger governance checks.
- Adds documentation and evidence maintenance overhead, offset by operational resilience.
