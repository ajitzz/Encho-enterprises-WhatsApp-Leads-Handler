
# WhatsApp API Integration Setup (Vercel Edition)

Since you have deployed your project to **Vercel**, you do not need ngrok.

### 🛑 STEP 1: Enable "Live Mode" (CRITICAL)

If you see test messages but **NOT** messages from real phones, this is the reason.

1.  Go to **[Meta for Developers](https://developers.facebook.com)**.
2.  Open your App ("Encho Enterprises").
3.  Look at the **Top Right Corner** of the dashboard.
4.  You will see a toggle switch: **App Mode**.
5.  If it says **Development**, you can only message numbers listed as "Testers".
6.  **Switch it to LIVE**.
    *   *Note: You may need to provide a Privacy Policy URL in Settings > Basic to enable Live Mode.*

### 🛑 STEP 2: Configure Webhook with Vercel URL

1.  Go to your App Dashboard on [developers.facebook.com](https://developers.facebook.com).
2.  In the left sidebar, click **WhatsApp** > **Configuration**.
3.  Find the **Webhook** section and click **Edit**.
4.  **Callback URL**: Enter your Vercel URL.
    - `https://encho-whatsapp-lead-handler.vercel.app/webhook`
5.  **Verify Token**: Enter `uber_fleet_verify_token`.
6.  Click **Verify and Save**.
7.  **Click "Manage"** (under Webhook Fields) and ensure `messages` is checked.

### 🛑 STEP 3: Disable Auto-Replies

If you see "Replace this sample message", it is coming from Meta Business Suite, not your code.

1.  Go to **[Meta Business Suite](https://business.facebook.com)**.
2.  Click **Inbox** > **Automations** (sparkle icon).
3.  Turn **OFF**: Instant Reply, Away Message, FAQs.

### 4. Monitoring Logs

If messages still don't appear:
1.  Go to your Vercel Dashboard.
2.  Click on your project > **Logs**.
3.  Send a message from your phone.
4.  You should see `Incoming Webhook Payload:` followed by JSON data.
    - If you see nothing, Meta is not sending the message (likely because App Mode is Development).
    - If you see the log but no database update, check the `server.js` logs for SQL errors.
