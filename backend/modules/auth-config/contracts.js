export const AUTH_CONFIG_SCHEMA_VERSION = '1.0.0';

export function validateAuthConfigUpdateInput(input = {}) {
  const {
    actor,
    googleClientId,
    publicAppUrl,
    schemaVersion = AUTH_CONFIG_SCHEMA_VERSION,
  } = input;

  if (!actor || typeof actor !== 'string') {
    throw new Error('auth-config.contract: actor is required');
  }

  if (!googleClientId || typeof googleClientId !== 'string') {
    throw new Error('auth-config.contract: googleClientId is required');
  }

  if (!publicAppUrl || typeof publicAppUrl !== 'string') {
    throw new Error('auth-config.contract: publicAppUrl is required');
  }

  return {
    schemaVersion,
    actor,
    googleClientId: googleClientId.trim(),
    publicAppUrl: publicAppUrl.trim(),
  };
}
