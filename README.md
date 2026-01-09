
# Uber Fleet Recruiter

A comprehensive recruitment dashboard for Uber Fleet management featuring AI-powered lead qualification, WhatsApp integration, and a persistent PostgreSQL database.

## 🔑 How to Get API Keys

To run this project, you need credentials from the following services. Create a file named `.env` in the root folder and add them there (use `.env.example` as a template).

### 1. Database (PostgreSQL)
*   **Service:** [Neon.tech](https://neon.tech) (Free Tier recommended)
*   **Steps:**
    1.  Create a project.
    2.  Copy the **Connection String** from the dashboard.
    3.  Set as `POSTGRES_URL` in your `.env` file.

### 2. AI Intelligence
*   **Service:** [Google AI Studio](https://aistudio.google.com/app/apikey)
*   **Steps:**
    1.  Click **Get API Key**.
    2.  Click **Create API Key**.
    3.  Set as `GEMINI_API_KEY` in your `.env` file.

### 3. WhatsApp Integration
*   **Service:** [Meta for Developers](https://developers.facebook.com/)
*   **Steps:**
    1.  Create a Business App.
    2.  Add **WhatsApp** product.
    3.  Go to **API Setup**.
    4.  Copy **Temporary Access Token** (or generate a permanent one via Business Settings). Set as `META_API_TOKEN`.
    5.  Copy **Phone Number ID**. Set as `PHONE_NUMBER_ID`.

---

## 🚀 Quick Setup (Vercel + Neon Postgres)

This project is optimized for deployment on Vercel with Neon (PostgreSQL).

### 1. Deploy to Vercel
1. Push this code to a GitHub repository.
2. Go to [Vercel](https://vercel.com) and click **Add New > Project**.
3. Select your repository and click **Deploy**.

### 2. Connect Database (Neon)
1. Once deployed (or during setup), go to the **Storage** tab in your Vercel Project Dashboard.
2. Click **Connect Database**.
3. Select **Postgres** (powered by Neon).
4. Click **Create** > **Connect**.
5. Vercel will automatically add the `POSTGRES_URL` and `POSTGRES_PRISMA_URL` environment variables to your project.
6. **Redeploy** your project (Go to Deployments > Redeploy) so the server picks up the new variables.

### 3. Verify Connection
1. Open your deployed app.
2. The database tables (`drivers`, `messages`) will be created automatically on the first run.
3. You can verify the connection status by visiting: `https://your-app.vercel.app/api/system/stats`

## 🛠 Local Development

To run this locally with the live database:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Setup Environment:
   Create a `.env` file and paste your keys (see section above).

3. Start the server:
   ```bash
   node server.js
   ```

4. Start the frontend:
   ```bash
   npm start
   ```
