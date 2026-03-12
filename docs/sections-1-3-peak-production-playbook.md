# Sections 1–3 Peak Production Playbook (WhatsApp Reply Speed)

## Objective
Reach near-peak production readiness in **Section 1 (Architecture)**, **Section 2 (Contracts)**, and **Section 3 (Migration Execution)** with a strict focus on **very fast WhatsApp chatbot replies** under real traffic.

Target outcome:
- customer inbound message to first bot reply stays low-latency and predictable,
- no major regression in reliability while extracting modules,
- clear rollback safety when performance degrades.

---

## Current rating baseline (carry-forward)
- **Section 1:** 9.1/10 (still blocked by `server.js` orchestration concentration)
- **Section 2:** 9.6/10 (near-peak)
- **Section 3:** 9.4/10 (needs repeated canary evidence windows)

These baseline ratings are aligned with current assessment documents and should be re-scored after each hardening sprint.

---

## Section-by-section advanced methods

## 1) Section 1 — Architecture methods for direct reply speed

### Method 1.1: Hard split the webhook hot path into micro-stages
For `/api/webhook`, keep the synchronous request path to only:
1. payload verification,
2. deterministic dedupe key,
3. minimal lead/message persistence,
4. immediate bot dispatch trigger.

Everything else should move to async continuation (reporting sync, heavy enrichment, non-blocking projections).

**Why it matters:** removes avoidable work from reply-critical latency path.

### Method 1.2: Introduce latency budgets per stage (not only route-level)
Track p50/p95/p99 for:
- `dedupe_lookup`,
- `lead_upsert`,
- `inbound_insert`,
- `bot_engine`,
- `provider_send`.

Add SLO alerts per stage so a single slow stage cannot hide inside an acceptable route average.

### Method 1.3: `server.js` shrink plan with strangler facades
Extract one high-churn concern at a time behind module facades:
- lead-ingestion facade,
- bot-conversation facade,
- reminders-escalations facade.

Each extraction keeps contract parity with legacy behavior and supports instant fallback via flag.

### Method 1.4: Read/write DB path optimization for reply-critical flows
- Ensure index coverage on dedupe and latest-message lookups.
- Convert repeated queries into batched or cached reads where safe.
- Add query time guardrails (log + metric tags for query families).

### Method 1.5: Conversation execution budget control
Apply an execution time budget for bot flow traversal and safe fallback behavior when budget is hit:
- send concise fallback response,
- persist partial state safely,
- continue non-critical transitions asynchronously.

This prevents pathological flow graphs from delaying first reply.

---

## 2) Section 2 — Contract methods that improve speed through stability

### Method 2.1: Zero-ambiguity ingress validation
Every module ingress validates envelope + payload + schema version before business logic.
Reject invalid payloads early to avoid expensive downstream retries.

### Method 2.2: Strict idempotency keys on all message-producing paths
- Inbound dedupe key from provider message id + channel.
- Outbound idempotency key for `(leadId, templateId, attempt)`.

This avoids duplicate work under retry storms and reduces queue congestion.

### Method 2.3: Backward compatibility adapters during migration windows
Support N and N-1 contract versions to avoid rollout stalls and emergency hotfix drift.

### Method 2.4: Error contract normalization
Normalize module errors into stable categories:
`validation`, `dependency`, `timeout`, `conflict`, `not_found`, `internal`.

This allows faster retry policies (retry only retriable categories), reducing latency waste.

### Method 2.5: Contract golden tests + producer/consumer tests in CI
Enforce payload-shape and mapper compatibility tests so contract drift is caught before production.

---

## 3) Section 3 — Execution and rollout methods for safe performance gains

### Method 3.1: Canary with performance SLO gates (not just functional gates)
Promotion requires:
- webhook p95 <= baseline + 5% during canary,
- stable or improved bot reply success,
- no 5xx increase on critical routes,
- queue lag within agreed ceiling.

### Method 3.2: Shadow mode parity with differential telemetry
Before serving production traffic from extracted modules:
- run shadow comparisons (`legacyResult` vs `moduleResult`),
- log parity mismatches,
- block promotion until mismatch rate is below threshold.

### Method 3.3: Auto kill-switch policy
Implement threshold-based auto-disable for canary path on:
- p95 spike,
- error-ratio spike,
- queue lag spike.

Fast rollback protects user reply experience.

### Method 3.4: Multi-window evidence, not one-time evidence
Require at least 3 canary windows across different traffic periods (low, medium, peak), with trend analysis.

### Method 3.5: Performance regression budget per PR
Every PR that touches critical flows must provide:
- expected latency impact,
- measured before/after,
- rollback command evidence,
- test evidence.

---

## Priority roadmap (2 sprint plan)

## Sprint A (Section 1 heavy)
1. Complete one additional extraction from `server.js` hot path to module facade.
2. Add stage-level latency metrics and dashboards for webhook + bot path.
3. Move any remaining non-critical side effects off the synchronous reply path.

## Sprint B (Section 3 heavy)
1. Run 2–3 additional canary windows for ingestion/reminders.
2. Enforce SLO-based promotion gate in release process.
3. Drill rollback and capture time-to-recovery evidence.

Section 2 remains in maintenance mode with strict contract/test governance.

---

## Definition of near-peak production readiness for reply speed
Treat Sections 1–3 as ready to advance only when all are true:
1. Re-scored ratings are consistently >= 9.5 in two consecutive review cycles.
2. Webhook and bot reply p95 remain within non-regression target during repeated canaries.
3. Queue lag and failure ratio remain stable under peak-like traffic.
4. Rollback is proven in staging and one production canary incident simulation.
5. Critical integration and governance gates pass continuously in CI.

If any one of the above fails, remain in Sections 1–3 and continue hardening.
