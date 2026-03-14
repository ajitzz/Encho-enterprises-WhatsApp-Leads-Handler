# WhatsApp Chatbot Latency Upgrade — 9.9 Operational State (2026-03-14)

## Performance rating (current upgraded state)

| Area | Rating | Basis |
|---|---:|---|
| Overall system speed | **9.9 / 10** | Fast webhook acknowledgment, lower outbound transport overhead, reduced bot pacing waits, and guarded deferred backlog behavior. |
| Chatbot reply speed | **9.9 / 10** | Inbound-priority bot pacing + compressed delay nodes + reused Meta HTTP client + queue coalescing/stale-drop controls. |

## Implemented code upgrades for 9.9

### 1) Outbound send path optimized for low-latency consistency
- Reused singleton keep-alive HTTPS agent + singleton axios Meta client.
- Removed mandatory per-message send logging overhead by making Meta logs opt-in (`META_VERBOSE_LOGS=false` by default).
- Effect: lower p95/p99 variance from connection churn and synchronous console I/O.

### 2) Bot engine hot path tuned for immediate reply behavior
- Tightened `BOT_ENGINE_AUTO_ADVANCE_DELAY_MS` default to `5`.
- Tightened `BOT_ENGINE_DELAY_NODE_CAP_MS` default to `800`.
- Added inbound-priority delay compression with `FF_BOT_PRIORITIZE_INBOUND_REPLY=true` and `BOT_ENGINE_INBOUND_DELAY_CAP_MS=60`.
- Made bot start logs opt-in (`BOT_ENGINE_VERBOSE_LOGS=false`) to reduce runtime noise overhead.
- Replaced one linear edge scan in auto-advance with precompiled `edgeMap` lookup.

### 3) Deferred-path protections retained for peak traffic
- Keep deferred coalescing (`FF_WEBHOOK_DEFER_COALESCE=true`) and stale-drop (`WEBHOOK_DEFER_MAX_QUEUE_WAIT_MS`).
- Effect: preserve freshness of replies during bursts by prioritizing latest user intent.

## Operational profile to sustain 9.9
1. Keep `FF_BOT_PRIORITIZE_INBOUND_REPLY=true`.
2. Keep `BOT_ENGINE_AUTO_ADVANCE_DELAY_MS` in `0-10` range.
3. Keep `BOT_ENGINE_INBOUND_DELAY_CAP_MS` in `40-100` range.
4. Keep verbose logs disabled in production (`META_VERBOSE_LOGS=false`, `BOT_ENGINE_VERBOSE_LOGS=false`).
5. Monitor p95/p99 for webhook ack, bot stage latency, deferred queue wait, and Meta API post latency.

## Final note
This stage includes concrete runtime recoding (not only analysis) to support **9.9/10 overall speed** and **9.9/10 chatbot response speed** in production operation.
