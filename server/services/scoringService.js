const { withDb } = require('../db');
const { updateEmitter } = require('./notificationService');

const updateLeadScore = async (candidateId, points, reason = '') => {
  try {
    await withDb(async (client) => {
      await client.query(
        'UPDATE candidates SET lead_score = lead_score + $1 WHERE id = $2',
        [points, candidateId]
      );
      if (reason) {
        await client.query(
          'INSERT INTO lead_activity_log (candidate_id, action, notes) VALUES ($1, $2, $3)',
          [candidateId, 'score_update', `Score +${points}: ${reason}`]
        );
      }
      updateEmitter.emit('update', { candidateId });
    });
  } catch (err) {
    console.error('Failed to update lead score:', err);
  }
};

module.exports = {
  updateLeadScore,
};
