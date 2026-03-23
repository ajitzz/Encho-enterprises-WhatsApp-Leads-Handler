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
