
# WhatsApp API Integration Setup

To make the automation work, you must connect your local computer to the Internet so Meta (Facebook) can send you messages.

### 🛑 CRITICAL: Disable "Replace this sample message"

If you see a default "Replace this sample message" reply, it is coming from **Meta Business Suite Automations**, not your code.

1.  Go to **[Meta Business Suite](https://business.facebook.com)**.
2.  Make sure your **Business Account** is selected in the top-left dropdown.
3.  Click **Inbox** on the left sidebar.
4.  Look at the top-right of the Inbox page. Click the **"Automations" icon** (✨ looks like a sparkle or an atom).
5.  Click **Instant Reply**. Toggle it **OFF**.
6.  Click **Away Message**. Toggle it **OFF**.
7.  Check **Frequently Asked Questions**. Toggle it **OFF**.

### 1. Meta Developer Account
1. Go to [developers.facebook.com](https://developers.facebook.com).
2. Create a new App > Select **Business** type.
3. Scroll down to **WhatsApp** and click **Set up**.

### 2. Credentials
Your code is already pre-configured with the Token and Phone ID you provided in `server.js`.

### 3. Exposing your Server (The "Tunnel")
Since your server runs on your laptop (`localhost`), Facebook cannot see it. You need a "Tunnel" to give Facebook a public URL to talk to.

**Option A: Using NPX (Easiest)**
1. Open a new terminal (Keep your `node server.js` running in the first terminal).
2. Run this command:
   ```bash
   npx ngrok http 3000
   ```
3. It will generate a link that looks like: `https://abcd-123-456.ngrok-free.app`.
4. **Copy this HTTPS URL.**

### 4. Configure Webhook in Meta
1. Go to your App Dashboard on developers.facebook.com.
2. In the left sidebar, click **WhatsApp** > **Configuration**.
3. Find the **Webhook** section and click **Edit**.
4. **Callback URL**: Paste the ngrok URL you copied and add `/webhook` at the end.
   - Example: `https://abcd-123-456.ngrok-free.app/webhook`
5. **Verify Token**: Enter `uber_fleet_verify_token`.
6. Click **Verify and Save**.
   - *If it fails, make sure your node server is running!*
7. Click **Manage** (under Webhook Fields) and check the box for `messages`.

### 4.1 If you use Cloudflare Worker + separate backend (important)
If your frontend is on `*.workers.dev` and your Node backend is on another domain (Render/Railway/etc):

1. Keep your callback URL as:
   - `https://<your-workers-domain>/webhook`
2. Ensure Worker variable `BACKEND_API_ORIGIN` is set to your backend domain.
3. Redeploy worker after setting variables.

The worker will proxy `/webhook` to backend `/api/webhook`.

### 4.1.1 Meta Dashboard click-by-click (exact path)
Use this when your callback must stay:
`https://<your-workers-domain>/webhook`

1. Open: [https://developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Click your app (the one connected to your WhatsApp Business Account).
3. In the left menu, click **WhatsApp**.
4. Click **Configuration**.
5. Scroll to the **Webhook** card.
6. Click **Edit** (or **Manage**, depending on UI version).
7. In **Callback URL**, paste exactly:
   - `https://<your-workers-domain>/webhook`
8. In **Verify token**, enter the same value used in backend `VERIFY_TOKEN`.
9. Click **Verify and Save**.
10. After save, in **Webhook fields**, click **Manage**.
11. Enable/check at least:
    - `messages`
    - `message_template_status_update` (optional but recommended for visibility)
12. Click **Done** / **Save**.

If verification fails:
- Confirm Worker is deployed.
- Confirm `BACKEND_API_ORIGIN` is set.
- Confirm backend endpoint `https://<backend-domain>/api/webhook` is reachable.

### 4.1.2 How to confirm Meta is actually sending events
1. In the same **WhatsApp > Configuration > Webhook** area, look for delivery/test controls.
2. Use **Test** / **Send test** for the `messages` field (if visible in your app UI).
3. Send a real WhatsApp message from a phone to your connected business number.
4. In Meta panel, check last delivery result:
   - `200` means webhook accepted.
   - `4xx/5xx` means route/config/backend issue.
5. In your browser DevTools Network tab, inspect `/webhook` or `/api/webhook` calls and verify:
   - response status,
   - `x-proxied-by: cloudflare-worker-edge-proxy`,
   - `x-proxy-path-type: webhook`.

### 4.2 Browser Console quick checks (copy/paste)
Open your app in browser → press `F12` → Console, then run:

```js
fetch('/api/health').then(async r => ({status: r.status, body: await r.text()})).then(console.log)
fetch('/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123').then(async r => ({status: r.status, body: await r.text()})).then(console.log)
fetch('/api/webhook', {
  method:'POST',
  headers:{'content-type':'application/json'},
  body: JSON.stringify({object:'whatsapp_business_account', entry:[{changes:[{value:{messages:[{id:'wamid.TEST123',from:'15551234567',type:'text',text:{body:'hello'}}],contacts:[{profile:{name:'Test'}}]}}]}]})
}).then(async r => ({status:r.status, body: await r.text()})).then(console.log)
```

Expected:
- `/api/health` should be `200`.
- `/webhook?...wrong token` should be `403` (this is normal with wrong token).
- POST `/api/webhook` should return `200` (accepted).

### 5. Running the Project
1. Start the Backend:
   ```bash
   node server.js
   ```
2. Start the Frontend:
   ```bash
   npm start
   ```
3. Switch the Frontend Toggle to **Live API**.

Now send a WhatsApp message to the test number. It will appear on your dashboard!

---

# 🌍 GOING LIVE (CRITICAL FOR PUBLIC ACCESS)

### Step 1: Switch to Live Mode
1.  Go to [developers.facebook.com/apps](https://developers.facebook.com/apps).
2.  Select your App (**Encho Messanger**).
3.  Ensure the top toggle says **"App Mode: Live"**.

### Step 2: Request Advanced Access (THE FIX)
Even if your app is "Live", you might be restricted to "Standard Access", which only allows messaging admins/testers.

1.  In the left sidebar of your App Dashboard, click **App Review** > **Permissions and Features**.
2.  Search for **`whatsapp_business_messaging`**.
3.  Check the **Access Level** column.
    *   If it says **Standard Access**, the bot will **IGNORE** customers.
    *   Click **Request Advanced Access**.
4.  Once it says **Advanced Access**, your bot will reply to everyone.

### Step 3: Add Payment Method
To avoid messaging limits, ensure a payment method is added to your WhatsApp Business Account in [Business Manager](https://business.facebook.com/settings/whatsapp-accounts).

---

# 🚀 24/7 Hosting Guide (Always On)

To keep the automation running while you sleep, use one of these methods:

## Option A: Cost-Effective (Render.com + Cron Job)
1. Deploy this code to **Render.com** as a "Web Service" (Free Tier).
2. Render puts free servers to sleep after 15 minutes of inactivity.
3. To prevent this, go to **[cron-job.org](https://console.cron-job.org)** (Free).
4. Create a new cron job that hits your URL: `https://your-app-name.onrender.com/ping`
5. Set it to run **Every 5 Minutes**.
6. This will keep the server awake 24/7.

## Option B: Robust (VPS + PM2)
If you have a VPS (DigitalOcean, Hetzner, AWS Lightsail), use PM2 to manage the process.

1. Install PM2:
   ```bash
   npm install -g pm2
   ```
2. Start the server with the config file:
   ```bash
   pm2 start ecosystem.config.js
   ```
3. Save the list (so it restarts on reboot):
   ```bash
   pm2 save
   pm2 startup
   ```
4. This ensures the server **Auto-Restarts** if it crashes or if the machine reboots.
