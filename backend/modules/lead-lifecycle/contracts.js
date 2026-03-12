const STAGE_TRANSITION_SCHEMA_VERSION = '1.0.0';

const ALLOWED_STAGE_NAMES = new Set([
  'New',
  'Contacted',
  'Qualified',
  'Interested',
  'Interview Scheduled',
  'Hired',
  'Rejected',
  'Lost',
]);

function validateStageTransitionInput(input = {}) {
  const {
    leadId,
    fromStage,
    toStage,
    actor,
    reason = null,
    changedAt,
    schemaVersion = STAGE_TRANSITION_SCHEMA_VERSION,
  } = input;

  if (!leadId || typeof leadId !== 'string') throw new Error('lead-lifecycle.contract: leadId is required');
  if (!fromStage || !ALLOWED_STAGE_NAMES.has(fromStage)) throw new Error('lead-lifecycle.contract: fromStage is invalid');
  if (!toStage || !ALLOWED_STAGE_NAMES.has(toStage)) throw new Error('lead-lifecycle.contract: toStage is invalid');
  if (!actor || typeof actor !== 'string') throw new Error('lead-lifecycle.contract: actor is required');

  const changedAtIso = Number.isFinite(changedAt) ? new Date(changedAt).toISOString() : String(changedAt || '');
  if (!changedAtIso || Number.isNaN(Date.parse(changedAtIso))) {
    throw new Error('lead-lifecycle.contract: changedAt must be a valid timestamp');
  }

  return {
    schemaVersion,
    leadId,
    fromStage,
    toStage,
    actor,
    reason,
    changedAt: changedAtIso,
  };
}

module.exports = {
  STAGE_TRANSITION_SCHEMA_VERSION,
  ALLOWED_STAGE_NAMES,
  validateStageTransitionInput,
};
