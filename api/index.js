export default async function handler(req, res) {
  if (req.url === '/api/auth/google') {
    const { default: authGoogleHandler } = await import('./auth/google.js');
    return authGoogleHandler(req, res);
  }

  if (req.url === '/api/auth/me') {
    const { default: authMeHandler } = await import('./auth/me.js');
    return authMeHandler(req, res);
  }

  return res.status(404).json({ error: 'Route not found' });
}
