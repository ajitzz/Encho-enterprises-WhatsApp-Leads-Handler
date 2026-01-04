# Uber Fleet Recruiter

A comprehensive recruitment dashboard for Uber Fleet management featuring AI-powered lead qualification, WhatsApp integration, and a persistent PostgreSQL database.

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
3. You can verify the connection status by visiting: `https://your-app.vercel.app/api/health`

## 🛠 Local Development

To run this locally with the live database:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Pull Env Vars from Vercel (requires Vercel CLI):
   ```bash
   npm i -g vercel
   vercel link
   vercel env pull .env.local
   ```
   *Alternatively, create a `.env` file and manually paste the `POSTGRES_URL` from your Vercel Dashboard.*

3. Start the server:
   ```bash
   node server.js
   ```

4. Start the frontend:
   ```bash
   npm start
   ```

## 🔑 Environment Variables

Ensure these are set in Vercel settings:

- `POSTGRES_URL`: (Auto-set by Vercel Storage)
- `GEMINI_API_KEY`: Google Gemini AI Key
- `META_API_TOKEN`: WhatsApp Business API Token
- `PHONE_NUMBER_ID`: WhatsApp Phone Number ID
