# ADR-0001: Modular Monolith Boundary Rules

## Status
Accepted

## Context
The migration plan requires low-risk extraction from `server.js` to internal modules while preserving production behavior.

## Decision
We enforce these guardrails:
1. `shared` must not import `modules`.
2. A module adapter must not import another module's adapter directly.
3. Contract versions must be explicit and tracked with changelog entries.
4. Release gate must include governance checks plus critical-flow tests.

## Consequences
- We gain deterministic boundary validation in CI.
- Extraction can proceed with lower coupling risk and clearer ownership lines.
- Teams must keep contract versions/changelog entries updated with any schema change.
