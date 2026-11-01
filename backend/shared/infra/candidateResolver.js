export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidUuid = (value) => {
  if (!value || typeof value !== 'string') return false;
  return UUID_REGEX.test(value.trim());
};

export const resolveCandidateIdSafe = async (client, candidateParam) => {
  if (!candidateParam || typeof candidateParam !== 'string') return null;
  const trimmed = candidateParam.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;

  if (isValidUuid(trimmed)) {
    return trimmed;
  }

  try {
    const cleanPhone = trimmed.replace(/\D/g, '');
    const r = await client.query(
      'SELECT id FROM candidates WHERE id::text = $1 OR phone_number = $2 OR phone_number = $3 LIMIT 1',
      [trimmed, trimmed, cleanPhone || trimmed]
    );
    if (r?.rows && r.rows.length > 0) {
      return r.rows[0].id;
    }
  } catch {
    return null;
  }
  return null;
};

export default {
  UUID_REGEX,
  isValidUuid,
  resolveCandidateIdSafe,
};
