export type UiFailureChannel = 'push' | 'polling' | 'ui';

interface ReportUiFailureOptions {
  channel: UiFailureChannel;
  endpoint: string;
  error: unknown;
  notifyUser?: (message: string) => void;
  notifyAdmin?: (message: string) => void;
  userThrottleMs?: number;
  adminThrottleMs?: number;
}

interface FailureState {
  streak: number;
  lastUserNotificationAt: number;
  lastAdminNotificationAt: number;
}

const failureStateByKey = new Map<string, FailureState>();

const stringifyError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
};

const getFailureState = (key: string): FailureState => {
  const existing = failureStateByKey.get(key);
  if (existing) return existing;
  const created: FailureState = { streak: 0, lastUserNotificationAt: 0, lastAdminNotificationAt: 0 };
  failureStateByKey.set(key, created);
  return created;
};

export const reportUiFailure = ({
  channel,
  endpoint,
  error,
  notifyUser,
  notifyAdmin,
  userThrottleMs = 60_000,
  adminThrottleMs = 120_000
}: ReportUiFailureOptions): number => {
  const key = `${channel}:${endpoint}`;
  const now = Date.now();
  const state = getFailureState(key);
  state.streak += 1;

  const reason = stringifyError(error);
  console.error('[ui.failure]', {
    channel,
    endpoint,
    failureStreak: state.streak,
    reason
  });

  const shouldNotifyUser = notifyUser && (state.streak === 1 || now - state.lastUserNotificationAt >= userThrottleMs);
  if (shouldNotifyUser) {
    notifyUser(`Issue detected on ${endpoint} (streak ${state.streak}).`);
    state.lastUserNotificationAt = now;
  }

  const shouldNotifyAdmin = notifyAdmin && (state.streak === 1 || now - state.lastAdminNotificationAt >= adminThrottleMs);
  if (shouldNotifyAdmin) {
    notifyAdmin(`Endpoint ${endpoint} failing repeatedly (streak ${state.streak}).`);
    state.lastAdminNotificationAt = now;
  }

  return state.streak;
};

export const reportUiRecovery = (channel: UiFailureChannel, endpoint: string): number => {
  const key = `${channel}:${endpoint}`;
  const previousStreak = failureStateByKey.get(key)?.streak ?? 0;
  if (previousStreak > 0) {
    console.info('[ui.recovery]', { channel, endpoint, recoveredAfterFailures: previousStreak });
  }
  failureStateByKey.set(key, { streak: 0, lastUserNotificationAt: 0, lastAdminNotificationAt: 0 });
  return previousStreak;
};
