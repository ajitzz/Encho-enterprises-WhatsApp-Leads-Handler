import { OAuth2Client } from 'google-auth-library';

const DEFAULT_ADMIN_EMAILS = ['ajithsabzz@gmail.com', 'enchoenterprises@gmail.com'];

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const resolveAuthorizedEmails = () => {
  const fromEnv = (process.env.AUTHORIZED_ADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);

  return new Set([...DEFAULT_ADMIN_EMAILS, ...fromEnv].map(normalizeEmail));
};

const readJsonBody = (req) => {
  if (req?.body && typeof req.body === 'object') return req.body;
  if (typeof req?.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
};

const googleClientId = (process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClient = new OAuth2Client(googleClientId || undefined);

export const verifyGoogleCredential = async (credential) => {
  if (!googleClientId) {
    throw new Error('Google client ID is not configured in environment variables.');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: googleClientId,
  });

  const payload = ticket.getPayload() || {};
  const email = normalizeEmail(payload.email);
  const isAuthorized = resolveAuthorizedEmails().has(email);

  return {
    payload,
    email,
    isAuthorized,
  };
};

export const authError = (res, status, error) => {
  res.status(status).json({ success: false, error });
};

export const readCredentialFromRequest = (req) => {
  const body = readJsonBody(req);
  return typeof body.credential === 'string' ? body.credential.trim() : '';
};
