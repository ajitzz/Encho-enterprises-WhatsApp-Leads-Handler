import { EventEmitter } from 'events';

export const updateEmitter = new EventEmitter();
updateEmitter.setMaxListeners(100);

export const broadcastUpdate = (candidateId?: string) => {
    updateEmitter.emit('update', { candidateId });
};

export const onUpdate = (callback: (data: { candidateId?: string }) => void) => {
    updateEmitter.on('update', callback);
    return () => updateEmitter.off('update', callback);
};

export const sendNotification = async (userId: string, message: string) => {
    // Placeholder for actual notification logic (e.g. WhatsApp, Email, Push)
    console.log(`[NOTIFICATION] To ${userId}: ${message}`);
};
