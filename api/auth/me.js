import { authError, verifyGoogleCredential } from './_shared.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return authError(res, 405, 'Method not allowed');
  }

  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  if (!token) {
    return authError(res, 401, 'Unauthorized');
  }

  try {
    const { payload, isAuthorized } = await verifyGoogleCredential(token);

    if (!isAuthorized) {
      return authError(res, 403, 'Access denied. You are not registered as a staff member.');
    }

    return res.status(200).json({ success: true, user: { ...payload, role: 'admin', staffId: null } });
  } catch (error) {
    return authError(res, 401, error instanceof Error ? error.message : 'Unauthorized');
  }
}
