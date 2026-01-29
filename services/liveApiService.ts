
import { BotSettings, Driver, Message, SystemStats, DriverDocument, ScheduledMessage } from '../types';

const getBaseUrl = () => {
    if (typeof window === 'undefined') return '';
    const host = window.location.hostname;
    // Assuming backend is on port 3001 or proxied via Vite
    if (host === 'localhost' || host === '127.0.0.1') return ''; 
    return ''; 
};
const API_BASE_URL = getBaseUrl();

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
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            ...getHeaders(),
            ...options.headers
        }
    });
    
    if (!response.ok) {
        // Handle 401 unauthorized
        if (response.status === 401) {
            // potentially redirect to login or throw specific error
        }
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

  subscribeToUpdates: (callback: (drivers: Driver[]) => void) => {
      // Mock implementation of polling or SSE
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
      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', path);
      
      const response = await fetch(`${API_BASE_URL}/api/media/upload`, {
          method: 'POST',
          headers: {
              'Authorization': `Bearer ${authToken}`
          },
          body: formData
      });
      
      if (!response.ok) {
           const errorBody = await response.text();
           throw new Error(errorBody || 'Upload failed');
      }
      return response.json();
  },

  syncFileToWhatsApp: async (id: string) => {
      return apiRequest(`/api/media/${id}/sync`, { method: 'POST' });
  },

  syncFromS3: async () => {
      return apiRequest<any>('/api/media/sync-s3', { method: 'POST' });
  },

  unsetPublicFolder: async (id: string) => {
      return apiRequest(`/api/media/folders/${id}/public`, { method: 'DELETE' });
  },

  setPublicFolder: async (id: string) => {
      return apiRequest(`/api/media/folders/${id}/public`, { method: 'POST' });
  },

  renameFolder: async (id: string, name: string) => {
      return apiRequest(`/api/media/folders/${id}`, {
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
      return apiRequest(`/api/media/files/${id}`, { method: 'DELETE' });
  },

  deleteFolder: async (id: string) => {
      return apiRequest(`/api/media/folders/${id}`, { method: 'DELETE' });
  },

  getPublicShowcase: async (folderName?: string) => {
      const url = folderName ? `/api/showcase/${encodeURIComponent(folderName)}` : '/api/showcase';
      return apiRequest<any>(url);
  },

  getSystemSettings: async () => {
      return apiRequest<any>('/api/system/settings');
  },

  updateSystemSettings: async (settings: any) => {
      return apiRequest('/api/system/settings', {
          method: 'PATCH',
          body: JSON.stringify(settings)
      });
  }
};
