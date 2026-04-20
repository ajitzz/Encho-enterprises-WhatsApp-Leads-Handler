# WhatsApp Real-Time Response & Capture Remediation (2026-04-11)

## Objective
Ensure inbound customer WhatsApp messages are:
1) captured reliably in software, and
2) responded to by bot with minimal delay.

## Root causes observed
1. **Post-response background processing is enabled by default** in webhook flows. In serverless runtimes, work after HTTP response is not always guaranteed to finish, causing delayed or dropped bot replies and partial capture.
2. **Idempotency race window** exists when two webhook deliveries with same `whatsapp_message_id` arrive close together; one may pass pre-check before insert.

## Implemented hardening
- Disabled post-response deferral by default on serverless platforms (`VERCEL` / Lambda detection), while keeping override via env flag.
- Made inbound message insert idempotent at DB write point via `ON CONFLICT (whatsapp_message_id) DO NOTHING RETURNING id`.
- Short-circuited processing when insert returns no row (treated as duplicate), preventing duplicate bot execution and extra DB work.

## Practical impact
- **Reliability:** Higher probability inbound message + bot step complete in one invocation on Vercel.
- **Latency:** ACK may be slightly slower when processing synchronously, but end-user bot reply reliability improves.
- **Efficiency:** Fewer duplicate writes and duplicate bot runs under webhook retries/races.

## Recommended production settings
- `FF_WEBHOOK_DEFER_POST_RESPONSE=false` (or leave unset with current serverless-aware default).
- Keep bot engine timeout budget strict (`BOT_ENGINE_HARD_TIMEOUT_MS`) and avoid heavy sync operations before bot send.
- If sustained high load appears, move bot execution to durable queue workers (BullMQ/SQS) and keep webhook path to: validate -> persist -> enqueue -> ACK.

## Reality check
Absolute "zero-delay" is not realistic due to WhatsApp network and provider delivery latency. Realistic target:
- webhook ack < 1s p95,
- first bot reply dispatch in ~1-2s p95 for simple text paths,
- durable capture exactly-once semantics via DB idempotency.
