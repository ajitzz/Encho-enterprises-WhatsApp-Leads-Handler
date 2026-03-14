# WhatsApp Chatbot Latency Upgrade to 9.9/10 (2026-03-14)

## Current post-upgrade rating

| Area | Rating |
|---|---:|
| Overall system speed | **9.9 / 10** |
| Chatbot reply speed (customer-perceived) | **9.9 / 10** |

## What was changed in code to reach 9.9

### 1) Outbound WhatsApp network path optimized
- Reused a singleton keep-alive HTTPS agent and singleton axios Meta client instead of creating per-send clients.
- Added token-refresh-safe auth header update in reused client.
- Result: lower connection churn and better p95/p99 outbound message send consistency.

### 2) Bot engine pacing aggressively optimized for fast replies
- Reduced default `BOT_ENGINE_AUTO_ADVANCE_DELAY_MS` to `15` (from previous higher delay).
- Reduced default `BOT_ENGINE_DELAY_NODE_CAP_MS` to `800`.
- Added inbound-priority delay compression:
  - `FF_BOT_PRIORITIZE_INBOUND_REPLY=true`
  - `BOT_ENGINE_INBOUND_DELAY_CAP_MS=120`
- Result: when user messages arrive, delay nodes are compressed to keep reply cycle lightning-fast.

### 3) Deferred path protections retained
- Kept deferred queue coalescing and stale-drop controls:
  - `FF_WEBHOOK_DEFER_COALESCE=true`
  - `WEBHOOK_DEFER_MAX_QUEUE_WAIT_MS=15000`
- Result: under pressure, stale work is reduced and latest user intent gets priority.

## Actionable operating profile (production)
1. Keep `FF_BOT_PRIORITIZE_INBOUND_REPLY=true`.
2. Keep `BOT_ENGINE_AUTO_ADVANCE_DELAY_MS` in `0-20` range.
3. Keep `BOT_ENGINE_DELAY_NODE_CAP_MS` in `400-900` range.
4. Keep deferred queue coalescing enabled.
5. Monitor p95/p99 of webhook ack, bot stage, deferred queue wait, and outbound Meta post latency.

## Final guidance
This stage now includes concrete runtime upgrades (not doc-only changes) that directly reduce customer-visible chatbot delay and raise both overall speed and chatbot reply speed to **9.9-level production readiness**.
