# Neon 5 GB Network Transfer Recovery Plan (Cloudflare Workers + Neon)

Date: 2026-04-20

## Executive conclusion

Based on the screenshots, the Neon overage is **real and current** (`5.55 / 5 GB`), and the biggest risk driver is likely **high-volume non-value requests** (not storage, not compute). The Cloudflare metrics show a large 3xx+4xx population and request/subrequest parity, which indicates a proxy-heavy path with many requests that may still touch the backend and sometimes the DB.

A permanent fix is to enforce transfer budgets at the edge + reduce DB touches per request with strict dedupe/caching/batching. If the controls below are implemented together, monthly transfer can be pulled back under 5 GB without reducing user-perceived performance.

## What the screenshots tell us at micro level

### Neon screenshot

- `Network transfer: 5.55 / 5 GB (100%)` -> project has crossed free tier cap.
- `Storage: 0.04 / 0.5 GB` -> overage is **not** from data size at rest.
- `Compute: 41.45 / 100 CU-hrs` -> compute headroom exists; the primary bottleneck is transfer.

### Cloudflare Workers screenshot

- `Requests: ~16k` and `Subrequests: ~16k` in 24h view.
- Status mix in subrequests panel appears roughly:
  - `2xx ~5k`
  - `3xx ~6k`
  - `4xx ~6k`
  - `5xx ~9`
- Origin shown is your Render backend (`...onrender.com`), median duration ~196 ms.
- `Errors: 0` for worker runtime, but high non-2xx mix still creates wasted upstream traffic.

### Practical interpretation

1. **Edge is forwarding nearly everything upstream** (request/subrequest parity), so Cloudflare is not currently absorbing much load by cache/short-circuit.
2. **3xx + 4xx are very high**. Even when app “works,” these can still trigger backend work, auth checks, and DB reads.
3. This pattern can exhaust Neon transfer quickly even with modest lead volume, especially if admin dashboards poll frequently and bot webhooks retry.

## Permanent solution (performance-safe)

## 1) Enforce “DB touch budget” per route

For each hot API route, define max DB touches/request:

- Webhook inbound: <= 2 touches on first delivery, <= 0.2 on duplicates.
- Admin list/read APIs: <= 1 touch/request with pagination + projection.
- Auth/session checks: cacheable at edge or Redis for short TTL.

If route exceeds budget in profiling, block release.

## 2) Convert non-critical synchronous writes to write-behind

Your architecture already supports this direction (Redis/QStash + async durability). Make it mandatory on hot paths:

- Immediate webhook ACK.
- Queue heavy writes and aggregate into batch commits (target batch 3-5).
- Keep ordering guarantees only where business-critical.

This cuts DB round-trips and transfer while preserving low latency.

## 3) Kill waste from 3xx/4xx at edge

- Normalize URLs to avoid redirect loops/chains.
- Handle CORS preflight fast in worker and maximize `Access-Control-Max-Age`.
- Return 4xx early in worker for clearly invalid requests (before backend/DB).
- Lock frontend API base URL to canonical origin to prevent mixed-origin retries.

## 4) Apply strict query slimming

- No `SELECT *` on hot paths.
- Return only required columns for each endpoint DTO.
- Strong pagination defaults (25/50), plus cursor or indexed offset.
- Never read large blobs in request path.

## 5) Introduce transfer SLO guardrails

- Alert thresholds: 60%, 70%, 80%, 90% monthly budget.
- Burn-rate alarms: if projected month-end > 85%, auto-throttle non-critical workloads.
- Weekly review metric set:
  - KB/request
  - KB/lead
  - retry rate
  - duplicate webhook rate
  - cache hit ratio

## Effectiveness model for your current screenshots

A new estimator script has been added to project tooling:

```bash
npm run estimate:transfer:edge
```

This projects monthly transfer from Cloudflare 24h request volume + status mix and allows tuning cache/batching/retry assumptions.

### Example operating target (recommended)

- Cache hit ratio: >= 70%
- Write batch size: >= 4
- Retry multiplier: <= 1.05
- Reduce 3xx+4xx share to < 25% combined

Under those controls, projection should stay with a safety buffer under 5 GB (exact value depends on true DB touch intensity).

## Will the update help keep transfer under 5 GB/month?

**Yes — if implemented as a control system, not a single tweak.**

High confidence improvements:

1. Reducing 3xx/4xx upstream traffic reduces “wasted” backend/DB interactions directly.
2. Write-behind + batching cuts transfer per business event.
3. Route-level projection/pagination cuts bytes per DB response.
4. Cache-hit gains (edge + Redis) reduce DB touch frequency without hurting latency.

Low confidence if done partially:

- Only increasing Neon plan or only adding cache without fixing noisy request patterns can still re-hit the cap.

## Risk register from screenshots

1. **Capacity risk (Critical):** Neon transfer already exceeded this month.
2. **Efficiency risk (High):** 3xx/4xx-heavy edge traffic pattern.
3. **Observability risk (Medium):** worker success metric hides wasted successful-but-nonvalue requests.
4. **Cost drift risk (High):** no explicit monthly transfer envelope by workload type.

## 14-day stabilization plan

- Day 1-2: Baseline with edge estimator; set 60/70/80/90 alerts.
- Day 3-5: Remove redirect churn + preflight waste at worker.
- Day 6-8: Enforce projection/pagination and dedupe checks on hot APIs.
- Day 9-11: Increase cache TTL/hit on auth + session + config reads.
- Day 12-14: Verify burn-rate trend and freeze thresholds into CI/release gates.

## Commands

Baseline from current edge pattern:

```bash
npm run estimate:transfer:edge
```

Conservative high-traffic simulation:

```bash
CF_REQUESTS_24H=30000 RATIO_2XX=0.55 RATIO_3XX=0.20 RATIO_4XX=0.24 RATIO_5XX=0.01 CACHE_HIT_RATIO=0.75 WRITE_BATCH_SIZE=5 RETRY_MULTIPLIER=1.03 npm run estimate:transfer:edge
```

If this simulation remains below ~80% utilization, the system has healthy free-tier resilience.
