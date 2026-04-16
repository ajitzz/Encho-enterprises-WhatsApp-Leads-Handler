
import { BotSettings, Driver, Message, SystemStats, DriverDocument, ScheduledMessage, DriverExcelColumn, DriverExcelRow, UserRole } from '../types';

// Default to same-origin for Vercel-style rewrites, but allow explicit override for
// Cloudflare static deployments where API may run on a separate origin.
const RAW_API_BASE_URL = (import.meta as any)?.env?.VITE_API_BASE_URL || '';
const API_BASE_URL = String(RAW_API_BASE_URL).replace(/\/$/, '');

export const buildApiUrl = (endpoint: string) => {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${API_BASE_URL}${normalizedEndpoint}`;
};

const isCloudflareWorkersHost = typeof window !== 'undefined' && /\.workers\.dev$/i.test(window.location.hostname);
let didPrintCloudflareApiHint = false;

const maybeWarnCloudflareApiBase = (details?: string) => {
    if (didPrintCloudflareApiHint) return;
    if (!isCloudflareWorkersHost) return;
    if (API_BASE_URL) return;
    didPrintCloudflareApiHint = true;
    const extra = details ? ` (${details})` : '';
    console.warn(
      `[Cloudflare API Hint] Frontend is running on workers.dev with same-origin API base${extra}. ` +
      `Set VITE_API_BASE_URL to your backend origin and redeploy production.`
    );
};
const DEFAULT_PROXY_UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // Keep below common serverless payload limits (e.g. Vercel ~4.5MB)

const resolveProxyUploadMaxBytes = () => {
    const raw = (import.meta as any)?.env?.VITE_PROXY_UPLOAD_MAX_BYTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROXY_UPLOAD_MAX_BYTES;
};

let authToken: string | null = localStorage.getItem('uber_fleet_auth_token');

export type UpdateConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'polling' | 'disconnected';
export interface DueAlertItem {
  event_id: string;
  event_type: 'followup_due' | 'review_due';
  lead_id: string;
  lead_name: string;
  scheduled_at: string;
  owner_staff_id: string | null;
  owner_staff_name: string | null;
  review_status?: string | null;
}

interface SubscribeToUpdatesOptions {
    driverId?: string;
    pollIntervalMs?: number;
    onMessages?: (messages: Message[]) => void;
    onScheduledMessages?: (items: ScheduledMessage[]) => void;
    onConnectionStateChange?: (state: UpdateConnectionState) => void;
    onSyncFailure?: (details: { channel: 'push' | 'polling'; endpoint: string; streak: number; error: unknown }) => void;
    onSyncRecovery?: (details: { channel: 'push' | 'polling'; endpoint: string; previousStreak: number }) => void;
}

export const setAuthToken = (token: string) => {
    authToken = token;
    localStorage.setItem('uber_fleet_auth_token', token);
};

const getHeaders = () => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    return headers;
};

// Generic fetch wrapper
const apiRequest = async <T>(endpoint: string, options: RequestInit = {}): Promise<T> => {
    // Ensure endpoint starts with /api if not provided, but server.js mounts on /api so just be careful
    // We assume the caller passes '/api/...' or just '/drivers' if rewrite handles it.
    // Based on previous code, let's strictly use the endpoint passed.
    
    maybeWarnCloudflareApiBase('before request');
    const response = await fetch(buildApiUrl(endpoint), {
        ...options,
        headers: {
            ...getHeaders(),
            ...options.headers
        }
    });
    
    if (!response.ok) {
        if (response.status === 405 && isCloudflareWorkersHost && !API_BASE_URL) {
            maybeWarnCloudflareApiBase('received 405 on same-origin /api path');
        }
        const errorBody = await response.text();
        throw new Error(`API Error ${response.status}: ${errorBody}`);
    }

    if (response.status === 204) {
        return undefined as T;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }

    const bodyText = await response.text();
    if (!bodyText) return undefined as T;
    try {
        return JSON.parse(bodyText) as T;
    } catch {
        return bodyText as T;
    }
};

export const liveApiService = {
  getBotSettings: async (): Promise<BotSettings> => {
    return apiRequest<BotSettings>('/api/bot/settings');
  },

  saveBotSettings: async (settings: any) => {
    return apiRequest('/api/bot/save', {
      method: 'POST',
      body: JSON.stringify(settings)
    });
  },

  publishBot: async () => {
      return apiRequest('/api/bot/publish', { method: 'POST' });
  },

  getDrivers: async (): Promise<Driver[]> => {
      return apiRequest<Driver[]>('/api/drivers');
  },

  verifyLogin: async (credential: string): Promise<{success: boolean, user?: any}> => {
      return apiRequest('/api/auth/google', {
          method: 'POST',
          body: JSON.stringify({ credential })
      });
  },

  getProfile: async (): Promise<{success: boolean, user: any}> => {
      return apiRequest('/api/auth/me');
  },

  subscribeToUpdates: (callback: (drivers: Driver[]) => void, options: SubscribeToUpdatesOptions = {}) => {
      const {
          driverId,
          pollIntervalMs = 10000,
          onMessages,
          onScheduledMessages,
          onConnectionStateChange,
          onSyncFailure,
          onSyncRecovery
      } = options;

      let isClosed = false;
      let consecutiveFailures = 0;
      let reconnectAttempts = 0;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let eventSource: EventSource | null = null;

      const setConnectionState = (state: UpdateConnectionState) => onConnectionStateChange?.(state);

      const fetchFallbackSnapshot = async () => {
          const [drivers, messages, scheduled] = await Promise.all([
              liveApiService.getDrivers(),
              driverId ? liveApiService.getDriverMessages(driverId, 50) : Promise.resolve(null),
              driverId ? liveApiService.getScheduledMessages(driverId) : Promise.resolve(null)
          ]);

          callback(drivers);
          if (messages && onMessages) onMessages(messages);
          if (scheduled && onScheduledMessages) onScheduledMessages(scheduled);
      };

      const stopPolling = () => {
          if (pollInterval) {
              clearInterval(pollInterval);
              pollInterval = null;
          }
      };

      const startPolling = () => {
          if (pollInterval || isClosed) return;
          setConnectionState('polling');
          pollInterval = setInterval(async () => {
              try {
                  await fetchFallbackSnapshot();
                  if (consecutiveFailures > 0) {
                      onSyncRecovery?.({ channel: 'polling', endpoint: '/api/drivers', previousStreak: consecutiveFailures });
                  }
                  consecutiveFailures = 0;
              } catch (e) {
                  consecutiveFailures += 1;
                  onSyncFailure?.({ channel: 'polling', endpoint: '/api/drivers', streak: consecutiveFailures, error: e });
                  if (consecutiveFailures >= 3) {
                      console.warn('[liveApiService] fallback polling failed repeatedly', e);
                  }
              }
          }, pollIntervalMs);
      };

      const scheduleReconnect = () => {
          if (isClosed) return;
          reconnectAttempts += 1;
          const backoffMs = Math.min(30000, 1000 * (2 ** Math.min(reconnectAttempts, 5)));
          setConnectionState('reconnecting');
          startPolling();

          reconnectTimer = setTimeout(() => {
              if (!isClosed) connectPush();
          }, backoffMs + Math.floor(Math.random() * 400));
      };

      const connectPush = () => {
          if (isClosed || typeof window === 'undefined' || typeof EventSource === 'undefined') {
              startPolling();
              return;
          }

          try {
              setConnectionState('connecting');
              const tokenQuery = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
              eventSource = new EventSource(buildApiUrl(`/api/updates/stream${tokenQuery}`));

              eventSource.onopen = () => {
                  reconnectAttempts = 0;
                  if (consecutiveFailures > 0) {
                      onSyncRecovery?.({ channel: 'push', endpoint: '/api/updates/stream', previousStreak: consecutiveFailures });
                  }
                  consecutiveFailures = 0;
                  stopPolling();
                  setConnectionState('connected');
              };

              eventSource.onmessage = (event) => {
                  if (!event.data || event.data === 'heartbeat') return;
                  try {
                      const payload = JSON.parse(event.data);
                      if (Array.isArray(payload?.drivers)) callback(payload.drivers);
                      if (driverId && payload?.messagesByDriver?.[driverId] && onMessages) {
                          onMessages(payload.messagesByDriver[driverId]);
                      }
                      if (driverId && payload?.scheduledByDriver?.[driverId] && onScheduledMessages) {
                          onScheduledMessages(payload.scheduledByDriver[driverId]);
                      }
                  } catch {
                      // Ignore malformed update events and continue streaming.
                  }
              };

              eventSource.onerror = () => {
                  consecutiveFailures += 1;
                  onSyncFailure?.({ channel: 'push', endpoint: '/api/updates/stream', streak: consecutiveFailures, error: new Error('EventSource disconnected') });
                  eventSource?.close();
                  eventSource = null;
                  scheduleReconnect();
              };
          } catch {
              consecutiveFailures += 1;
              onSyncFailure?.({ channel: 'push', endpoint: '/api/updates/stream', streak: consecutiveFailures, error: new Error('Failed to connect EventSource') });
              scheduleReconnect();
          }
      };

      fetchFallbackSnapshot().catch((e) => {
          onSyncFailure?.({ channel: 'polling', endpoint: '/api/drivers', streak: 1, error: e });
          console.warn('[liveApiService] initial update snapshot failed', e);
      });
      connectPush();

      return () => {
          isClosed = true;
          setConnectionState('disconnected');
          stopPolling();
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (eventSource) eventSource.close();
      };
  },

  updateDriver: async (id: string, updates: Partial<Driver>) => {
      return apiRequest(`/api/drivers/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates)
      });
  },

  getDriverMessages: async (id: string, limit: number = 50, beforeTimestamp?: number): Promise<Message[]> => {
      let url = `/api/drivers/${id}/messages?limit=${limit}`;
      if (beforeTimestamp) url += `&before=${beforeTimestamp}`;
      return apiRequest<Message[]>(url);
  },

  sendMessage: async (driverId: string, text: string, options?: any) => {
      return apiRequest(`/api/drivers/${driverId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text, ...options })
      });
  },

  getDriverDocuments: async (driverId: string): Promise<DriverDocument[]> => {
      return apiRequest<DriverDocument[]>(`/api/drivers/${driverId}/documents`);
  },

  getScheduledMessages: async (driverId: string): Promise<ScheduledMessage[]> => {
      return apiRequest<ScheduledMessage[]>(`/api/drivers/${driverId}/scheduled-messages`);
  },

  cancelScheduledMessage: async (msgId: string) => {
      return apiRequest(`/api/scheduled-messages/${msgId}`, { method: 'DELETE' });
  },

  updateScheduledMessage: async (msgId: string, updates: any) => {
      return apiRequest(`/api/scheduled-messages/${msgId}`, {
          method: 'PATCH',
          body: JSON.stringify(updates)
      });
  },

  scheduleMessage: async (driverIds: string[], message: any, timestamp: number) => {
      return apiRequest('/api/scheduled-messages', {
          method: 'POST',
          body: JSON.stringify({ driverIds, message, timestamp })
      });
  },

  sendAssistantMessage: async (input: string, history: any[]) => {
      return apiRequest<any>('/api/ai/assistant', {
          method: 'POST',
          body: JSON.stringify({ input, history })
      });
  },

  updateCredentials: async (creds: any) => {
      return apiRequest('/api/system/credentials', {
          method: 'POST',
          body: JSON.stringify(creds)
      });
  },

  configureWebhook: async (config: any) => {
      return apiRequest('/api/system/webhook', {
          method: 'POST',
          body: JSON.stringify(config)
      });
  },

  getShowcaseStatus: async () => {
      return apiRequest<any>('/api/showcase/status');
  },

  getMediaLibrary: async (path: string) => {
      return apiRequest<any>(`/api/media?path=${encodeURIComponent(path)}`);
  },

  uploadMedia: async (file: File, path: string) => {
      try {
          const init = await apiRequest<any>('/api/media/upload/init', {
              method: 'POST',
              body: JSON.stringify({
                  path,
                  fileName: file.name,
                  contentType: file.type || 'application/octet-stream'
              })
          });

          const uploadResponse = await fetch(init.uploadUrl, {
              method: 'PUT',
              headers: init.headers || { 'Content-Type': file.type || 'application/octet-stream' },
              body: file
          });

          if (!uploadResponse.ok) {
              const errorBody = await uploadResponse.text();
              throw new Error(errorBody || 'Upload to S3 failed');
          }

          return { success: true, key: init.key, url: init.url };
      } catch (directUploadError) {
          const directUploadMessage = String((directUploadError as Error)?.message || directUploadError || 'Upload failed');

          // Fallback through backend proxy when pre-signed direct upload is blocked by bucket CORS.
          const formData = new FormData();
          formData.append('file', file);
          formData.append('path', path);

          const headers: Record<string, string> = {};
          if (authToken) {
              headers['Authorization'] = `Bearer ${authToken}`;
          }

          const response = await fetch(buildApiUrl('/api/media/upload'), {
              method: 'POST',
              headers,
              body: formData
          });

          if (!response.ok) {
              const errorBody = await response.text();
              const combinedError = `${directUploadMessage}${errorBody ? ` | Proxy upload failed: ${errorBody}` : ''}`;
              throw new Error(combinedError || 'Upload failed');
          }

          return response.json();
      }
  },

  syncFileToWhatsApp: async (id: string) => {
      return apiRequest(`/api/media/${id}/sync`, { method: 'POST' });
  },

  syncFromS3: async () => {
      return apiRequest<any>('/api/media/sync-s3', { method: 'POST' });
  },

  unsetPublicFolder: async (id: string) => {
      return apiRequest(`/api/media/folders/${encodeURIComponent(id)}/public`, { method: 'DELETE' });
  },

  setPublicFolder: async (id: string) => {
      return apiRequest(`/api/media/folders/${encodeURIComponent(id)}/public`, { method: 'POST' });
  },

  renameFolder: async (id: string, name: string) => {
      return apiRequest(`/api/media/folders/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name })
      });
  },

  createFolder: async (name: string, parentPath: string) => {
      return apiRequest('/api/media/folders', {
          method: 'POST',
          body: JSON.stringify({ name, parentPath })
      });
  },

  deleteMediaFile: async (id: string) => {
      return apiRequest(`/api/media/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  deleteFolder: async (id: string) => {
      return apiRequest(`/api/media/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  getPublicShowcase: async (folderName?: string) => {
      const url = folderName ? `/api/showcase/${encodeURIComponent(folderName)}` : '/api/showcase';
      return apiRequest<any>(url);
  },

  getSystemSettings: async () => {
      return apiRequest<any>('/api/system/settings');
  },

  getSystemOperationalStatus: async () => {
      return apiRequest<any>('/api/system/operational-status');
  },

  updateSystemSettings: async (settings: any) => {
      return apiRequest('/api/system/settings', {
          method: 'PATCH',
          body: JSON.stringify(settings)
      });
  },

  getDriverExcelReport: async (search: string = '', includeHidden: boolean = false): Promise<{ columns: DriverExcelColumn[]; rows: DriverExcelRow[] }> => {
      return apiRequest(`/api/reports/driver-excel?search=${encodeURIComponent(search)}&includeHidden=${includeHidden ? 'true' : 'false'}`);
  },

  getArchivedDrivers: async (): Promise<DriverExcelRow[]> => {
      return apiRequest<DriverExcelRow[]>('/api/drivers/archived');
  },

  setDriverVisibility: async (id: string, isHidden: boolean) => {
      return apiRequest(`/api/drivers/${id}/visibility`, {
          method: 'PATCH',
          body: JSON.stringify({ isHidden })
      });
  },

  getDriverExcelSyncStatus: async (): Promise<{ state: string; lastTriggeredAt?: string; lastRunAt?: string; lastSuccessAt?: string; lastError?: string; inProgress?: boolean; hasQueuedSync?: boolean; lastDurationMs?: number }> => {
      return apiRequest('/api/reports/driver-excel/sync-status');
  },

  triggerDriverExcelSync: async (mode: 'queued' | 'immediate' = 'queued') => {
      return apiRequest('/api/reports/driver-excel/sync', {
          method: 'POST',
          body: JSON.stringify({ mode })
      });
  },

  updateDriverExcelRow: async (id: string, updates: Record<string, any>) => {
      return apiRequest(`/api/reports/driver-excel/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ updates })
      });
  },

  deleteDriverExcelRow: async (id: string) => {
      return apiRequest(`/api/reports/driver-excel/${id}`, { method: 'DELETE' });
  },

  addDriverExcelColumn: async (label: string) => {
      return apiRequest('/api/reports/driver-excel/columns', {
          method: 'POST',
          body: JSON.stringify({ label })
      });
  },

  getDriverExcelVariables: async (): Promise<{ variables: Array<{ key: string; label: string }> }> => {
      return apiRequest('/api/reports/driver-excel/variables');
  },

  addDriverExcelVariableColumn: async (key: string, label: string) => {
      return apiRequest('/api/reports/driver-excel/columns', {
          method: 'POST',
          body: JSON.stringify({ key, label })
      });
  },

  renameDriverExcelColumn: async (key: string, newLabel: string) => {
      return apiRequest(`/api/reports/driver-excel/columns/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          body: JSON.stringify({ newLabel })
      });
  },

  deleteDriverExcelColumn: async (key: string) => {
      return apiRequest(`/api/reports/driver-excel/columns/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },

  reorderDriverExcelColumns: async (orderedKeys: string[]) => {
      return apiRequest('/api/reports/driver-excel/columns/reorder', {
          method: 'POST',
          body: JSON.stringify({ orderedKeys })
      });
  },

  // Staff Management
  getStaff: async (): Promise<any[]> => {
    return apiRequest<any[]>('/api/staff');
  },

  addStaff: async (staff: { email: string; name: string; role: UserRole; manager_id?: string | null }) => {
    return apiRequest('/api/staff', {
      method: 'POST',
      body: JSON.stringify(staff)
    });
  },

  deleteStaff: async (id: string) => {
    return apiRequest(`/api/staff/${id}`, { method: 'DELETE' });
  },

  sendHeartbeat: async (status: 'online' | 'idle', active_seconds?: number, idle_seconds?: number) => {
    const payload: { status: 'online' | 'idle'; active_seconds?: number; idle_seconds?: number } = { status };

    if (typeof active_seconds === 'number') payload.active_seconds = active_seconds;
    if (typeof idle_seconds === 'number') payload.idle_seconds = idle_seconds;

    return apiRequest('/api/staff/heartbeat', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  updateStaffAutoDist: async (id: string, enabled: boolean) => {
    return apiRequest(`/api/staff/${id}/auto-dist`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled })
    });
  },

  forceLogoutStaff: async (id: string) => {
    return apiRequest(`/api/staff/${id}/force-logout`, {
      method: 'POST'
    });
  },

  getLeadDistributionSettings: async () => {
    return apiRequest<any>('/api/system/lead-distribution');
  },

  updateLeadDistributionSettings: async (settings: { auto_enabled: boolean }) => {
    return apiRequest('/api/system/lead-distribution', {
      method: 'POST',
      body: JSON.stringify(settings)
    });
  },

  // Lead Management (Staff Portal)
  getLeadPool: async (): Promise<Driver[]> => {
    return apiRequest<Driver[]>('/api/leads/pool');
  },

  getMyLeads: async (): Promise<Driver[]> => {
    return apiRequest<Driver[]>('/api/leads/my');
  },

  claimLead: async (id: string) => {
    return apiRequest(`/api/leads/${id}/claim`, { method: 'POST' });
  },

  logLeadAction: async (id: string, data: { action: string; notes: string; status?: string; media_url?: string; next_followup_at?: string }) => {
    return apiRequest(`/api/leads/${id}/action`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getLeadActivity: async (id: string): Promise<any[]> => {
    return apiRequest<any[]>(`/api/leads/${id}/activity`);
  },

  assignLead: async (id: string, staffId: string) => {
    return apiRequest(`/api/leads/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ staff_id: staffId })
    });
  },

  reassignLead: async (id: string, staffId: string) => {
    return apiRequest(`/api/leads/${id}/reassign`, {
      method: 'POST',
      body: JSON.stringify({ staff_id: staffId })
    });
  },

  getReminders: async (): Promise<any[]> => {
    return apiRequest<any[]>('/api/leads/reminders');
  },

  markReminderDone: async (id: string) => {
    return apiRequest(`/api/leads/reminders/${id}/done`, { method: 'POST' });
  },

  getDueAlerts: async (): Promise<DueAlertItem[]> => {
    return apiRequest<DueAlertItem[]>('/api/notifications/due');
  },

  // Action Center & Analytics
  getActionCenter: async (staffId?: string) => {
    const query = staffId ? `?staffId=${encodeURIComponent(staffId)}` : '';
    return apiRequest<any>(`/api/analytics/action-center${query}`);
  },

  getCommandCenter: async (managerId?: string) => {
    const query = managerId ? `?managerId=${encodeURIComponent(managerId)}` : '';
    return apiRequest<any>(`/api/analytics/command-center${query}`);
  },

  getHierarchyOverview: async () => {
    return apiRequest<any>('/api/analytics/hierarchy-overview');
  },


  getStaffPresence: async () => {
    return apiRequest<any[]>('/api/staff/presence');
  },

  // Lead Reviews
  submitLeadReview: async (id: string, data: { closing_date: string; notes: string; screenshot_url?: string }) => {
    return apiRequest(`/api/reviews/${id}/submit`, {
      method: 'POST',
      body: JSON.stringify({
        closingDate: data.closing_date,
        notes: data.notes,
        screenshotUrl: data.screenshot_url
      })
    });
  },

  getPendingReviews: async (managerId: string, status: 'pending' | 'approved' | 'rejected' | 'returned_for_call_again' | 'all' = 'pending') => {
    return apiRequest<any[]>(`/api/reviews/inbox/${managerId}?status=${encodeURIComponent(status)}`);
  },

  reviewDecision: async (reviewId: string, data: { decision: 'approved' | 'rejected' | 'returned_for_call_again'; feedback?: string; reasonCode?: string }) => {
    return apiRequest(`/api/reviews/${reviewId}/decision`, {
      method: 'POST',
      body: JSON.stringify({
        status: data.decision,
        feedback: data.feedback || '',
        reasonCode: data.reasonCode || ''
      })
    });
  }
};
