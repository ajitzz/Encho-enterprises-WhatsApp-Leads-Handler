
# WhatsApp API Integration Setup

To make the automation work, you must connect your local computer to the Internet so Meta (Facebook) can send you messages.

### 🛑 CRITICAL: Enable "Live Mode" for Real Users

If test messages work but **real WhatsApp users are ignored**:

1.  Go to **[Meta for Developers](https://developers.facebook.com)**.
2.  Open your App ("Encho Enterprises").
3.  Look at the **Top Right Corner** of the dashboard.
4.  You will see a toggle switch: **App Mode**.
5.  If it says **Development**, you can only message specific "Tester" numbers.
6.  **Switch it to LIVE**.
    *   *Note: You may need to provide a Privacy Policy URL in Settings > Basic to enable Live Mode.*

---

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
