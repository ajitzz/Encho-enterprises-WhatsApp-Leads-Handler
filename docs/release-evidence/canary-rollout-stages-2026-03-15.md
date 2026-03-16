# Canary Rollout Stages Evidence (2026-03-15)

## Stage 0
- Internal tenant only.
- Threshold: no 5xx increase, stable webhook latency, and shadow parity logs generated.

## Stage 1
- 5% cohort.
- Threshold: p95 <= baseline +5%, no dedupe drift, parity delta <= 0.5%.

## Stage 2
- 25% cohort.
- Threshold: reminder dispatch success >=99%, queue lag within budget, parity delta <= 0.3%.

## Stage 3
- 100% rollout with heightened watch.
- Threshold: sustained SLO pass for 24h and parity delta <= 0.2%.

## Rollback protocol
- Immediate rollback via module flag to `off` when thresholds fail.
- Post-rollback smoke + critical checks required.
- Rollback proof is captured in `docs/release-evidence/parity-log-latest.md` and rollback drill artifacts.
