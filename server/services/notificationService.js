const { withDb } = require('../db');
const { EventEmitter } = require('events');

const updateEmitter = new EventEmitter();

const createNotification = async (userId, title, message, type = 'info', link = null) => {
  try {
    await withDb(async (client) => {
      await client.query(
        'INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1, $2, $3, $4, $5)',
        [userId, title, message, type, link]
      );
      updateEmitter.emit('notification', { userId });
    });
  } catch (err) {
    console.error('Failed to create notification:', err);
  }
};

module.exports = {
  updateEmitter,
  createNotification,
};
