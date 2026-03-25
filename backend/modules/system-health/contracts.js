export const SYSTEM_HEALTH_SCHEMA_VERSION = '1.0.0';

export function validateSystemHealthSnapshot(input = {}) {
  const {
    status,
    timestamp,
    dependencies = {},
    degradedReasons = [],
    schemaVersion = SYSTEM_HEALTH_SCHEMA_VERSION,
  } = input;

  if (!status || !['ok', 'degraded', 'down'].includes(String(status))) {
    throw new Error('system-health.contract: status is invalid');
  }

  const timestampIso = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
  if (Number.isNaN(Date.parse(timestampIso))) {
    throw new Error('system-health.contract: timestamp must be a valid timestamp');
  }

  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
    throw new Error('system-health.contract: dependencies must be an object');
  }

  if (!Array.isArray(degradedReasons) || degradedReasons.some((item) => typeof item !== 'string')) {
    throw new Error('system-health.contract: degradedReasons must be a string array');
  }

  return {
    schemaVersion,
    status: String(status),
    timestamp: timestampIso,
    dependencies,
    degradedReasons,
  };
}

export default {
  SYSTEM_HEALTH_SCHEMA_VERSION,
  validateSystemHealthSnapshot,
};
