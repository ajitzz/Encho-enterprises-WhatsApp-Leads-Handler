import { authError, readCredentialFromRequest, verifyGoogleCredential } from './_shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return authError(res, 405, 'Method not allowed');
  }

  const credential = readCredentialFromRequest(req);
  if (!credential) {
    return authError(res, 400, 'Missing credential');
  }

  try {
    const { payload, isAuthorized } = await verifyGoogleCredential(credential);

    if (!isAuthorized) {
      return authError(res, 403, 'Access denied. You are not registered as a staff member.');
    }

    return res.status(200).json({
      success: true,
      user: {
        ...payload,
        role: 'admin',
        staffId: null,
      },
    });
  } catch (error) {
    return authError(res, 401, error instanceof Error ? error.message : 'Invalid Google credential');
  }
}
