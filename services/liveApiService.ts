
import { Driver, BotSettings } from '../types';

// Determine Base URL:
// In Vercel, API is served relative to root (e.g. /api/drivers).
// In Localhost, we might run separate frontend/backend ports.
const getBaseUrl = () => {
    if (typeof window === 'undefined') return ''; // Server-side
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://localhost:3001'; // Default local backend port
    }
    return ''; // Relative path for production
};

const API_BASE_URL = getBaseUrl();

// ENTERPRISE RESILIENCE: Retry wrapper for Fetch
const fetchWithRetry = async (url: string, options?: RequestInit, retries = 3, delay = 500): Promise<Response> => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
             // If server error (500-599), retry
             if (response.status >= 500) {
                 if (retries > 0) {
                     await new Promise(res => setTimeout(res, delay));
                     return fetchWithRetry(url, options, retries - 1, delay * 2);
                 }
                 throw new Error(`Server Error: ${response.status}`);
             }
             // For 404s, fail fast so UI knows
             return response;
        }
        return response;
    } catch (err) {
        if (retries > 0) {
            await new Promise(res => setTimeout(res, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 2); 
        }
        throw err;
    }
};

export const liveApiService = {
  getDrivers: async (): Promise<Driver[]> => {
    try {
      const url = `${API_BASE_URL}/api/drivers`;
      const response = await fetchWithRetry(url);
      if (!response.ok) {
          console.error(`Failed to fetch drivers: ${response.status}`);
          throw new Error('API Error');
      }
      return await response.json();
    } catch (error: any) {
      console.warn("Fetch Error (handled):", error);
      throw error;
    }
  },

  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(async () => {
        try {
            await callback();
        } catch(e) {}
    }, 2000); 
    return () => clearInterval(interval);
  },

  getBotSettings: async (): Promise<BotSettings> => {
    try {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/bot-settings`);
      if (!response.ok) throw new Error('Failed to fetch bot settings');
      return await response.json();
    } catch (error) {
      console.warn("Could not fetch live bot settings, using default");
      return { 
          isEnabled: true, 
          routingStrategy: 'HYBRID_BOT_FIRST', 
          systemInstruction: '', 
          steps: [] 
      };
    }
  },

  saveBotSettings: async (settings: BotSettings) => {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/bot-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!response.ok) throw new Error('Failed to save settings');
    return await response.json();
  },

  sendMessage: async (driverId: string, text: string) => {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId, text })
    });
    if (!response.ok) throw new Error('Failed to send message');
    return await response.json();
  },

  updateDriver: async (driverId: string, updates: Partial<Driver>) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/drivers/${driverId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
      });
      if (!response.ok) throw new Error('Failed to update driver');
      return await response.json();
  },

  uploadMedia: async (file: File, folderPath: string = '/') => {
      const presignResponse = await fetchWithRetry(`${API_BASE_URL}/api/s3/presign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              filename: file.name,
              fileType: file.type,
              folderPath
          })
      });
      
      if (!presignResponse.ok) throw new Error('Failed to get upload permission');
      const { uploadUrl, key, publicUrl } = await presignResponse.json();

      const uploadResponse = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: {
              'Content-Type': file.type
          }
      });

      if (!uploadResponse.ok) {
          console.error("S3 Upload Failed", await uploadResponse.text());
          throw new Error(`Upload failed: ${uploadResponse.statusText}`);
      }

      const fileType = file.type.split('/')[0];
      const registerResponse = await fetchWithRetry(`${API_BASE_URL}/api/files/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              key,
              url: publicUrl,
              filename: file.name,
              type: fileType,
              folderPath
          })
      });

      if (!registerResponse.ok) throw new Error('Failed to register file');
      return { url: publicUrl, type: fileType };
  },

  syncFromS3: async () => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/media/sync`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to sync S3');
      return await response.json();
  },

  setPublicFolder: async (folderId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${folderId}/public`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to set public folder');
      return await response.json();
  },

  unsetPublicFolder: async (folderId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${folderId}/public`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to unset public folder');
      return await response.json();
  },

  getPublicShowcase: async (folderName?: string) => {
      const url = folderName 
        ? `${API_BASE_URL}/api/public/showcase?folder=${encodeURIComponent(folderName)}`
        : `${API_BASE_URL}/api/public/showcase`;
      const response = await fetchWithRetry(url);
      if (!response.ok) throw new Error('Failed to fetch showcase');
      return await response.json();
  },

  getShowcaseStatus: async () => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/public/status`);
      if (!response.ok) throw new Error('Failed to fetch status');
      return await response.json();
  },

  syncFileToWhatsApp: async (fileId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/files/${fileId}/sync`, { method: 'POST' });
      if (!response.ok) throw new Error('Sync failed');
      return await response.json();
  },

  getMediaLibrary: async (path: string = '/') => {
      const encodedPath = encodeURIComponent(path);
      const response = await fetchWithRetry(`${API_BASE_URL}/api/media?path=${encodedPath}`);
      if (!response.ok) throw new Error('Failed to fetch media');
      return await response.json();
  },

  createFolder: async (name: string, parentPath: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parentPath })
      });
      if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Error ${response.status}: Failed to create folder`);
      }
      return await response.json();
  },

  renameFolder: async (id: string, newName: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
      });
      if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Error ${response.status}: Failed to rename folder`);
      }
      return await response.json();
  },

  deleteMediaFile: async (id: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/files/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete file');
      return await response.json();
  },

  deleteFolder: async (id: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete folder');
      return await response.json();
  },

  configureWebhook: async (config: any) => {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/configure-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    return await response.json();
  },

  updateCredentials: async (credentials: any) => {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/update-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    });
    return await response.json();
  },
  
  sendAssistantMessage: async (message: string, history: any[]) => {
      // Stub for future AI assistant
      return { text: "AI Assistant is disabled in this mode." };
  }
};
