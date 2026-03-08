
import { BotSettings, Driver, Message, SystemStats, DriverDocument, ScheduledMessage, DriverExcelColumn, DriverExcelRow } from '../types';

// Use relative path so the Vercel proxy/rewrite handles the domain automatically.
const API_BASE_URL = ''; 
const DEFAULT_PROXY_UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // Keep below common serverless payload limits (e.g. Vercel ~4.5MB)

const resolveProxyUploadMaxBytes = () => {
    const raw = (import.meta as any)?.env?.VITE_PROXY_UPLOAD_MAX_BYTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROXY_UPLOAD_MAX_BYTES;
};

let authToken: string | null = localStorage.getItem('uber_fleet_auth_token');

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
    
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            ...getHeaders(),
            ...options.headers
        }
    });
    
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API Error ${response.status}: ${errorBody}`);
    }
    return response.json();
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

  getGoogleAuthUrl: async (): Promise<{ url: string, redirectUri: string }> => {
    return apiRequest<{ url: string, redirectUri: string }>('/api/auth/google/url');
  },

  subscribeToUpdates: (callback: (drivers: Driver[]) => void) => {
      const interval = setInterval(async () => {
          try {
              const drivers = await liveApiService.getDrivers();
              callback(drivers);
          } catch(e) {}
      }, 5000);
      return () => clearInterval(interval);
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
      const isLocalDev = ['localhost', '127.0.0.1'].includes(window.location.hostname);

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

          // Vercel serverless functions have request payload limits, so never fallback to proxy upload
          // in non-local environments (it triggers FUNCTION_PAYLOAD_TOO_LARGE for larger files).
          if (!isLocalDev) {
              throw new Error(`Direct S3 upload failed. ${directUploadMessage}. Check S3 CORS for PUT and allowed headers.`);
          }

          // Local/dev fallback where pre-signed upload may be blocked by local networking/CORS.
          const formData = new FormData();
          formData.append('file', file);
          formData.append('path', path);

          const headers: Record<string, string> = {};
          if (authToken) {
              headers['Authorization'] = `Bearer ${authToken}`;
          }

          const response = await fetch(`${API_BASE_URL}/api/media/upload`, {
              method: 'POST',
              headers,
              body: formData
          });

          if (!response.ok) {
              const errorBody = await response.text();
              throw new Error(errorBody || directUploadMessage || 'Upload failed');
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

  getDriverExcelReport: async (search: string = ''): Promise<{ columns: DriverExcelColumn[]; rows: DriverExcelRow[] }> => {
      return apiRequest(`/api/reports/driver-excel?search=${encodeURIComponent(search)}`);
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
  }
};
