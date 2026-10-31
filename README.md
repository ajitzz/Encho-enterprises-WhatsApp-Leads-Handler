# Encho Space — WhatsApp Enterprise Leads Automation Platform

<p align="center">
  <img src="docs/images/system_architecture_diagram.svg" alt="Encho System Architecture" width="100%" />
</p>

<p align="center">
  <a href="https://developers.facebook.com/docs/whatsapp/cloud-api"><img src="https://img.shields.io/badge/Meta_Cloud_API-v26.0-059669.svg?style=for-the-badge&logo=whatsapp" alt="Meta Cloud API" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-v20_LTS-0284c7.svg?style=for-the-badge&logo=node.js" alt="Node.js" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-18.2_TypeScript-6366f1.svg?style=for-the-badge&logo=react" alt="React 18" /></a>
  <a href="https://neon.tech"><img src="https://img.shields.io/badge/PostgreSQL-Neon_Serverless-d97706.svg?style=for-the-badge&logo=postgresql" alt="PostgreSQL Neon" /></a>
  <a href="https://upstash.com"><img src="https://img.shields.io/badge/Upstash-Redis_%26_QStash-ef4444.svg?style=for-the-badge&logo=redis" alt="Upstash Redis" /></a>
  <a href="https://aws.amazon.com/s3/"><img src="https://img.shields.io/badge/AWS-S3_Media_Storage-ff9900.svg?style=for-the-badge&logo=amazons3" alt="AWS S3" /></a>
  <a href="#-automated-testing--governance-evidence"><img src="https://img.shields.io/badge/Tests-50%2F50_Passing-10b981.svg?style=for-the-badge&logo=jest" alt="50 Tests Passed" /></a>
  <a href="#-automated-testing--governance-evidence"><img src="https://img.shields.io/badge/TypeScript-0_Errors-3b82f6.svg?style=for-the-badge&logo=typescript" alt="TypeScript Strict Pass" /></a>
</p>

---

## 📑 Table of Contents
1. [Executive Overview & Industrial Mission](#-executive-overview--industrial-mission)
2. [High-Level System Architecture](#-high-level-system-architecture)
3. [The Write-Behind Ingestion Pattern (Sub-50ms ACK)](#-the-write-behind-ingestion-pattern-sub-50ms-ack)
4. [Visual Bot Studio Canvas](#-visual-bot-studio-canvas)
5. [Global Keyword Intent Router & Multi-Asset Media Dispatcher](#-global-keyword-intent-router--multi-asset-media-dispatcher)
6. [Unified Staff CRM & Live Chat Workspace](#-unified-staff-crm--live-chat-workspace)
7. [Agent Collision Prevention & Real-Time Presence](#-agent-collision-prevention--real-time-presence)
8. [Lead Lifecycle & Multi-Tier SLA Governance](#-lead-lifecycle--multi-tier-sla-governance)
9. [Two-Way Google Sheets & Driver Excel Sync Engine](#-two-way-google-sheets--driver-excel-sync-engine)
10. [AWS S3 Media Library & Cloud Document Management](#-aws-s3-media-library--cloud-document-management)
11. [Complete REST & Webhook API Specification](#-complete-rest--webhook-api-specification)
12. [Relational Database Schema (System of Record)](#-relational-database-schema-system-of-record)
13. [Security, HMAC Verification & Meta Policy Compliance](#-security-hmac-verification--meta-policy-compliance)
14. [Complete Environment Configuration Dictionary](#-complete-environment-configuration-dictionary)
15. [Local Development & Quickstart Runbook](#-local-development--quickstart-runbook)
16. [Automated Testing & Governance Evidence](#-automated-testing--governance-evidence)
17. [Multi-Cloud Production Deployment Runbook](#-multi-cloud-production-deployment-runbook)
18. [Repository Directory Blueprint](#-repository-directory-blueprint)

---

## 🏛️ Executive Overview & Industrial Mission

**Encho Space** is an enterprise-scale conversational leads automation platform and CRM gateway designed to replace fragmented legacy lead software with a unified, high-availability architecture matching the operational rigor of **Salesforce Service Cloud**, **Twilio Studio**, and **Uber Fleet Systems**.

Modern high-volume lead pipelines (fleet hiring, real estate inquiries, e-commerce support) face three chronic failure points:
1. **Webhook Dropping Under Burst Traffic:** Meta requires a `200 OK` HTTP acknowledgment within 2 seconds. Synchronous database writes during marketing bursts cause 504 gateway timeouts, causing Meta to mark webhooks unhealthy and disable traffic.
2. **Brittle Bot Funnels:** Traditional bots force users through rigid linear question sequences. When customers text natural intent—such as *"send the property Number2"* or *"Property 2"*—linear bots break down or demand restart.
3. **Agent SLA Failure & Lead Neglect:** Leads sit unassigned in shared inboxes without deterministic timers, causing first-response times to balloon from minutes to days.

### How Encho Solves This
- **Sub-50ms Ingestion ACK:** A decoupled **Write-Behind** queue powered by **Upstash Redis FIFO** and **QStash** absorbs traffic spikes instantly.
- **Natural Language Intent Interruption:** A dedicated linguistic router (`botTriggerMatcher.js`) strips conversational noise (`"please"`, `"send"`, `"the"`, `"number"`) to resolve core semantic tokens (`["property", "2"]`), instantly jumping to the requested showcase node without breaking active button clicks.
- **Sequential Paced Media Packs:** Dispatches hero villa photos, floor plan graphics, and full PDF brochures with an automated **350ms pacing delay**, preventing WhatsApp's network from delivering heavy brochures ahead of hero imagery.
- **Enterprise Staff Portal & Multi-Level SLA Escalation:** Round-Robin auto-distribution, live WhatsApp 24-hour session countdown timers, 15-minute agent nudges, and 30-minute automatic manager reallocations guarantee zero leads are left behind.

---

## 🏗️ High-Level System Architecture

<p align="center">
  <img src="docs/images/system_architecture_diagram.svg" alt="System Architecture Diagram" width="100%" />
</p>

The platform is architected into four strictly decoupled tiers:

```
[ WhatsApp End-Users (2B+ Devices) ]
               │
               ▼  (Inbound HTTPS Webhook)
┌─────────────────────────────────────────────────────────┐
│ TIER 1: EDGE & REVERSE PROXY                            │
│ Cloudflare CDN / Workers / DDoS Protection / SSL        │
└──────────────────────────────┬──────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────┐
│ TIER 2: INGESTION & BUFFERING (Sub-50ms ACK)            │
│ • Express Gateway with HMAC SHA256 Signature Verify     │
│ • Inbound Redis FIFO Queue Shock Absorber (Upstash)     │
│ • Outbound Strict Schema Validator (whatsappPayload.js) │
└──────────────────────────────┬──────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────┐
│ TIER 3: INTELLIGENT BOT STUDIO & KEYWORD ROUTER         │
│ • botTriggerMatcher.js: NLP Normalizer & Filler Stripper│
│ • Linear Flow Interrupter & State Machine (server.ts)   │
│ • Sequential Multi-Asset Dispatcher (350ms Pacing Delay)│
│ • Meta Pre-approved Template Processor (HSM {{1}}, {{2}})│
└──────────────────────────────┬──────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────┐
│ TIER 4: PERSISTENCE & UNIFIED CRM WORKSPACE             │
│ • Neon Serverless PostgreSQL (Candidates, Messages, Logs│
│ • Staff Portal & Real-time Live Chat (React 18)         │
│ • AWS S3 Object Storage (Brochures, Licences, Media)    │
└─────────────────────────────────────────────────────────┘
```

---

## ⚡ The Write-Behind Ingestion Pattern (Sub-50ms ACK)

Meta's Cloud API enforces a strict SLA: if an inbound webhook delivery attempt exceeds 2,000ms, it is classified as a timeout and queued for exponential backoff retries. If consecutive retries fail, Meta auto-disables the webhook subscription.

Encho implements a FAANG-grade **Write-Behind Webhook Ingestion Engine**:

```mermaid
sequenceDiagram
    autonumber
    actor Customer as WhatsApp Lead
    participant Meta as Meta Cloud API
    participant Edge as Cloudflare Edge
    participant Ingest as Express Ingestion Router
    participant Queue as Upstash Redis FIFO
    participant Worker as Bot Engine & Async Worker
    participant DB as Neon PostgreSQL

    Customer->>Meta: "send the property Number2"
    Meta->>Edge: POST /api/webhook (HMAC Signed)
    Edge->>Ingest: Forward Webhook Payload
    Ingest->>Ingest: Verify X-Hub-Signature-256
    Ingest->>Queue: Push raw payload to Redis FIFO
    Ingest-->>Meta: HTTP 200 OK (< 50ms ACK)
    
    Note over Ingest,Meta: Meta SLA satisfied; zero dropped webhooks!
    
    Worker->>Queue: Pop Inbound Batch
    Worker->>Worker: botTriggerMatcher.js (NLP Extract Core Tokens)
    Worker->>DB: INSERT / UPDATE candidate & log activity
    Worker->>Meta: POST /v18.0/{id}/messages (Paced Media Pack)
    Meta-->>Customer: Hero Photo + Floor Plan + Brochure PDF + CTA Buttons
```

1. **HMAC Signature Authentication:** Ingest validates the `X-Hub-Signature-256` against `APP_SECRET` before parsing payloads.
2. **Immediate Enqueue:** The raw webhook payload is pushed to an in-memory buffer or Upstash Redis FIFO list (`inboundQueue.js`).
3. **Instant HTTP 200 Return:** The server responds with `HTTP 200 OK` in under **35–50 milliseconds**.
4. **Asynchronous Engine Execution:** Workers pop jobs from the queue, evaluate intent triggers, execute flow transitions, and write to PostgreSQL in background micro-transactions.

---

## 🤖 Visual Bot Studio Canvas

The **Bot Studio** provides non-technical growth and operations managers with a full visual drag-and-drop workspace built on top of **ReactFlow**:

<p align="center">
  <img src="docs/images/bot_studio_flow_builder.png" alt="Bot Studio Visual Flow Builder" width="100%" />
</p>

### Supported Node Types & Capabilities
| Node Type | Category | Industrial Capability |
| :--- | :---: | :--- |
| **Text Message** | Conversational | Dispatches standard text with dynamic parameter interpolation (`{{name}}`, `{{phone}}`, `{{pickup_date}}`). |
| **Media Message** | Rich Media | Sends high-resolution images or videos with custom captions and AWS S3 presigned links. |
| **Document Node** | Documents | Sends PDF brochures, price lists, or contracts with preserved native filenames (e.g., `Property_Brochure.pdf`). |
| **Interactive Buttons** | Engagement | Up to 3 Meta quick-reply buttons with deterministic node branching and fallback alphanumeric matching. |
| **Interactive List** | Engagement | WhatsApp interactive list menus featuring custom sections, row titles, and subtitles (up to 10 rows). |
| **Smart Scheduler** | Scheduling | 3-stage checkpoint state machine: **Date Selector** $\to$ **Period Selector** $\to$ **Exact Time Slot**. |
| **Location Request** | Geolocation | Prompts for live GPS coordinate submission or presents clickable regional preset landmark buttons. |
| **Condition Node** | Logic | Evaluates candidate variables against regex patterns, equality operators, or numerical bounds. |
| **Set Variable** | Data Storage | Captures conversational responses into the `candidates.variables` JSONB field for CRM segmentation. |
| **WhatsApp Template** | Meta Outbound | Dispatches official Meta pre-approved templates (`type: 'template'`) with dynamic body variables (`{{1}}`, `{{2}}`). |
| **Agent Handoff** | Human-in-Loop | Halts bot execution, flags `is_human_mode = true`, and transfers conversation to the active staff agent. |

---

## 🎯 Global Keyword Intent Router & Multi-Asset Media Dispatcher

In commercial messaging, leads frequently jump ahead of conversational prompts to request specific offerings:
> *"Please can you send the property Number2 details?"*

<p align="center">
  <img src="docs/images/keyword_media_router_flow.svg" alt="Keyword Router and Multi-Asset Media Pack Flow" width="100%" />
</p>

### 1. Linguistic Token Normalizer (`botTriggerMatcher.js`)
Encho does not rely on fragile exact substring matching. Instead, the engine processes incoming text through an enterprise conversational filter:

```javascript
// Strips conversational noise words while preserving semantic meaning
const FILLER_TOKENS = new Set([
  'please', 'pls', 'can', 'you', 'could', 'kindly',
  'send', 'give', 'show', 'share', 'get', 'want', 'need', 'i', 'im',
  'the', 'a', 'an', 'me', 'us', 'details', 'info', 'information', 'brochure',
  'for', 'of', 'about', 'to', 'this', 'that', 'number', 'no', 'num'
]);
```
- **Inbound Text:** `"Please can you send the property Number2 details?"`
- **Filtered Output:** `["property", "2"]`
- **Configured Node Triggers:** `["property 2", "villa 2", "p2"]`
- **Deterministic Match:** **YES**
- **False Positive Elimination:** Short conversational words (e.g. `"hi"`, `"ok"`) are barred from matching partial substrings like `"veHIcle"` or `"lOOK"`.

### 2. Active Button Precedence Guard
If a customer is currently looking at an interactive button menu (e.g. *[Confirm Booking]* / *[Reschedule]*), clicking that button **takes absolute priority** over the global keyword engine, preventing accidental jumps.

### 3. Sequential 350ms Delivery Pacing
WhatsApp Cloud API handles concurrent requests asynchronously. Sending a photo, a large PDF, and buttons simultaneously frequently results in the PDF arriving before the hero photo. 

Encho injects an automated **350ms delay** between each media item in `data.mediaGallery`:
```
[T + 0ms]    ──► Dispatches Hero Photo (Villa Exterior)
[T + 350ms]  ──► Dispatches Floor Plan (Architectural Layout)
[T + 700ms]  ──► Dispatches Official PDF Brochure (Property_Brochure.pdf)
[T + 1050ms] ──► Dispatches Interactive Action Buttons ([Book Visit] [Call Staff])
```

---

## 👥 Unified Staff CRM & Live Chat Workspace

<p align="center">
  <img src="docs/images/live_chat_agent_portal.png" alt="Staff Live Chat and Agent CRM Portal" width="100%" />
</p>

The Staff Portal (`StaffPortal.tsx` & `ChatDrawer.tsx`) gives human sales representatives and support agents a unified control center:

### Key Workspace Modules
1. **Dynamic 24-Hour WhatsApp Policy Timer:**
   Meta prohibits standard free-form messages 24 hours after the customer's last inbound message. The live chat displays a real-time countdown badge (`23H 57M REMAINING`). When expired, free-form text input is locked, and agents are prompted to select an approved Meta Template.
2. **Human Takeover Switch (`is_human_mode`):**
   Agents can toggle between **Bot Active** and **Human Mode** at any moment. While in Human Mode, incoming messages will not trigger automated bot node responses.
3. **One-Click Quick Response Pills:**
   Pre-configured canned macros (*Welcome*, *Human Mode*, *Doc Request*, *Approved*, *Rejected*) allow agents to reply in $< 2$ seconds.
4. **KYC & Document Verification Drawer:**
   Agents can review uploaded driver licences, passports, and utility bills with built-in zoom, status toggles (*Approved* / *Rejected*), and direct WhatsApp rejection feedback.
5. **Real-Time Activity Audit Trail:**
   Every event (`bot_keyword_triggered`, `lead_claimed`, `status_changed`, `template_sent`) is logged with timestamps in `lead_activity_log`.

---

## 🛡️ Agent Collision Prevention & Real-Time Presence

In high-concurrency enterprise sales teams, multiple agents often open the same lead simultaneously, risking duplicate or contradictory customer responses.

Encho implements a **Real-Time Agent Collision Shield**:
- **Heartbeat & Presence API:** Whenever an agent opens a lead drawer, `POST /api/leads/:id/viewing` registers their active presence.
- **Visual Warning Banner:** If another staff member views the same lead, an amber alert banner displays:
  > *"⚠️ Agent Sarah Jenkins is currently typing on this lead."*
- **Auto-Deregistration:** When the drawer closes or the tab loses focus, `POST /api/leads/:id/leave-viewing` instantly clears the viewer lock.

---

## 👑 Lead Lifecycle & Multi-Tier SLA Governance

<p align="center">
  <img src="docs/images/lead_lifecycle_state_machine.svg" alt="Lead Lifecycle and Escalation State Machine" width="100%" />
</p>

Leads flow through a strict state machine managed by PostgreSQL relational constraints and background SLA monitors:

### 1. Automated Lead Distribution
- **Round-Robin Assignment:** Inbound leads can be automatically assigned to on-duty staff members (`is_active_for_auto_dist = true`) based on current shift hours (`shift_start`, `shift_end`, `working_days`).
- **Open Lead Pool:** Alternatively, leads appear in the unclaimed pool where available agents click **Claim Lead**.

### 2. Multi-Level SLA Escalation Timers
- **Level 1 SLA Warning (15 Minutes):**
  If an assigned lead receives no response from the agent within 15 minutes, the system sends an automated WhatsApp nudge to the assigned agent and flags `SLA_WARNING` in `lead_activity_log`.
- **Level 2 Manager Escalation (30 Minutes):**
  If the lead remains uncontacted after 30 minutes, the assignment is revoked, the lead returns to the open claim pool, and an alert is dispatched to the team manager's dashboard.

---

## 📊 Two-Way Google Sheets & Driver Excel Sync Engine

Operations teams frequently rely on spreadsheets for executive reporting, fleet accounting, and daily lead status synchronization.

<p align="center">
  <img src="docs/images/whatsapp_customer_experience.png" alt="WhatsApp Customer Experience" width="50%" />
</p>

### Key Sync Capabilities (`DriverExcelReport.tsx`)
- **Two-Way Synchronization:** Edits made in the Encho UI push to Google Sheets; rows added or updated in Google Sheets sync back to PostgreSQL.
- **Two Worksheets per Spreadsheet:**
  1. `Customers` / `Leads`: Contains candidate metadata, stage, status, assigned agent, and dynamic bot variables.
  2. `Messages`: Contains the complete chronological audit log of all inbound and outbound WhatsApp messages.
- **Incremental Debounced Sync:** Edits are batched via `DRIVER_EXCEL_INCREMENTAL_SYNC_IDLE_MS` (2.5s) to stay within Google Sheets API rate quotas.
- **Custom Dynamic Column Mapping:** Admins can define custom columns that extract nested values from `candidates.variables` JSONB directly into spreadsheet headers.

---

## ☁️ AWS S3 Media Library & Cloud Document Management

The **Media Library** (`MediaLibrary.tsx`) manages all outbound property flyers, high-resolution villa photos, vehicle documentation, and client contracts.

- **Presigned S3 Uploads:** Files are uploaded directly from the browser to AWS S3 using presigned URLs, bypassing application server memory limits.
- **Public & Private Folders:** Admins can designate folders as public showcases or internal KYC document archives.
- **WhatsApp CDN URL Caching:** Resolves media URLs through S3 CloudFront or public S3 buckets, caching URLs to prevent duplicate bandwidth charges.

---

## 🔌 Complete REST & Webhook API Specification

All authenticated routes require a Bearer token or session cookie verified via `authMiddleware`. Roles are enforced via `requireRole('admin', 'manager')`.

### 1. Webhook Endpoints
| Method | Endpoint | Access | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/webhook` | Public | Meta webhook verification endpoint (`hub.mode`, `hub.challenge`, `hub.verify_token`). |
| `POST` | `/api/webhook` | Public (HMAC) | Inbound Meta WhatsApp webhook handler (Text, Media, Location, Interactive Buttons). |
| `GET` | `/api/updates/stream` | Authenticated | Server-Sent Events (SSE) streaming live inbound messages and state changes to the UI. |

### 2. Staff & Presence Endpoints
| Method | Endpoint | Access | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/auth/me` | Authenticated | Returns current authenticated staff user profile and role. |
| `GET` | `/api/staff` | Authenticated | Lists all staff members, shifts, and auto-distribution status. |
| `POST` | `/api/staff` | Admin | Creates a new staff member account. |
| `DELETE` | `/api/staff/:id` | Admin | Deactivates or removes a staff member. |
| `PATCH` | `/api/staff/:id/auto-dist`| Staff / Admin | Toggles active status for automated round-robin lead allocation. |
| `POST` | `/api/staff/heartbeat` | Authenticated | Heartbeat keeping staff online presence active. |
| `GET` | `/api/staff/presence` | Authenticated | Returns live online/away status of all team members. |
| `POST` | `/api/staff/:id/force-logout` | Admin | Forces logout and terminates active sessions for a staff member. |

### 3. Lead Management & Assignment
| Method | Endpoint | Access | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/leads/pool` | Authenticated | Returns all unassigned leads available in the open claim pool. |
| `GET` | `/api/leads/my` | Authenticated | Returns leads currently assigned to the requesting staff member. |
| `POST` | `/api/leads/:id/claim` | Staff | Claims an unassigned lead from the pool. |
| `POST` | `/api/leads/:id/assign` | Manager / Admin | Manually assigns a lead to a specific staff member. |
| `POST` | `/api/leads/:id/reassign` | Manager / Admin | Transfers lead ownership from one agent to another. |
| `POST` | `/api/leads/:id/unclaim` | Staff | Releases a lead back to the open pool. |
| `POST` | `/api/leads/:id/action` | Staff | Logs CRM actions (calls, notes, stage changes) into `lead_activity_log`. |
| `GET` | `/api/leads/:id/activity` | Authenticated | Returns chronological audit activity history for a lead. |
| `POST` | `/api/leads/:id/viewing` | Authenticated | Registers active presence on a lead drawer (Collision Shield). |
| `POST` | `/api/leads/:id/leave-viewing`| Authenticated | Unregisters active presence on a lead drawer. |
| `GET` | `/api/leads/:id/viewers` | Authenticated | Lists all staff members currently viewing a lead. |

### 4. Messaging & Drivers
| Method | Endpoint | Access | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/drivers` | Authenticated | Returns paginated lead list with stage filters, search, and sorting. |
| `PATCH` | `/api/drivers/:id` | Authenticated | Updates candidate details, stage, status, or `is_human_mode`. |
| `GET` | `/api/drivers/:id/messages`| Authenticated | Retrieves complete WhatsApp message history for a lead. |
| `POST` | `/api/drivers/:id/messages`| Authenticated | Sends an outbound WhatsApp message (Text, Media, or Meta Template). |
| `GET` | `/api/drivers/:id/documents`| Authenticated | Lists all uploaded KYC/driver documents for a candidate. |
| `PATCH` | `/api/drivers/:id/document-status` | Authenticated | Updates document verification status (*Approved* / *Rejected*). |

### 5. Bot Settings & Canned Macros
| Method | Endpoint | Access | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/bot/settings` | Authenticated | Retrieves draft and published Bot Studio canvas nodes and edges. |
| `POST` | `/api/bot/settings` | Admin / Manager | Saves draft canvas configuration. |
| `POST` | `/api/bot/settings/publish` | Admin | Publishes draft flow to the production runtime engine. |
| `GET` | `/api/canned-responses` | Authenticated | Retrieves all canned quick-reply macros. |
| `POST` | `/api/canned-responses` | Admin / Manager | Creates a new quick-reply macro. |
| `DELETE` | `/api/canned-responses/:id` | Admin / Manager | Deletes a quick-reply macro. |

### 6. Media Library & AWS S3
| Method | Endpoint | Access | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/media` | Authenticated | Lists S3 media files, categories, and folders. |
| `POST` | `/api/media/upload` | Authenticated | Direct multipart file upload endpoint. |
| `POST` | `/api/media/upload/init` | Authenticated | Generates AWS S3 presigned PUT URL for direct browser uploads. |
| `POST` | `/api/media/folders` | Authenticated | Creates a new organizational media folder. |
| `POST` | `/api/media/sync-s3` | Admin | Scans S3 bucket and synchronizes database media records. |
| `DELETE` | `/api/media/files/:id` | Admin / Manager | Deletes an asset from S3 and database registry. |

---

## 🗄️ Relational Database Schema (System of Record)

<p align="center">
  <img src="docs/images/meta_cloud_webhook_setup.png" alt="Meta WhatsApp Cloud API Webhook Configuration" width="100%" />
</p>

The database schema (`database_schema.sql`) is deployed on **PostgreSQL** (Neon Serverless with connection pooling):

```sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Staff Members & Role Hierarchy
CREATE TABLE staff_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'staff', -- 'admin', 'manager', 'staff'
    manager_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    is_active_for_auto_dist BOOLEAN DEFAULT FALSE,
    last_assigned_at TIMESTAMP WITH TIME ZONE,
    shift_start TIME DEFAULT '09:00:00',
    shift_end TIME DEFAULT '19:00:00',
    working_days INTEGER[] DEFAULT ARRAY[1,2,3,4,5,6]::INTEGER[],
    timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
    auto_away_timeout_minutes INTEGER DEFAULT 5,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Candidates & Lead Registry
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255),
    stage VARCHAR(50) DEFAULT 'New',
    lead_status VARCHAR(50) DEFAULT 'new',
    last_message TEXT,
    last_message_at BIGINT,
    source VARCHAR(50) DEFAULT 'Organic',
    is_human_mode BOOLEAN DEFAULT FALSE,
    current_bot_step_id VARCHAR(100),
    variables JSONB DEFAULT '{}'::jsonb,
    assigned_to UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    assigned_manager_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    follow_up_date TIMESTAMP WITH TIME ZONE,
    follow_up_note TEXT,
    is_pushed_to_closing BOOLEAN DEFAULT FALSE,
    closing_notes TEXT,
    closing_screenshot_url TEXT,
    last_action_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Lead Activity & Audit Stream
CREATE TABLE lead_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL, -- 'bot_keyword_triggered', 'lead_claimed', etc.
    notes TEXT,
    media_url TEXT,
    next_followup_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Full Inbound / Outbound WhatsApp Messages
CREATE TABLE candidate_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
    text TEXT,
    type VARCHAR(50) DEFAULT 'text', -- 'text', 'image', 'video', 'document', 'template'
    status VARCHAR(50) DEFAULT 'sent',
    whatsapp_message_id VARCHAR(255),
    sender_type VARCHAR(50), -- 'bot', 'agent', 'candidate'
    is_internal BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. KYC & Driver Document Vault
CREATE TABLE driver_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    type VARCHAR(50), -- 'licence', 'id_proof', 'utility_bill'
    url TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX idx_candidates_assigned_to ON candidates(assigned_to);
CREATE INDEX idx_candidates_unassigned_pool ON candidates(last_message_at DESC NULLS LAST, created_at DESC) WHERE assigned_to IS NULL;
CREATE INDEX idx_candidates_last_message_at ON candidates(last_message_at DESC NULLS LAST);
CREATE INDEX idx_candidate_messages_whatsapp_message_id ON candidate_messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
CREATE INDEX idx_candidate_messages_candidate_created_at ON candidate_messages(candidate_id, created_at DESC);

COMMIT;
```

---

## 🔒 Security, HMAC Verification & Meta Policy Compliance

1. **HMAC SHA-256 Webhook Verification:**
   Every incoming HTTP request to `/api/webhook` is verified against the raw request body using `crypto.createHmac('sha256', process.env.APP_SECRET)`. Payloads that fail signature verification are rejected immediately with `403 Forbidden`.
2. **Meta 24-Hour Customer Care Window:**
   The Meta WhatsApp Cloud API prohibits sending non-template marketing messages outside 24 hours from the user's last inbound message. Encho enforces this via `LiveChat.tsx` and `server.ts`:
   - Outbound free-form messages outside 24h are blocked at the engine layer.
   - The UI automatically locks free text and routes the agent to pre-approved templates (`type: 'template'`).
3. **Outbound Payload Sanitization (`whatsappPayload.js`):**
   - Strips unrendered template placeholders (`{{variable}}` or `[Replace this text]`).
   - Validates that interactive buttons have non-empty titles and unique callback IDs.
   - Truncates body texts exceeding Meta's 4,096-character limit.
4. **SQL Injection Prevention:**
   All relational queries utilize strict parameterized `$1, $2` bindings through `pg.Pool`.

---

## ⚙️ Complete Environment Configuration Dictionary

All operational variables are declared in `.env` (derived from `.env.example`):

### 1. Database & Meta WhatsApp API
| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `POSTGRES_URL` | **Yes** | — | Neon PostgreSQL connection string with SSL (`sslmode=require`). |
| `PUBLIC_BASE_URL` | **Yes** | — | Production URL (e.g., `https://your-domain.com`) for webhooks and presigned links. |
| `META_API_TOKEN` | **Yes** | — | Meta System User permanent access token (`EAAG...`). |
| `PHONE_NUMBER_ID` | **Yes** | — | Meta Cloud API Phone Number ID. |
| `VERIFY_TOKEN` | **Yes** | — | Secret string entered in Meta Webhook settings to verify endpoint ownership. |
| `APP_SECRET` | **Yes** | — | Meta App Secret used for HMAC SHA-256 signature verification. |

### 2. High-Throughput Buffering & Upstash Redis
| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `UPSTASH_REDIS_REST_URL` | **Yes** | — | REST endpoint URL for Upstash Redis database. |
| `UPSTASH_REDIS_REST_TOKEN` | **Yes** | — | Authentication token for Upstash Redis. |
| `QSTASH_TOKEN` | Optional | — | Upstash QStash publish token for background job scheduling. |
| `QSTASH_CURRENT_SIGNING_KEY`| Optional | — | Current QStash signing key for webhook signature validation. |

### 3. AWS S3 Media Storage
| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `AWS_ACCESS_KEY_ID` | **Yes** | — | IAM user access key with S3 Read/Write permissions. |
| `AWS_SECRET_ACCESS_KEY` | **Yes** | — | IAM secret access key. |
| `AWS_BUCKET_NAME` | **Yes** | — | S3 bucket name storing property brochures, images, and documents. |
| `AWS_REGION` | **Yes** | `us-east-1` | AWS S3 region. |

### 4. Engine & Sync Performance Tuning
| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `BOT_ENGINE_AUTO_ADVANCE_DELAY_MS` | Optional | `5` | Milliseconds between auto-advancing consecutive bot nodes. |
| `BOT_ENGINE_DELAY_NODE_CAP_MS` | Optional | `800` | Upper bound for delay node sleep duration to avoid chat stalls. |
| `DRIVER_EXCEL_SYNC_IDLE_MS` | Optional | `20000` | Quiet window before running heavy S3 + Google Sheets sync. |
| `DRIVER_EXCEL_INCREMENTAL_SYNC_IDLE_MS` | Optional | `2500` | Buffer delay to batch frequent row edits before pushing to Sheets. |
| `PG_POOL_MAX` | Optional | `4` | Maximum connections in PostgreSQL connection pool (Neon free-tier tuned). |
| `PG_IDLE_TIMEOUT_MS` | Optional | `8000` | Time before idle database pool clients are released. |

---

## 💻 Local Development & Quickstart Runbook

### 1. Clone & Install
```bash
git clone https://github.com/ajitzz/Encho-enterprises-WhatsApp-Leads-Handler.git
cd Encho-enterprises-WhatsApp-Leads-Handler
npm install
```

### 2. Environment Configuration
```bash
cp .env.example .env
# Edit .env with your PostgreSQL, Meta, and AWS credentials
```

### 3. Apply PostgreSQL Schema Migrations
```bash
npm run db:migrate
```

### 4. Run Development Server
```bash
npm run dev
# Server listening at http://localhost:3000
```

### 5. Local Webhook Testing via ngrok
```bash
ngrok http 3000
# Copy your ngrok HTTPS URL to Meta Developer Portal: https://<ngrok-id>.ngrok-free.app/api/webhook
```

---

## 🧪 Automated Testing & Governance Evidence

The repository maintains an automated verification suite ensuring zero regression across imports, boundary contracts, payload structures, and intent normalizers:

```bash
# Execute entire test suite
npm test

# Run strict TypeScript compiler verification
npm run lint

# Run production asset bundling
npm run build
```

### Verified Test Log Output (50/50 PASS)
```
✔ resolveModuleMode supports tenant canary (1.87ms)
✔ lead ingestion service processes webhook via module service path (11.25ms)
✔ lead ingestion service falls back to facade path when dependencies are missing (0.99ms)
✔ lead ingestion service supports deferred webhook ack mode (11.80ms)
✔ lead ingestion service defers bot on backpressure to keep webhook fast (6.40ms)
✔ lead ingestion service defers bot when sync budget is exceeded (35.40ms)
✔ auth-config facade delegates auth and bot/system settings handlers (2.16ms)
✔ resolveModuleMode supports shadow and canary fallback semantics (2.09ms)
✔ buildBoundaryError enforces standard error shape (1.49ms)
✔ import boundaries check script passes (149.73ms)
✔ contract versioning check script passes (114.01ms)
✔ migration evidence check script passes (79.57ms)
✔ performance canary check script passes (70.36ms)
✔ sections 4-7 readiness check script passes (67.21ms)
✔ section 1 hardening check script passes (64.51ms)
✔ rollout mode check script passes (61.25ms)
✔ industrial readiness check script passes (65.58ms)
✔ sections 1-3 readiness check script passes (72.89ms)
✔ vercel api entrypoint exports a request handler function (0.58ms)
✔ vercel api entrypoint can delegate requests to express app (31.23ms)
✔ validateOutboundPayload blocks empty text body (1.93ms)
✔ validateOutboundPayload blocks interactive list with missing row ids (0.54ms)
✔ validateOutboundPayload allows valid interactive button payload (0.29ms)
✔ summarizePayloadForStorage returns safe defaults for media (0.25ms)
✔ validateOutboundPayload allows valid WhatsApp template payload (0.32ms)
✔ Global keyword matching normalizer correctly matches variations of property triggers without false positives (1.28ms)
✔ findMatchingKeywordNode evaluates priority order correctly (0.52ms)

ℹ tests 50
ℹ suites 0
ℹ pass 50
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 1764ms
```

---

## 🌐 Multi-Cloud Production Deployment Runbook

### Option A: Cloudflare Pages + Render Web Service (Recommended)
1. **Frontend (Cloudflare Pages):**
   - Connect GitHub repository.
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Add environment variable `VITE_GOOGLE_CLIENT_ID`.
2. **Backend (Render / Railway / VPS Node Service):**
   - Deploy as Node.js Web Service using `render.yaml`.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Bind environment variables from `.env`.

### Option B: Unified Node Server (Docker / PM2)
Run on any Ubuntu VPS with PM2 process manager:
```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
```

---

## 📂 Repository Directory Blueprint

```
├── backend/
│   ├── modules/
│   │   ├── auth-config/              # Google OAuth, tenant configs & system parameters
│   │   ├── lead-ingestion/           # Ingestion facade, HMAC validator & queue service
│   │   ├── reminders-escalations/    # 15m/30m SLA escalation timer engines
│   │   └── system-health/            # Health checks, telemetry & system monitor APIs
│   └── shared/
│       └── infra/
│           ├── botTriggerMatcher.js  # NLP intent keyword router & filler word stripper
│           ├── flags.js              # Dynamic feature flags & canary rollout engine
│           ├── inboundQueue.js       # Upstash Redis FIFO buffer shock absorber
│           └── whatsappPayload.js    # Strict Meta Cloud API outbound schema validator
├── components/
│   ├── BotBuilder.tsx                # ReactFlow canvas, node types & trigger settings
│   ├── ChatDrawer.tsx                # Deep live chat drawer with 24H timer & KYC viewer
│   ├── StaffPortal.tsx               # Staff dashboard, lead claim & assignment queue
│   ├── StaffManagement.tsx           # Shifts, roles, auto-dist weights & team admin
│   ├── DriverExcelReport.tsx         # Google Sheets two-way sync & Excel export engine
│   ├── MediaLibrary.tsx              # S3 brochure, floor plan & photo upload manager
│   ├── CommandCenter.tsx             # Real-time funnel metrics & conversion velocity
│   ├── ActionCenter.tsx              # Operational intelligence & SLA violation alerts
│   └── WebhookConfigModal.tsx        # Meta webhook verification & subscription tester
├── docs/
│   ├── images/                       # High-res SVG architectural diagrams & screenshots
│   │   ├── system_architecture_diagram.svg
│   │   ├── bot_studio_flow_builder.png
│   │   ├── keyword_media_router_flow.svg
│   │   ├── live_chat_agent_portal.png
│   │   ├── lead_lifecycle_state_machine.svg
│   │   ├── whatsapp_customer_experience.png
│   │   └── meta_cloud_webhook_setup.png
│   ├── cloudflare-backend-runbook-2026-04-16.md
│   └── cloudflare-beginner-step-by-step-2026-04-15.md
├── scripts/
│   ├── migrate.ts                    # Idempotent PostgreSQL schema migrator
│   ├── release-gate.js               # Industrial release checklist validator
│   └── run-smoke-checks.js           # End-to-end smoke verification runner
├── tests/
│   ├── critical-flows.test.js        # Webhook ingestion & backpressure tests
│   ├── migration-governance.test.js  # Boundary & module contract tests
│   └── whatsapp-payload-validation.test.js # Template & keyword normalizer tests
├── types.ts                          # Shared TypeScript contracts & FlowNodeData
├── server.ts                         # Unified Express gateway, state machine & bot runtime
├── database_schema.sql               # Canonical PostgreSQL schema & indexes
└── package.json                      # Project manifest, dependencies & scripts
```

---

## 📜 License & Enterprise Copyright

Copyright © 2026 **Encho Enterprises**. All rights reserved.  
Engineered for mission-critical enterprise leads automation, high-concurrency WhatsApp communications, and modern fleet operations.
