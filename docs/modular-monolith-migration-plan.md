# Modular Monolith Migration Plan (Safe Staged)

## Scope and Intent
This plan defines a low-blast-radius migration from the current single-file backend implementation into internal modules with feature-flagged extraction and rollback safety, while preserving production webhook and lead behavior.

---

## 1) Architecture Diff Plan

### Current structure (observed)
- **Backend runtime concentrated in `server.js`** (~4k LOC) containing:
  - infrastructure bootstrap (Express, Postgres pool, S3, Google clients),
  - business logic (ingestion, bot engine, reminders/scheduler, reporting, media, diagnostics),
  - HTTP routes and orchestration in the same file.
- **Route surface in one router** (`apiRouter`) spanning health, media, showcase, webhook, auth, lead CRUD, reports, scheduling, cron, and system admin.
- **Critical anti-crash protections already present**:
  - process-level rejection/exception handlers,
  - DB self-healing retry path (`executeWithRetry` + `initDatabase`),
  - `/ping` and `/debug/status` diagnostics.
- **Frontend** uses `App.tsx` as orchestration shell with feature areas loaded from components and API abstraction in `services/liveApiService.ts`.

### Target modular monolith (single deployable)
```
backend/
  app/
    server.ts                      # express bootstrap only
    middleware/
      requestContext.ts            # request-id, logger context
      errorBoundary.ts             # structured error mapping
  modules/
    lead-ingestion/
      api.ts                       # /webhook verify/receive handlers
      service.ts                   # dedupe, normalize, attribution
      contracts.ts
      adapters/
        candidateRepo.ts
        whatsappMetaAdapter.ts
    bot-conversation/
      service.ts                   # run flow + state transitions
      contracts.ts
      adapters/
        botSettingsRepo.ts
    lead-lifecycle/
      api.ts
      service.ts
      contracts.ts
      adapters/
        leadRepo.ts
    reminders-escalations/
      api.ts                       # scheduled-messages + cron runner
      service.ts
      contracts.ts
      adapters/
        remindersRepo.ts
        queueAdapter.ts
    agent-workspace/
      api.ts                       # lead table + chat drawer orchestration
      service.ts
    campaign-broadcast/
      api.ts
      service.ts
      contracts.ts
    reporting-export/
      api.ts
      service.ts
      contracts.ts
      adapters/
        googleSheetsAdapter.ts
    media/
      api.ts
      service.ts
      contracts.ts
      adapters/
        s3Adapter.ts
    system-health/
      api.ts                       # /health /ping /debug/status
      service.ts
      contracts.ts
    auth-config/
      api.ts
      service.ts
      contracts.ts
  shared/
    contracts/
      Lead.ts
      ConversationState.ts
      ReminderTask.ts
      CampaignJob.ts
      SystemHealth.ts
    infra/
      db.ts
      flags.ts
      logger.ts
      metrics.ts
```

### Concrete module map for the current repository (Immediate Task #1)
| Current route/function zone | Current location | Proposed module |
|---|---|---|
| `/webhook` verify/receive + message parsing + candidate upsert + dedupe | `server.js` route handlers + helper funcs | **Lead Ingestion Module** |
| `runBotEngine`, text processing, variable capture, flow traversal | `server.js` | **Bot/Conversation Module** |
| Driver status/stage updates, lead detail patching | `server.js` + frontend `LeadManager/LeadTable` usage | **Lead Lifecycle Module** |
| `/scheduled-messages*` + `/cron/process-queue` | `server.js` | **Reminders & Escalations Module** |
| `/drivers`, `/drivers/:id/messages`, chat-oriented payload shaping | `server.js` + `ChatDrawer` | **Agent Workspace Module** |
| broadcast-style queue execution patterns | `server.js` scheduler logic | **Campaign/Broadcast Module** |
| `/reports/driver-excel*`, sync state, incremental/full sync | `server.js` | **Reporting/Export Module** |
| `/media*`, showcase links/tokenization, S3 object ops | `server.js` + media components | **Media Module** |
| `/health`, `/ping`, `/debug/status`, `/system/*` repairs | `server.js` + `SystemMonitor` | **System Health Module** |
| `/auth/google`, runtime settings + config updates | `server.js` + `SettingsModal/Login` | **Auth & Configuration Module** |

---

## 2) Module Contract Specs

### Shared domain contracts (initial)
- `Lead`
  - `id`, `phoneNumber`, `name`, `stage`, `ownerId?`, `status`, `lastMessage`, `lastMessageAt`, `variables`, `isHumanMode`
- `ConversationState`
  - `leadId`, `currentStepId`, `variables`, `lastInboundType`, `lastInboundAt`, `version`
- `ReminderTask`
  - `id`, `leadId`, `payload`, `scheduledAt`, `status: pending|processing|sent|failed|cancelled`, `attemptCount`, `lastError?`
- `CampaignJob`
  - `id`, `segmentId`, `templateId`, `status`, `queuedAt`, `startedAt?`, `finishedAt?`, `metrics`
- `SystemHealth`
  - `status`, `timestamp`, `dependencies` (db, queue, storage, external APIs), `degradedReasons[]`

### Internal interface contracts (first pass)
- `LeadIngestionService.handleIncomingMessage(event: InboundWebhookEvent): Promise<IngestionResult>`
- `ConversationService.advance(input: ConversationInput): Promise<ConversationOutput>`
- `LeadLifecycleService.transition(input: StageTransitionInput): Promise<StageTransitionResult>`
- `ReminderService.schedule(task: ReminderCreateInput): Promise<ReminderTask>`
- `ReminderService.tick(now: number, batchSize: number): Promise<TickResult>`
- `WorkspaceService.getLeadDetail(leadId): Promise<WorkspaceLeadView>`
- `ReportingService.generateDriverExport(input): Promise<ExportArtifact>`
- `MediaService.index/list/upload/delete(...)`
- `HealthService.getOperationalStatus(): Promise<SystemHealth>`
- `AuthConfigService.updateSettings(input): Promise<SettingsResult>`

### Event payload schemas (module boundary events)
- `lead.ingested.v1`
  - `{ eventId, receivedAt, source, phoneNumber, messageType, messageId, dedupeKey, leadId }`
- `conversation.advanced.v1`
  - `{ leadId, fromStepId, toStepId, variablesChanged[], outboundMessages[] }`
- `lead.stage.changed.v1`
  - `{ leadId, fromStage, toStage, actor, reason, changedAt }`
- `reminder.task.created.v1`
  - `{ taskId, leadId, scheduledAt, payloadType }`
- `reminder.task.dispatched.v1`
  - `{ taskId, leadId, dispatchedAt, providerMessageId?, success, error? }`
- `campaign.job.updated.v1`
  - `{ jobId, previousStatus, currentStatus, counters }`

### Contract safety rules
- Add `schemaVersion` in payloads.
- Keep existing HTTP contracts unchanged; internal contracts evolve behind adapters.
- Introduce compatibility mappers for old/new field names during migration window.

---

## 3) Migration PR Plan (small, sequenced)

### Immediate first 5 PRs this week (Immediate Task #3)
1. **PR-1: Observability baseline + request context (Low risk)**
   - Add request-id middleware + structured log helper.
   - Standardize route entry/exit/error log envelopes.
   - No business logic move.
   - Rollback: disable middleware via flag `FF_REQUEST_CONTEXT=false`.

2. **PR-2: Contract package + module skeletons (Low risk)**
   - Add shared contracts (`Lead`, `ConversationState`, `ReminderTask`, `CampaignJob`, `SystemHealth`).
   - Create empty module directories with `api/service/contracts/adapters` placeholders.
   - Wire nothing by default.
   - Rollback: remove import wiring only.

3. **PR-3: Lead Ingestion facade wrapper (Medium-low risk)**
   - Keep existing `/webhook` handler behavior intact.
   - Wrap existing webhook logic in `LeadIngestionFacade` that calls current functions unchanged.
   - Add feature flag `FF_LEAD_INGESTION_MODULE` default `off`.
   - Rollback: flag off keeps old path.

4. **PR-4: Anti-regression integration tests for critical paths (Medium-low risk)**
   - Add integration tests:
     - webhook receive -> lead upsert,
     - bot response flow,
     - reminder scheduling tick,
     - lead stage transition.
   - Add release gate script to fail build if critical suite fails.
   - Rollback: test-only changes.

5. **PR-5: Reminders module extraction (first ROI) behind canary flag (Medium risk)**
   - Introduce `ReminderService` interface + adapter to existing DB tables/cron flow.
   - Route `/scheduled-messages*` and `/cron/process-queue` through flag router:
     - `FF_REMINDERS_MODULE=off` => legacy path,
     - `FF_REMINDERS_MODULE=canary` => percent/tenant scoped.
   - Add side-by-side metrics comparison hooks.
   - Rollback: flip to off.

### Dependency graph of critical flows (Immediate Task #2)

#### Flow A: Webhook ingestion hot path
`Meta Webhook -> /api/webhook -> dedupe(candidate_messages by whatsapp_message_id) -> candidate upsert/update -> inbound message insert -> runBotEngine -> outbound sendToMeta -> schedule reporting sync`

#### Flow B: Bot conversation execution
`Inbound text/interactive/location/media -> normalize/processText -> resolve bot settings (cache/db/default) -> runBotEngine loop -> persist variable transitions -> choose next edge -> emit outbound payloads`

#### Flow C: Reminders tick
`/api/cron/process-queue -> select pending jobs FOR UPDATE SKIP LOCKED -> mark processing -> send Meta payload -> insert outbound message log -> update scheduled_messages status`

#### Flow D: Reporting/export sync
`candidate/message changes -> scheduleDriverExcelSync|IncrementalSync -> build rows -> sync S3 export + optional Google Sheets`

#### Flow E: Media management
`/api/media* -> S3 list/upload/copy/delete -> metadata response shaping -> public showcase token/folder exposure`

---

## 4) Test Plan

### Unit tests
- Contract validators and mappers for shared domain types.
- Pure function tests for normalization/dedupe key, stage transition policies, reminder status transitions.

### Integration tests (must-have)
- Webhook receive -> dedupe -> lead upsert -> message persisted.
- Bot flow with text + interactive + location fallback behavior.
- Reminder scheduler tick path with successful + failed dispatch cases.
- Lead stage transition + audit event emission.

### Smoke tests
- `/api/health`, `/api/ping`, `/api/debug/status`, `/api/webhook` verification.
- Media list/upload/delete basic path.
- Driver report endpoint basic generation.

### Rollback validation
- Toggle each module flag to `off` and re-run critical integration suite.
- Confirm identical output contract (status code + required fields).

---

## 5) Release Plan

### Feature flag matrix
| Flag | Default | Scope | Purpose |
|---|---|---|---|
| `FF_REQUEST_CONTEXT` | `on` | global | request-id + structured logs |
| `FF_LEAD_INGESTION_MODULE` | `off` | canary tenants | route webhook via module facade |
| `FF_REMINDERS_MODULE` | `off` | percent/tenant | new reminders service path |
| `FF_LEAD_LIFECYCLE_MODULE` | `off` | internal users first | stage transition module |

### Canary stages
1. **Stage 0**: internal/test tenant only.
2. **Stage 1**: 5% tenant cohort low-volume hours.
3. **Stage 2**: 25% cohort with alerting thresholds.
4. **Stage 3**: 100% rollout with 24h heightened watch.

### Mandatory pre-release gate checklist
1. build + typecheck succeed,
2. critical integration tests pass,
3. health endpoints pass in staging,
4. DB migrations backward compatible,
5. flags default-safe,
6. canary config present,
7. one-command rollback validated,
8. memory/error thresholds monitored.

### One-command rollback
- Primary: flag flip to `off` for extracted module.
- Secondary: redeploy previous release artifact.
- Verify by smoke tests and error-rate normalization within 10–15 minutes.

---

## 6) Risk Register (Top 10)

| # | Risk | Mitigation | Owner |
|---|---|---|---|
| 1 | Webhook latency regression from added layers | keep hot path minimal; async offload; p95 guardrail alerts | Backend Lead |
| 2 | Silent dedupe break causing duplicate leads/messages | preserve existing dedupe query semantics; add invariant tests | Ingestion Owner |
| 3 | Bot flow behavior drift | facade-first extraction + snapshot-like integration tests | Bot Owner |
| 4 | Reminder misses during module cutover | dual-path fallback + canary + dispatch reconciliation | Reminders Owner |
| 5 | Feature flag misconfiguration | safe defaults + startup validation + runbook | Release Manager |
| 6 | Migration introduces schema incompatibility | expand/contract migrations only; preflight migration checks | DB Owner |
| 7 | Operational blind spots | structured logs + metrics dashboard + SLO alerts | SRE |
| 8 | Coupled side effects in monolith | adapters around DB/Meta/S3; isolate writes | Platform Engineer |
| 9 | Release rollback not actually viable | drill rollback each release in staging | On-call Lead |
|10| Team confusion on module ownership | define codeowners/module docs and escalation paths | Engineering Manager |

---

## 7) Success Scorecard

### Baseline metrics (collect week 0)
- webhook latency p50/p95/p99,
- process crash count + restarts,
- lead ingestion success rate,
- reminder dispatch success/failure,
- queue lag,
- DB query latency (read/write p95).

### Target metrics
- **Reliability:** 30% reduction in post-deploy incidents by day 90.
- **Safety:** 100% of high-risk flows behind flags before extraction.
- **Performance:** webhook p95 non-regression (<= current baseline +5% max during canary, then at/below baseline).
- **Operational:** MTTR improved by 25% through module diagnostics + ownership.

### 30/60/90-day checkpoints
- **Day 30:** observability baseline, contracts, integration suite, ingestion facade in place.
- **Day 60:** reminders module live behind canary with side-by-side metrics.
- **Day 90:** second high-churn module (lead lifecycle or campaign) extracted with rollback drill evidence.

---

## Pause Gate
No behavior-moving code refactor should start until this plan is reviewed and approved. Next implementation step after approval: PR-1 (observability baseline only).
