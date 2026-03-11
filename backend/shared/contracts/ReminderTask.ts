export type ReminderTaskStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';

export interface ReminderTask {
  id: string;
  leadId: string;
  payload: Record<string, unknown>;
  scheduledAt: number;
  status: ReminderTaskStatus;
  attemptCount: number;
  lastError?: string;
}
