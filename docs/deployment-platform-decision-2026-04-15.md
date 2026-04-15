# Deployment Platform Decision Note — 2026-04-15

## Context

Vercel Hobby usage was paused due to exceeding **Fluid Provisioned Memory** and **Fluid Active CPU** limits while request and invocation counts remained below cap.

## What the screenshot indicates

- The service pause is primarily compute-resource-driven, not traffic-count-driven.
- Overages shown:
  - Fluid Provisioned Memory: 1,067 GB-hrs / 360 GB-hrs.
  - Fluid Active CPU: 11h 25m / 4h.
- Edge Requests and Function Invocations were still below 1M in the captured period.

## Code-level contributors already visible in this repo

1. **Queue processing polling from browsers every 10 seconds**.
   - This can multiply server executions with each active dashboard session.
2. **High-frequency status polling paths and streaming refresh behavior** can add continuous background compute.
3. Existing internal performance notes already flag these exact serverless cost amplifiers and recommend moving to single-producer cron/queue patterns.

## Decision rating

### Move from Vercel Hobby to Cloudflare Pages + Workers: **8/10 (good decision)**

Why this is strong:
- You remove Vercel Hobby's low monthly Fluid CPU/Memory ceiling that is currently pausing production.
- Cloudflare can be cost-effective for edge-first API + static frontend.
- Good fit for webhook + lightweight API gateways.

Why it is not 10/10 by itself:
- Cloudflare Workers Free has strict limits too (for example, request/day and CPU per invocation). If current backend patterns are unchanged, you can hit another ceiling.
- This backend currently relies on a Node/Express + long route surface; direct Worker migration is not "lift-and-shift" without adaptation.

## Better practical strategy (recommended)

1. **First fix architecture hotspots independent of platform**
   - Replace client-driven `/api/cron/process-queue` polling with one scheduler + queue worker model.
   - Keep webhook path minimal: validate -> persist -> enqueue -> ACK.
   - Reduce interval polling where push/event-driven options exist.

2. **Then choose hosting model by workload split**
   - **Frontend (Vite static):** Cloudflare Pages (excellent).
   - **API runtime options:**
     - Cloudflare Workers (best if you commit to edge-native/runtime-compatible refactor).
     - A small always-on Node host for API + Cloudflare for CDN/frontend (lowest migration risk).

3. **If rapid stabilization is priority**
   - Keep API on Node-compatible runtime initially.
   - Move frontend to Cloudflare Pages now.
   - Refactor heavy/background jobs to queues before full Worker-native API migration.

## Suggested migration phases

### Phase 0 (this week)
- Eliminate high-frequency browser-triggered queue processing.
- Add rate limits/debouncing/backoff to noisy dashboard polling endpoints.

### Phase 1
- Deploy frontend to Cloudflare Pages.
- Keep backend on current Node runtime or move to a low-cost always-on Node provider.

### Phase 2
- Move background/long work to managed queue workers.
- Add strict idempotency keys for webhook fanout safety.

### Phase 3
- Migrate selected API routes to Cloudflare Workers/Pages Functions once runtime compatibility and latency/cost targets are proven.

## Bottom line

Your instinct is correct: changing from Vercel Hobby can remove the immediate pause risk. But the **highest-ROI fix is architectural first, platform second**. If you only change provider without reducing current polling/background patterns, similar limit pressure can reappear.
