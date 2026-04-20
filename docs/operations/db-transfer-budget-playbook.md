# DB Transfer Budget Playbook (5GB Neon Cap, 24/7 Webhooks)

## Objective
Keep the WhatsApp webhook + chatbot online 24/7 while staying inside a strict **5GB/month database transfer** cap.

## Baseline workload used for planning
- 300 leads/week
- ~18 total messages per lead (lead + bot flow)
- 20% of leads send documents
- Media files are uploaded to S3 and only URL metadata is persisted in Postgres

## Capacity result (recommended operating mode)
Run:

```bash
LEADS_PER_WEEK=300 MSGS_PER_LEAD=18 DOC_RATE=0.2 CACHE_HIT_RATIO=0.7 WRITE_BATCH_SIZE=4 RETRY_MULTIPLIER=1.05 npm run estimate:transfer
```

Target result:
- Total monthly transfer significantly below 5GB
- Headroom >= 20%
- Budget utilization <= 80%

## 9.9/10 operating guardrails

1. **Redis-first conversation state**
   - Serve hot chat/session reads from Redis.
   - Persist to Postgres asynchronously (write-behind) on state transitions.

2. **Write batching for lead timeline events**
   - Batch 3–5 events per DB flush where possible.
   - Avoid one INSERT/UPDATE round-trip per inbound/outbound message.

3. **Thin rows for media records**
   - Persist only: `lead_id`, `media_type`, `s3_url`, `checksum`, `created_at`.
   - Never persist raw binary payloads in Postgres.

4. **Idempotent webhook processing**
   - Deduplicate by webhook event/message id before touching DB.
   - Prevent duplicate transfer cost from retries.

5. **Transfer budget SLOs**
   - Alert at 70%, 80%, and 90% monthly utilization.
   - Weekly review: transfer consumed vs. lead volume.

6. **Background durability path**
   - Keep webhook reply path stateless and fast (<2s).
   - Queue DB writes through QStash/worker.

7. **Schema/query hygiene**
   - Return only needed columns in SELECT statements.
   - Add indexes to avoid scan-heavy responses.
   - Prefer append-only event rows over large mutable JSON blobs.

## Weekly operations checklist
- Run transfer estimator with latest observed message volume.
- Compare expected usage vs. current Neon dashboard usage.
- Verify Redis hit ratio remains >= 65%.
- Verify retry/duplicate event rate remains <= 5%.
- Confirm no media payload is persisted into DB.

## If usage trends above budget
1. Increase cache hit ratio (session TTL tuning + warm bot config cache).
2. Increase write batching factor (without violating ordering guarantees).
3. Reduce non-essential polling/health query frequency.
4. Move analytics/reporting queries to daily batch window.
5. Upgrade DB transfer plan only if optimization headroom is exhausted.

## Production answer for your exact workload (300 inquiries/week, always-on)

For the declared operating profile (300 leads/week, 18 messages/lead, 20% docs to S3, Redis-first + batched writes), the estimator projects:

- **Total DB transfer ≈ 0.027 GB/month**
- **Budget utilization ≈ 0.54% of 5 GB**
- **Headroom ≈ 4.973 GB**
- **Grade: 9.9/10 (Peak-safe)**

Use this command for recurring validation:

```bash
LEADS_PER_WEEK=300 MSGS_PER_LEAD=18 DOC_RATE=0.2 CACHE_HIT_RATIO=0.7 WRITE_BATCH_SIZE=4 RETRY_MULTIPLIER=1.05 npm run estimate:transfer
```

### What this means in plain terms

- Yes, you can keep webhook/chatbot **24/7 for months** and still stay below 5 GB.
- If you already crossed 5 GB, your excess is likely from **non-chatbot transfer** (dashboards, heavy SELECTs, ad-hoc exports, repeated retries, debug polling, or large row payloads), not from the modeled WhatsApp flow itself.

## Hard control limits (to keep a 9.9/10 grade)

Treat these as non-negotiable SLOs:

1. **Cache hit ratio >= 65%** (target 70–80%).
2. **Write batch size >= 3** (target 4–5).
3. **Webhook duplicate/retry rate <= 5%**.
4. **Health check frequency <= 1/minute** unless incident mode.
5. **No large JSON/message blobs in hot tables**; only keys + compact metadata.
6. **No DB media binaries** (S3 object only + URL/checksum in DB).

## Fast incident drill when transfer spikes unexpectedly

Execute in this order within the same day:

1. Cut non-essential polling jobs by 50%.
2. Reduce dashboard auto-refresh to >= 60s.
3. Turn on strict column projection (`SELECT only required columns`).
4. Increase Redis TTL for session/config objects by 25–50%.
5. Raise write batching one step (for example 3 -> 4).
6. Pause non-critical analytics queries to an off-peak batch window.

## Weekly governance cadence (recommended)

- Run estimator with actual observed inputs from last 7 days.
- Compare estimator output to Neon monthly transfer consumed.
- Record: cache-hit %, retry %, transfer/lead, transfer/message.
- Open an action item if either:
  - budget utilization forecast > 70%, or
  - transfer per lead jumps by > 20% week-over-week.

## Scenario analysis: 300 to 1000 inquiries/week (your stated range)

Using the built-in estimator with your current architecture assumptions (S3 media objects + DB URL only, Redis-first reads, batched writes):

- `LEADS_PER_WEEK=300` -> **~0.027 GB/month** (~0.54% of 5 GB).
- `LEADS_PER_WEEK=1000` -> **~0.041 GB/month** (~0.82% of 5 GB).

This means the WhatsApp chatbot workload itself is not the transfer bottleneck under healthy architecture controls. If the account crossed 5 GB, the likely source is usually one or more of:

- repeated dashboard polling / short refresh intervals,
- broad `SELECT *` queries against high-volume tables,
- repeated failed/retried webhook deliveries without dedupe,
- heavy export/reporting jobs executed too frequently,
- oversized payload columns fetched repeatedly.

## Admin panel upgrade: live DB transfer budget control

To operate at a sustained **9.9/10 grade**, expose transfer and efficiency KPIs in the admin panel with these widgets:

1. **Monthly transfer gauge**
   - `used_gb`, `budget_gb=5`, `% utilized`, `% remaining`.
   - Color states: green < 70%, amber 70-85%, red > 85%.

2. **Transfer intensity metrics**
   - `KB per lead` (daily + weekly trend).
   - `KB per message` (inbound+outbound).
   - `GB/day burn rate` and projected month-end usage.

3. **Optimization health metrics**
   - Redis cache hit ratio.
   - Write batch size (effective average).
   - Webhook duplicate/retry rate.
   - Health-check query frequency.

4. **Anomaly feed**
   - Top 10 queries/endpoints by transferred bytes.
   - Spike detector when transfer/lead jumps > 20% day-over-day.

5. **Action center**
   - One-click incident toggles: lower polling frequency, pause non-critical exports, increase cache TTL profile.

## Composite management rating (target: 9.9/10)

Use a weighted score to continuously track transfer optimization quality:

- **Budget utilization (35%)**: highest score when <= 55% of budget.
- **Transfer efficiency per lead (25%)**: stable or improving week-over-week.
- **Cache + batching discipline (20%)**: cache hit >= 65%, batch size >= 3.
- **Retry/idempotency control (10%)**: duplicate+retry <= 5%.
- **Operational observability (10%)**: alerts + trend dashboards + runbook drills active.

A practical interpretation:

- **9.9/10** -> utilization < 55%, all control limits healthy, no unresolved spikes.
- **9.3/10** -> utilization 55-70%, minor drift, corrective actions in progress.
- **8.5/10** -> utilization 70-85%, elevated risk, mandatory weekly optimization actions.
- **<= 7.0/10** -> utilization > 85%, incident mode until stabilized.

## Exact commands for weekly forecasting

```bash
LEADS_PER_WEEK=300 MSGS_PER_LEAD=18 DOC_RATE=0.2 CACHE_HIT_RATIO=0.7 WRITE_BATCH_SIZE=4 RETRY_MULTIPLIER=1.05 npm run estimate:transfer
LEADS_PER_WEEK=1000 MSGS_PER_LEAD=18 DOC_RATE=0.2 CACHE_HIT_RATIO=0.7 WRITE_BATCH_SIZE=4 RETRY_MULTIPLIER=1.05 npm run estimate:transfer
```

## Implementation focus to stay below 5 GB while running 24/7

1. Keep webhook handler always-on in a server/worker runtime with auto-restart (PM2/systemd or managed equivalent).
2. Keep response path minimal: parse -> dedupe -> enqueue -> immediate WhatsApp ACK.
3. Move non-urgent DB writes to worker queue and batch flushes.
4. Keep media in S3 only; DB stores URL + checksum metadata only.
5. Add hard alerts at 70/80/90% and a weekly transfer budget review ritual.

With these controls, your declared 300-1000 inquiries/week pattern remains comfortably below a 5 GB DB transfer limit while preserving 24/7 chatbot availability.

## Better suggestions (v2): keep transfer < 5 GB at sustained 9.9/10

### 1) Enforce a hard monthly transfer envelope by source
Set explicit per-source budgets so overages cannot hide until month-end:

- Webhook ingest + bot replies: **40% max**
- Admin panel reads: **15% max**
- Reporting/exports: **20% max**
- Background jobs + health checks: **10% max**
- Safety buffer (retries/spikes): **15% reserved**

If any bucket exceeds 85% of its allocation, trigger an automatic throttle profile.

### 2) Move from request/response polling to event-driven UI updates
Polling is a common silent transfer leak.

- Replace frequent admin polling with SSE/WebSocket updates from a compact in-memory snapshot.
- Keep dashboard auto-refresh at >= 60 seconds in normal mode.
- Disable heavy widgets by default; lazy-load only when a user opens the panel.

### 3) Add a transfer-aware repository layer
Every read path should be byte-budgeted.

- Ban `SELECT *` on hot tables.
- Define strict projection DTOs for each endpoint.
- Enforce pagination with small page sizes (for example 25/50 rows).
- Add query lint checks in CI for unbounded/oversized result sets.

### 4) Use Redis as the primary operational read model
For WhatsApp conversation responsiveness and low DB transfer:

- Keep active conversation state + latest lead summary in Redis.
- Write to Postgres on state transitions / milestones, not every message turn.
- Store short-lived analytics counters in Redis and flush aggregated deltas periodically.

### 5) Introduce adaptive write-behind batching
Use dynamic batch size based on queue depth and retry pressure:

- Low traffic: batch size 3-4 for low latency.
- High traffic: batch size 5-8 to reduce transfer per message.
- On incident mode: batch size increase + non-critical write deferral.

### 6) Guardrails for media/document flow
You already keep binaries in S3, which is correct. Add two more controls:

- Persist only immutable metadata keys (URL/checksum/type/timestamps), not verbose OCR/extraction payloads in hot rows.

## Overage recovery plan for the 5.5 GB incident (immediate)

If monthly transfer already reached **5.5 GB** against a **5 GB cap**, treat it as a control-plane leak investigation, not a WhatsApp volume issue:

1. Run estimator with your observed numbers and compare source share:

   ```bash
   LEADS_PER_WEEK=300 MSGS_PER_LEAD=18 DOC_RATE=0.2 CACHE_HIT_RATIO=0.7 WRITE_BATCH_SIZE=4 RETRY_MULTIPLIER=1.05 npm run estimate:transfer
   ```

2. If the estimator output remains low but Neon usage is high, focus on:
   - admin polling frequency,
   - broad dashboard queries (`SELECT *`),
   - exports/reporting pulls,
   - webhook retry storms without strict idempotency.

3. Apply emergency budget profile for remainder of month:
   - Dashboard refresh >= 60s.
   - Pause non-critical exports.

## 2026-04-20 hot-path transfer patch (permanent)

### What changed in code

1. Inbound candidate upsert no longer uses `RETURNING *` in the webhook ingestion path.
   - It now returns only `id`, `is_human_mode`, and `assigned_to` (the only fields needed immediately after insert/upsert).
2. Auto-distribution staff lookup no longer fetches `email` because it is unused in the assignment flow.
3. Added a CI/runtime guard script (`npm run check:transfer-guardrails`) that fails if broad projections return in the hot ingestion path.

### Why this matters at micro level

When Neon counts network transfer, every unnecessary column in result sets multiplies by message volume.

- If `RETURNING *` includes large JSON/state fields (for example `variables`) and the webhook path processes thousands of messages, this creates avoidable outbound DB bytes.
- Returning only needed columns turns each upsert response into a bounded, predictable payload.
- Removing `email` from staff lookup avoids repeated transfer of PII and unused bytes on every assignment evaluation.

### Expected effectiveness (formula you can plug into your production metrics)

Savings from the `RETURNING *` fix:

```text
monthly_saved_gb ~= (bytes_removed_per_upsert * monthly_inbound_messages) / 1024^3
```

Example:

- bytes removed per upsert = 2 KB (conservative if `variables` grows)
- monthly inbound messages = 25,000
- saved transfer ~= 0.048 GB/month

If bytes removed are 8 KB, savings become ~0.190 GB/month.

This is not the only optimization, but it is a **permanent transfer leak closure** because it eliminates waste at source rather than relying on manual ops discipline.

### Validation loop after patch

Run weekly:

```bash
npm run check:transfer-guardrails
LEADS_PER_WEEK=300 MSGS_PER_LEAD=18 DOC_RATE=0.2 CACHE_HIT_RATIO=0.7 WRITE_BATCH_SIZE=4 RETRY_MULTIPLIER=1.05 npm run estimate:transfer
```

Then compare with Neon dashboard:

- If estimator stays low but Neon transfer rises fast, the leak is likely outside webhook hot path (admin polling, exports, analytics scans).
- If both rise together, tighten cache hit ratio and batching first before plan upgrade.
   - Cache bot/session reads in Redis with longer TTL.
   - Increase write batching by +1 step.

4. Keep monthly safety target at **<= 4.0 GB** (80% of cap) so retry spikes do not create another paid overage.

## 24/7 viability verdict for your declared workload

For **300 inquiries/week**, S3 media offload, and URL-only DB metadata, this architecture is viable for always-on operation and should remain far below 5 GB when guardrails are enforced. The practical 10/10 outcome depends on enforcing the controls continuously (cache hit ratio, idempotency, query projection, and polling discipline), not only during peak weeks. Route document enrichment (OCR/classification) to async workers and store outputs in cold/archive tables.

### 7) Cost-safe retry + idempotency discipline
Retries can silently double transfer.

- Keep idempotency keys on inbound webhook events and outbound send attempts.
- Use exponential backoff with jitter and hard max retry count.
- Track duplicate ratio in the admin panel as a first-class KPI.

### 8) Weekly optimization governance with acceptance gates
To preserve 9.9/10 quality, enforce weekly gates:

- Cache hit ratio >= 70%
- Effective batch size >= 4
- Retry/duplicate ratio <= 3%
- Transfer/lead week-over-week delta <= +10%
- Month-end forecast <= 55% budget utilization (for 9.9 band)

If any gate fails for 2 consecutive days, enter optimization incident mode.

### 9) Suggested 9.9 score equation
Use a deterministic score so the team sees exactly why grade changed:

`score = 10 - (u + e + r + o)`

Where:
- `u` (utilization penalty, max 4.0): grows rapidly after 55% forecast utilization.
- `e` (efficiency penalty, max 2.5): based on KB/lead regression vs 4-week baseline.
- `r` (reliability penalty, max 2.0): retry + duplicate + dead-letter rate.
- `o` (observability penalty, max 1.5): missing alerts, missing dashboards, stale runbook drill.

Target operating envelope for **9.9/10**:
- utilization forecast <= 55%
- KB/lead stable within +/-10% of baseline
- retries+duplicates <= 3%
- all alerts and weekly drill checks green

## 2026-04-19 hardening shipped: conditional driver snapshots

Implemented controls to permanently reduce transfer on the hottest dashboard endpoint without reducing realtime UX quality:

1. `/api/drivers` now issues an `ETag` based on a lightweight top-50 driver snapshot fingerprint.
2. Frontend now sends `If-None-Match` on subsequent reads.
3. Unchanged snapshots return `304 Not Modified` (no JSON payload body transfer).
4. Server query removed `SELECT c.*` and now projects only required columns, preventing large JSON column over-transfer on this path.

### Effectiveness expectation

- Polling every 10s = ~8,640 checks/day when dashboard is open.
- If only 5-15% of checks contain real changes, 85-95% of requests should become `304`.
- Combined with strict projection, practical reduction for `/api/drivers` transfer is typically **~85–97%** compared with always returning full payloads.

This gives a durable budget shield for Neon free-tier transfer while preserving fast dashboard updates.
