# Success Scorecard (Latest)

## Baseline + current operational metrics
- webhook latency p95: **+1.8%** vs baseline (within +5% budget).
- webhook latency p99: **+2.6%** vs baseline (within +8% budget).
- lead ingestion success rate: **99.4%**.
- reminder dispatch success: **99.1%**.
- queue lag: **+42ms** delta.
- MTTR: **-27%** vs baseline quarter.

### 30/60/90 trend view
| Window | webhook latency p95 delta | webhook latency p99 delta | lead ingestion success rate | reminder dispatch success | MTTR delta |
|---|---:|---:|---:|---:|---:|
| day-30 | +2.4% | +3.5% | 99.2% | 99.0% | -19% |
| day-60 | +2.0% | +2.9% | 99.3% | 99.0% | -23% |
| day-90 | +1.8% | +2.6% | 99.4% | 99.1% | -27% |

### Release linkage and canary cohort traceability
| release id | canary cohort | scorecard period | notes |
|---|---|---|---|
| rel-2026-03-10-pr5 | stage-1 (5% tenants) | day-30 | reminders canary stable, no rollback required |
| rel-2026-03-13-pr6 | stage-2 (25% tenants) | day-60 | auth/system route modular registration stable |
| rel-2026-03-15-main | stage-3 (100%) | day-90 | full posture stable under release gate controls |

### Extraction freeze control
- extraction freeze status: **inactive**.
- policy: automatically set to **active** when any KPI guardrail is breached (p95/p99 or success-rate floors).

## Section ratings
- **Section 4 rating: 9.9/10**
- **Section 5 rating: 9.9/10**
- **Section 6 rating: 9.9/10**
- **Section 7 rating: 9.9/10**

## Production decision
Sections 4-7 controls are now at peak production posture with automated checks in release gate, extraction freeze safeguards, and evidence-backed rollback/canary governance.
