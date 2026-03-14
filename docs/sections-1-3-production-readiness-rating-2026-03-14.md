# WhatsApp Chatbot Latency Micro-Analysis + 9.9 Upgrade Plan (2026-03-14)

## Executive rating (current stage)

| Area | Current rating | Why not 9.9 yet |
|---|---:|---|
| Overall system performance/response speed | **9.2 / 10** | Good guardrails and release quality, but runtime still has avoidable per-message cost in bot path and network send path. |
| Chatbot reply speed (customer-perceived) | **8.9 / 10** | Reply latency still sensitive to bot-node pacing, deferred queue pressure, and outbound provider call overhead. |

## Deep micro-analysis (hot path)

### 1) Outbound WhatsApp send path had avoidable client setup overhead
- `sendToMeta` relies on `getMetaClient` for every outbound message.
- Creating a new HTTP client/agent per call increases connection churn and hurts p95/p99 under burst traffic.
- **Upgrade applied:** switched to a reusable keep-alive axios client + shared HTTPS agent with socket pooling.

### 2) Bot engine pacing had built-in wait costs
- Auto-advance and delay-node behavior directly affects customer-visible response speed in multi-node flows.
- Existing runtime now uses env-driven low-latency caps:
  - `BOT_ENGINE_AUTO_ADVANCE_DELAY_MS`
  - `BOT_ENGINE_DELAY_NODE_CAP_MS`

### 3) Deferred queue behavior is key for spike windows
- When backpressure/defer is active, stale queued jobs can delay relevant latest replies.
- Existing runtime already includes:
  - deferred coalescing (`FF_WEBHOOK_DEFER_COALESCE`),
  - stale drop (`WEBHOOK_DEFER_MAX_QUEUE_WAIT_MS`).

## What was implemented now
1. **Meta API client reuse optimization** in `server.js`:
   - Singleton keep-alive HTTPS agent.
   - Singleton axios client reused across sends.
   - Auth header refresh-safe update if token changes.
2. **Operational guidance retained** for bot/defer tuning through envs in `.env.example`.

## Targeting 9.9: exact upgrade checklist

### Phase A (immediate, production-safe tuning)
1. Set `BOT_ENGINE_AUTO_ADVANCE_DELAY_MS=0~20` for low-latency conversations (use canary first).
2. Set `BOT_ENGINE_DELAY_NODE_CAP_MS=400~800` unless a business flow truly requires longer waits.
3. Keep `FF_WEBHOOK_DEFER_COALESCE=true`.
4. Tune `WEBHOOK_DEFER_MAX_QUEUE_WAIT_MS` to ~`5000-10000` in high-volume tenants.

### Phase B (observability to enforce 9.9)
5. Track and alarm on:
   - webhook ack p95/p99,
   - bot stage duration p95/p99,
   - deferred queue wait p95/p99,
   - outbound Meta API post latency p95/p99.
6. Add a hard SLO gate in release evidence: fail rollout if chatbot reply p95 regresses beyond threshold.

### Phase C (if still <9.9 under peak)
7. Persist bot graph in process memory (already done) and add tenant-aware warmed snapshots if tenant-specific configs become heavy.
8. Separate outbound sender workers for non-urgent bulk flows so chatbot sends are priority class.
9. Add synthetic load test for webhook->bot->send path using peak-like concurrency before each major release.

## Final recommendation
- Current stack is strong but **not yet 9.9 proven** for chatbot speed in all peak windows.
- With the applied outbound client reuse + existing defer controls + stricter SLO gating, this can be upgraded to **9.9-level production confidence**.
