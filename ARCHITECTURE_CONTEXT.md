
# ENCHO WHATSAPP HANDLER - SYSTEM ARCHITECTURE & MEMORY

## 1. Project Overview
*   **App:** Encho Cabs Recruitment Dashboard (Uber Fleet).
*   **Stack:** React (Vite/Tailwind), Node.js (Express), PostgreSQL (Neon Serverless), Vercel (Hosting), AWS S3 (Media), Meta WhatsApp Cloud API.
*   **Hosting Strategy:** Serverless (Vercel) with "Always-On" optimizations.

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

## 4. Frontend Emergency Mode
*   **Trigger:** If the API returns a "relation does not exist" error during the initial dashboard load.
*   **UI:** The App switches to `isEmergencyMode`, rendering a Red "Critical Database Error" screen with a "Hard Reset" tool.
*   **Action:** Allows the admin to hit `/api/system/hard-reset` to drop and recreate all tables from the UI.

## 5. Maintenance Commands
*   **Sync S3:** `/api/media/sync-s3` (Scans AWS Bucket and populates DB).
*   **Hard Reset:** `/api/system/hard-reset` (Nukes DB and rebuilds schema).
*   **Webhook Config:** `/api/system/webhook` (Updates Meta Callback URL programmatically).
