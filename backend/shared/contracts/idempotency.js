export const buildStageTransitionFingerprint = ({ leadId, fromStage, toStage, changedAt } = {}) => {
  if (!leadId) throw new Error('leadId is required');
  if (!fromStage) throw new Error('fromStage is required');
  if (!toStage) throw new Error('toStage is required');

  const changedAtMs = Number(changedAt || Date.now());
  const changedAtBucket = Math.floor(changedAtMs / (60 * 1000));
  return `${leadId}:${fromStage}->${toStage}:${changedAtBucket}`;
};

export default {
  buildStageTransitionFingerprint,
};
