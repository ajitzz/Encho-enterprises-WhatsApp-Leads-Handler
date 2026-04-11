import crypto from "crypto";

export const upsertCandidateFromInbound = async ({ client, phoneNumber, name, lastMessage, nowMs }) => {
  const result = await client.query(
    `INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at, is_human_mode, variables)
     VALUES ($1, $2, $3, 'New', $4, $5, FALSE, '{}')
     ON CONFLICT (phone_number)
     DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), candidates.name),
       last_message = EXCLUDED.last_message,
       last_message_at = EXCLUDED.last_message_at
     RETURNING *`,
    [crypto.randomUUID(), phoneNumber, name, lastMessage, nowMs]
  );

  return result.rows[0] || null;
};

export const findInboundMessageByWhatsappId = async ({ client, whatsappMessageId }) => {
  const result = await client.query('SELECT id FROM candidate_messages WHERE whatsapp_message_id = $1', [whatsappMessageId]);
  return result.rows[0] || null;
};

export const insertInboundMessage = async ({ client, candidateId, text, type, whatsappMessageId }) => {
  const result = await client.query(
    `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
     VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW())
     ON CONFLICT (whatsapp_message_id) DO NOTHING
     RETURNING id`,
    [crypto.randomUUID(), candidateId, text, type, whatsappMessageId]
  );

  return result.rows[0] || null;
};

export default {
  findInboundMessageByWhatsappId,
  insertInboundMessage,
  upsertCandidateFromInbound,
};
