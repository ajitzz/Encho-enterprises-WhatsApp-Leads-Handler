# Neon 5 GB Network Transfer Mitigation Plan (Cloudflare Workers + Node API)

_Date: 2026-04-22_

## 1) What your screenshots show

### Neon dashboard signal
- Neon shows **Network transfer = 5.55 / 5 GB (100%)**, so the project has exceeded the free monthly transfer budget.
- Compute usage is moderate (**41.45 / 100 CU-hours**), storage is low (**0.04 / 0.5 GB**), so the bottleneck is **egress/transfer**, not storage or raw CPU.

### Cloudflare Workers metrics signal
- Requests/subrequests are both around **16k** in 24h window.
- Errors are near zero, CPU is very low, but **request duration tail is spiky**.
- Subrequest table indicates repeated origin hits to backend.

Interpretation: the architecture is healthy for correctness, but likely over-fetching snapshots from backend/DB.

## 2) Root-cause model at micro level

Given current code paths:
- `/api/updates/stream` periodically emits snapshots and currently queries DB snapshots repeatedly.
- `/api/drivers` also queries the same heavy snapshot shape (including message counters) and can be hit by polling fallback.
- Multiple concurrent clients cause duplicate identical DB reads for near-identical data.

This creates a transfer multiplier:

`Neon transfer ~= payload_per_snapshot * snapshots_per_minute * active_clients`

So even small per-request payload becomes expensive if repeated by many sessions.

## 3) Permanent strategy (without sacrificing performance)

### A. Done in this update (low risk, immediate win)
1. **Centralized hot snapshot cache** for driver list in API runtime.
2. **Singleflight in-flight dedupe** so concurrent requests share one DB fetch.
3. **Reusable snapshot for both SSE and `/api/drivers` endpoint**.
4. **ETag stays intact** and now hashes finalized payload fingerprint.
5. **Cache invalidation on updates** (on mutation events), preserving freshness.
6. **SQL optimization** from correlated subqueries to batched aggregate CTE for top 50 candidates.

Expected effect:
- Lower duplicate reads from Neon.
- Better p95/p99 latency during concurrent sessions.
- No UX compromise: same payload schema, same realtime behavior.

### B. Next-stage guardrails (recommended)
1. **Short TTL edge cache** on Cloudflare for manager analytics endpoints (10–30s).
2. **Conditional polling backoff** on inactive tabs (30–60s).
3. **Delta events** for SSE (send changed candidate IDs + lazy fetch details).
4. **Payload trimming** for list view vs detail view (send only columns needed for list).
5. **Monthly budget alerting** at 60%, 80%, 90% Neon transfer via cron check.

## 4) Will this keep you under 5 GB monthly?

This update is a strong first step, but exact monthly outcome depends on:
- concurrent users,
- average session duration,
- fallback polling frequency,
- payload size growth over time.

### Practical expectation
- In installations where repeated identical snapshots dominate traffic, this pattern often cuts DB-read traffic materially (frequently double-digit % and sometimes much more during concurrency spikes).
- It should **significantly improve your chance** of staying under 5 GB, but should be paired with next-stage guardrails for predictable month-end safety.

## 5) Cloudflare/Workers risk register from screenshot

1. **High subrequest symmetry (req ~= subreq)**
   - Risk: every edge request fan-outs to origin/DB path.
   - Mitigation: edge caching + coalescing + stale-while-revalidate.

2. **Tail latency spikes (P99 wall/request duration)**
   - Risk: periodic heavy snapshot queries and cold paths.
   - Mitigation: shared hot-cache + async refresh + smaller payload classes.

3. **No visible placement optimization enabled**
   - Risk: avoidable RTT from POP to origin region.
   - Mitigation: enable Smart Placement evaluation and pin backend region near Neon region.

4. **Potential polling fallback overuse**
   - Risk: when SSE disconnects, polling can multiply origin load.
   - Mitigation: exponential polling backoff + visibility-aware pause.

## 6) KPI targets after deploying this update

Track these for 7 days:
- Neon network transfer/day (GB/day)
- `/api/drivers` DB query count/min
- SSE snapshot DB hits/min
- p95/p99 request duration
- 304 ratio for `/api/drivers`

Suggested acceptance thresholds:
- >=30% drop in DB snapshot query count for peak hours
- p95 stable or better (no regression)
- transfer/day trend extrapolates to <5 GB/month

## 7) Rollout sequence

1. Deploy this update to production.
2. Observe 24h metrics vs previous 24h baseline.
3. Enable analytics endpoint TTL cache at edge.
4. Add fallback polling backoff.
5. Re-estimate monthly transfer budget.

If projected monthly transfer is still >5 GB, move to delta-stream events as Phase 2.
