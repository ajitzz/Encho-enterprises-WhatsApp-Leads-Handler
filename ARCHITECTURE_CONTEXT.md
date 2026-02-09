
# ENCHO WHATSAPP HANDLER - SYSTEM ARCHITECTURE & MEMORY

## 1. Project Overview
*   **App:** Encho Cabs Premium Travel Platform.
*   **Stack:** React (Vite/Tailwind), Node.js (Express), PostgreSQL (Neon Serverless), Vercel (Hosting), AWS S3 (Media), Meta WhatsApp Cloud API.
*   **Core Value:** "Complete Travel Partner" - We are not a taxi service; we are a holiday orchestrator anchored by Premium Vehicles.

## 2. Critical Stability Features (DO NOT REMOVE)
The following mechanisms prevent "Cold Starts" and "Database Sleep" issues inherent to the Vercel/Neon stack:

### A. Self-Healing Database (`server.js`)
*   **Mechanism:** The `executeWithRetry` wrapper function surrounds all webhook database calls.
*   **Logic:** It catches PostgreSQL Error `42P01` (undefined_table). If caught, it triggers `initDatabase()` to rebuild the entire schema (tables + extensions) and then retries the original query.
*   **Outcome:** The system automatically repairs itself if the database is wiped or reset.

### B. "Deep Wake" Keep-Alive
*   **Endpoint:** `GET /ping`
*   **Logic:** It does NOT just return 200 OK. It executes `await client.query('SELECT 1')`.
*   **Purpose:** This forces a connection to the Neon Database, resetting its 5-minute inactivity timer. This is hit by an external Cron Job every 5 minutes to ensure sub-second response times for WhatsApp.

### C. In-Memory Bot Fallback
*   **Problem:** If the database is empty or slow, the bot previously sent nothing.
*   **Solution:** If `SELECT settings FROM bot_versions` returns no rows, the code generates a **Default Bot Configuration** in RAM immediately to reply to the user. It simultaneously seeds this config into the DB for the next request.
*   **Rule:** The bot engine must NEVER return an empty response.

### D. Performance Caching
*   **Memory Cache:** Bot Settings are cached in a Node.js variable (`memoryCache`) with a 60-second TTL.
*   **Benefit:** Prevents fetching the huge flow JSON from the database for every single incoming message burst.

## 3. Bot Engine Logic
*   **Content Safety:** The `isValidContent()` function strictly blocks placeholder text (e.g., "Replace this sample message") to prevent embarrassing auto-replies.
*   **Flow Traversal:** Uses a Node/Edge graph. If a user's state (`current_bot_step_id`) is invalid or missing, it defaults to the 'Start' node.

## 4. High-Performance Bulk Scheduler (Implemented)
To support mass marketing of Travel Packages, the backend includes specific optimizations:
*   **Batch Insert:** Uses `UNNEST` in SQL to insert 1,000+ scheduled messages in a single database transaction (O(1) complexity instead of O(N) loop).
*   **Parallel Cron:** The `/cron/process-queue` endpoint processes messages in concurrent batches (default: 5) to maximize throughput while respecting Meta API rate limits.
*   **Queue Locking:** Uses `FOR UPDATE SKIP LOCKED` to ensure multiple server instances do not process the same message twice.

## 5. Public Showcase & Offline Resilience
The `PublicShowcase` component allows customers to view vehicle/hotel media via a public link.
*   **3-Tier Loading Strategy:**
    1.  **Local Cache:** Loads instantly from `localStorage` if visited previously.
    2.  **Live API:** Fetches fresh data from `/api/showcase`.
    3.  **S3 Manifest Fallback:** If the API fails (server down/cold start), it fetches a static `manifest.json` directly from the S3 bucket (`FALLBACK_BUCKET_URL`), ensuring the catalog is **always viewable** even if the backend is offline.

## 6. Frontend Emergency Mode
*   **Trigger:** If the API returns a "relation does not exist" error during the initial dashboard load.
*   **UI:** The App switches to `isEmergencyMode`, rendering a Red "Critical Database Error" screen with a "Hard Reset" tool.
*   **Action:** Allows the admin to hit `/api/system/hard-reset` to drop and recreate all tables from the UI.

## 7. System Diagnostics
*   **Polling:** The dashboard polls `/api/debug/status` every 5 seconds.
*   **Checks:** Verifies PostgreSQL connection, table existence (`candidates`, `bot_versions`), and row counts.
*   **UI:** Displays a "System Monitor" bar at the bottom. If tables are missing, it offers a "Repair Schema" button.

## 8. Bot Interaction Enhancements (Recent Updates)
### A. Hybrid Date & Time Picker
*   **Logic:** Combines structured List Messages with NLP-lite text recognition.
*   **Behavior:** Users can select a slot from a list OR type a specific time (e.g., "11:15 PM"). The engine detects time formats via Regex and accepts the input immediately, bypassing the need for a specific "Custom" button click if the intent is clear.
*   **Manual Trigger:** Includes a "Type Specific Time" list option that explicitly pauses automation to wait for user input.

### B. Smart Location Triggers
*   **Heuristic:** If a Location Preset is configured in the Bot Builder but lacks coordinates (Lat/Long), the engine automatically treats it as a "Manual Pin Trigger".
*   **Benefit:** Prevents bot loops if an admin forgets to change the preset type from 'Static' to 'Manual' while leaving coordinates empty.

### C. API Payload Strictness
*   **Fix:** `location_request_message` payloads are strictly formatted. The `body` object contains *only* the `text` field. Adding `type: "text"` (common in other message types) causes the "Send Location" button to vanish on WhatsApp iOS/Android clients.
