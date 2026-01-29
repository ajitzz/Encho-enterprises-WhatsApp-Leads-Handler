
# Uber Fleet Recruiter

High-performance serverless WhatsApp automation using **React**, **Node.js**, **PostgreSQL (Neon)**, and **Redis (Upstash)**.

## ⚡ Performance Architecture
This project uses a **Write-Behind** architecture to ensure instant webhook responses (<2s):
1.  **Upstash Redis**: Handles hot state (user session) and caching (bot settings).
2.  **Upstash QStash**: Queues database writes asynchronously so the webhook doesn't wait for Postgres.
3.  **Neon Postgres**: Serves as the persistent system of record.

## 🔑 Environment Variables
Add these to your `.env` file (and Vercel Environment Variables):

```env
# Database
POSTGRES_URL="postgresql://..."

# WhatsApp
META_API_TOKEN="EAAG..."
PHONE_NUMBER_ID="123..."
VERIFY_TOKEN="uber_fleet_verify_token"

# Upstash Redis & QStash (Required for low latency)
UPSTASH_REDIS_REST_URL="https://..."
UPSTASH_REDIS_REST_TOKEN="..."
QSTASH_URL="https://qstash.upstash.io/v2/publish/"
QSTASH_TOKEN="..."
```

## 🚀 Quick Setup

1.  **Deploy to Vercel**.
2.  **Create Upstash Database**:
    *   Go to [Upstash Console](https://console.upstash.com).
    *   Create a Redis database. Copy `UPSTASH_REDIS_REST_URL` and `TOKEN`.
    *   Go to QStash tab. Copy `QSTASH_TOKEN`.
3.  **Set Environment Variables** in Vercel.
4.  **Redeploy**.

The chatbot will now respond instantly by serving logic from Redis and offloading database writes to the background worker.
