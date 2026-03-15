# Canary Rollout Stages Evidence (2026-03-15)

## Stage 0
- Internal tenant only.
- Threshold: no 5xx increase and stable webhook latency.

## Stage 1
- 5% cohort.
- Threshold: p95 <= baseline +5%, no dedupe drift.

## Stage 2
- 25% cohort.
- Threshold: reminder dispatch success >=99%, queue lag within budget.

## Stage 3
- 100% rollout with heightened watch.
- Threshold: sustained SLO pass for 24h.

## Rollback protocol
- Immediate rollback via module flag to `off` when thresholds fail.
- Post-rollback smoke + critical checks required.
