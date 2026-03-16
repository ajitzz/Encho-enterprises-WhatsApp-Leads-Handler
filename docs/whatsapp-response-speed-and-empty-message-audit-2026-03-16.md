# WhatsApp Response-Speed + Empty-Message Audit (2026-03-16)

## Scope
- Backend webhook ingestion flow (`/api/webhook` and bot engine execution path).
- Outbound message sending path (`sendToMeta`, `/api/drivers/:id/messages`, scheduler sends).
- UI/API integration behavior that affects perceived response speed and incident triage.

## Executive checklist (issues + solutions)

### Solution cycle status update (implemented in current cycle)
- ✅ Outbound payload validation now blocks empty text and malformed interactive payloads before Meta send.
- ✅ Interactive payload validation now enforces non-empty body + button/list row integrity to prevent blank auto-messages.
- ✅ Bot engine now falls back to safe text when interactive payload is blocked, reducing dead-end chat states.
- ✅ `/api/drivers/:id/messages` now rejects invalid text-only requests with HTTP 400.
- ✅ Outbound message persistence now records `blocked_validation` instead of incorrectly marking blocked sends as `sent`.
- ✅ Outbound sends now persist Meta `messages[0].id` into `candidate_messages.whatsapp_message_id` when available.
- ✅ Frontend API wrapper now handles 204/empty-body responses without JSON parse crashes.
- ✅ Frontend polling now logs repeated failures (instead of silent swallow), improving triage.

### 1) Empty outbound message can be marked as "sent" in DB
- **Symptom**: Team sees message rows in chat history although Meta never received them.
- **Evidence**:
  - `sendToMeta` silently returns when text body is blank/whitespace (`return;`), not an error.
  - Caller then unconditionally inserts `candidate_messages` with status `sent`.
- **Risk**: False audit trail, confusion, repeated retries, and "ghost/empty message" incidents.
- **Fix**:
  1. Make `sendToMeta` return a structured result (`{ delivered: boolean, reason?: string }`) and never silent-return.
  2. Reject invalid payloads at API boundary (`/drivers/:id/messages`) with HTTP 400.
  3. Insert DB status as `blocked_validation` or `failed_validation` instead of `sent` when body is empty.

### 2) No input validation in `/drivers/:id/messages` for empty text when no media
- **Symptom**: Agent can submit empty text payload and trigger invalid send flow.
- **Evidence**:
  - Route takes `{ text, mediaUrl, mediaType }` and creates `payload` directly without validating `text` for text-only sends.
- **Risk**: Empty-message attempts, noisy logs, inconsistent frontend state.
- **Fix**:
  - Validate request with rules:
    - `text` required and non-blank when `mediaUrl` is absent.
    - cap text length for WhatsApp compliance.
    - allow empty `text` only when media payload is valid.

### 3) Interactive payload guard has logic bug for button type filter
- **Symptom**: Malformed interactive payloads may slip through guard checks.
- **Evidence**:
  - Guard checks `i.type === 'button'` and then `!['location_request_message', 'product_list'].includes(i.type)` in same branch; exclusion list can never match because `i.type` is already `'button'`.
- **Risk**: Invalid payload handling is not as intended; harder to reason about edge cases.
- **Fix**:
  - Split validation by interactive subtype with explicit per-type schema guards.

### 4) Webhook processing still executes heavy bot work in request lifecycle by default config
- **Symptom**: Ingest path can consume worker time under load and increase tail latency.
- **Evidence**:
  - `FF_WEBHOOK_DEFER_POST_RESPONSE` defaults to `false`.
  - Legacy webhook path awaits `processPromise` unless defer flag is enabled.
- **Risk**: Throughput degradation during spikes, risk of Meta retries/timeouts in stressed environments.
- **Fix**:
  1. Use modular lead-ingestion path with timeout guard/defer features for production tenants.
  2. Set defer/ack timeout guards on by default for high-traffic deployments.
  3. Move bot execution to queue worker for deterministic latency.

### 5) Legacy and module ingestion paths can diverge in behavior
- **Symptom**: Different tenants can experience different latency and dedupe behavior.
- **Evidence**:
  - Legacy path in `server.js` and module path in `backend/modules/lead-ingestion/service.js` both active behind flags.
- **Risk**: Hard-to-reproduce incidents and inconsistent SLA.
- **Fix**:
  - Complete migration to module path and freeze legacy path to emergency fallback only.

### 6) Polling-based UI updates every 5 seconds hide real latency + may feel slow
- **Symptom**: Agent perceives delayed responses despite backend success.
- **Evidence**:
  - `subscribeToUpdates` polls every 5000ms.
- **Risk**: Poor UX and delayed incident detection in dashboard.
- **Fix**:
  - Move to websocket/SSE updates; keep polling only as fallback.

### 7) Silent catch in polling suppresses operational errors
- **Symptom**: Update failures are invisible to operators.
- **Evidence**:
  - `catch(e) {}` in `subscribeToUpdates` swallows all fetch errors.
- **Risk**: Hidden outages; no signal when chat sync breaks.
- **Fix**:
  - Emit telemetry and trigger UI toast after thresholded consecutive failures.

### 8) API client assumes JSON response for all success codes
- **Symptom**: Endpoints returning empty body can throw parse errors in client.
- **Evidence**:
  - `apiRequest` always calls `response.json()`.
- **Risk**: False-negative frontend errors and retried user actions.
- **Fix**:
  - Parse based on `content-type`; support `204 No Content` and empty success body.

### 9) LocalStorage token storage increases blast radius of XSS
- **Symptom**: Bearer token persisted in browser storage.
- **Evidence**:
  - Auth token loaded/saved to `localStorage`.
- **Risk**: Session theft if XSS occurs.
- **Fix**:
  - Prefer HTTP-only secure cookies (same-site) and short-lived access tokens.

### 10) Bot engine loop can consume significant synchronous compute per inbound
- **Symptom**: Long flows or many auto-advances can increase response work.
- **Evidence**:
  - `while` traversal with message sends per node and optional delays in same engine execution.
- **Risk**: Latency spikes and reduced concurrency.
- **Fix**:
  - Apply strict per-message node budget, queue follow-up steps asynchronously, and precompile + cache graph transitions.

### 11) Observable gap: no explicit outbound message correlation ID persisted
- **Symptom**: Hard to reconcile Meta send with internal DB rows during incident analysis.
- **Evidence**:
  - Outbound inserts store status + text/type but not provider response ID at send points.
- **Risk**: Slow root-cause analysis for missing/duplicate messages.
- **Fix**:
  - Persist Meta response `messages[0].id` and request correlation ID on every outbound send.

### 12) Missing end-to-end automated tests for empty-message regression
- **Symptom**: Empty-message behavior can regress silently.
- **Evidence**:
  - Existing tests focus migration governance / critical flows; no direct outbound-empty guard test coverage.
- **Risk**: Reintroduction of production bug after refactor.
- **Fix**:
  - Add contract tests:
    - reject empty text-only sends,
    - ensure DB status is not `sent` when blocked,
    - ensure webhook ack time remains under configured budget.


### 13) Repeating 500s when DB connection is unavailable (observed on `/api/bot/settings`, `/api/debug/status`, `/api/cron/process-queue`)
- **Symptom**: Console shows continuous `500` errors and dashboard appears disconnected.
- **Evidence**:
  - UI heartbeats poll queue endpoint every 10s and monitor polls status endpoint.
  - Legacy handlers return hard `500` on infra outages, causing noisy retry loops.
- **Risk**: Operator panic, unstable UX, and noisy logs while infra is recovering.
- **Fix (implemented)**:
  1. Add recoverable infrastructure error classifier (`database not initialized`, connection/refused/timeout codes).
  2. Return a **degraded 200 response** for status/queue diagnostics to avoid hard-fail loops while still signaling degraded mode.
  3. Add degraded fallback for bot settings so dashboard can still render with default graph.
  4. Increase heartbeat observability by warning after repeated failures.

### 14) Postgres pool hard-fails boot when only PGHOST-style envs exist
- **Symptom**: Service fails to initialize DB pool in some deployments with split Postgres env variables.
- **Evidence**:
  - Pool init was connection-string-first only (`DATABASE_URL`/`POSTGRES_URL`).
- **Risk**: Startup instability and avoidable outage during config transitions.
- **Fix (implemented)**:
  - Add `buildPoolConfig()` fallback to `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` with controlled SSL defaults.


## Prioritized implementation plan

### P0 (immediate)
1. Validate `/api/drivers/:id/messages` request schema for text/media rules.
2. Refactor `sendToMeta` to explicit result semantics (no silent success).
3. Prevent insertion of `sent` rows when send is blocked/invalid.
4. Add metrics: `outbound_blocked_validation`, `outbound_meta_failures`, `outbound_sent`.

### P1 (next sprint)
1. Move high-traffic tenants to module ingestion path and enable ack/defer guards.
2. Add outbound provider message-id persistence.
3. Replace polling with SSE/websocket in agent dashboard.

### P2 (hardening)
1. Deprecate legacy ingestion path.
2. Move auth away from localStorage tokens.
3. Add synthetic latency + chaos tests in CI.

## Quick production runbook checks
- Track p50/p95/p99 for:
  - webhook ack latency,
  - bot-engine execution time,
  - outbound send success/blocked/fail ratio.
- Alert when:
  - `blocked_validation > 0.5%` for 10m,
  - webhook p95 > 1.2s,
  - deferred queue depth > 80% of max.
