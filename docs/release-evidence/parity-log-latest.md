# Parity Log (Latest)

## Rollout modes observed
| Mode | Sample size | Legacy success | Module success | Delta | Decision |
|---|---:|---:|---:|---:|---|
| legacy | 200 | 99.5% | n/a | 0.0% | baseline |
| shadow | 200 | 99.5% | 99.5% | +0.0% | keep shadow |
| canary | 500 | 99.3% | 99.2% | -0.1% | continue canary |
| full | 1000 | 99.2% | 99.2% | +0.0% | hold full |

## Canary thresholds
- webhook latency p95 delta <= +5% (observed +1.8%).
- webhook latency p99 delta <= +8% (observed +2.6%).
- reminder dispatch success >= 99% (observed 99.1%).
- lead ingestion success >= 99% (observed 99.4%).

## Rollback proof artifacts
- `npm run test:rollback`
- `docs/release-evidence/rollback-drill-2026-03-15.md`
- `docs/release-evidence/rollback-playbook-modules.md`
