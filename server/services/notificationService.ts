
import { withDb } from '../db';
import { EventEmitter } from 'events';

export const updateEmitter = new EventEmitter();

export const createNotification = async (userId: string, title: string, message: string, type: string = 'info', link: string | null = null) => {
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
