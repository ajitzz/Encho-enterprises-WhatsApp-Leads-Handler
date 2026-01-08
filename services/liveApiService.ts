
import { Lead, BotSettings, Company } from '../types';

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE_URL = isLocal ? 'http://localhost:3001' : ''; 

let CURRENT_COMPANY_ID = '1'; // Default

// ENTERPRISE RESILIENCE: Retry wrapper for Fetch
const fetchWithRetry = async (url: string, options?: RequestInit, retries = 3, delay = 500): Promise<Response> => {
    // Inject Company ID into headers
    const headers = new Headers(options?.headers || {});
    headers.set('x-company-id', CURRENT_COMPANY_ID);
    
    const newOptions = { ...options, headers };

    try {
        const response = await fetch(url, newOptions);
        if (!response.ok) {
             // If server error (500-599), retry
             if (response.status >= 500) {
                 if (retries > 0) throw new Error('Server Error');
             }
             return response;
        }
        return response;
    } catch (err) {
        if (retries > 0) {
            await new Promise(res => setTimeout(res, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 2); // Exponential backoff
        }
        throw err;
    }
};

export const liveApiService = {
  setCompanyId: (id: string) => {
      CURRENT_COMPANY_ID = id;
  },

  getCompanies: async (): Promise<Company[]> => {
      try {
          const response = await fetchWithRetry(`${API_BASE_URL}/api/companies`);
          if (!response.ok) throw new Error('Failed to fetch companies');
          return await response.json();
      } catch (e) {
          return [];
      }
  },

  // Fetch leads (generic)
  getLeads: async (): Promise<Lead[]> => {
    try {
      const url = `${API_BASE_URL}/api/leads`;
      const response = await fetchWithRetry(url);
      if (!response.ok) throw new Error('API Error');
      return await response.json();
    } catch (error: any) {
      console.warn("Fetch Error (handled):", error);
      throw error;
    }
  },

  // Optimized Polling (2 Seconds)
  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(async () => {
        try {
            await callback();
        } catch(e) {
            // Silently fail on individual poll errors to maintain "Connected" illusion
        }
    }, 2000); 
    return () => clearInterval(interval);
  },

  // --- BOT SETTINGS API ---
  
  getBotSettings: async (): Promise<BotSettings> => {
    try {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/bot-settings`);
      if (!response.ok) throw new Error('Failed to fetch bot settings');
      return await response.json();
    } catch (error) {
      console.warn("Could not fetch live bot settings, using default");
      return { 
          companyId: CURRENT_COMPANY_ID,
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

  // --- ACTIONS ---

  sendMessage: async (leadId: string, text: string) => {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId, text })
    });
    if (!response.ok) throw new Error('Failed to send message');
    return await response.json();
  },

  updateLead: async (leadId: string, updates: Partial<Lead>) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/leads/${leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
      });
      if (!response.ok) throw new Error('Failed to update lead');
      return await response.json();
  },

  // --- S3 MEDIA UPLOAD (ROBUST PRESIGNED FLOW) ---
  uploadMedia: async (file: File, folderPath: string = '/') => {
      // 1. Request Presigned URL
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

      // 2. Upload Direct to S3
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

      // 3. Register File in DB
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

  // --- NEW: PUBLIC SHOWCASE APIs ---
  setPublicFolder: async (folderId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${folderId}/public`, {
          method: 'POST'
      });
      if (!response.ok) throw new Error('Failed to set public folder');
      return await response.json();
  },

  unsetPublicFolder: async (folderId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${folderId}/public`, {
          method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to unset public folder');
      return await response.json();
  },

  getPublicShowcase: async (folderName?: string) => {
      // Public showcase is generic but usually filtered by folder name which is company specific
      const url = folderName 
        ? `${API_BASE_URL}/api/public/showcase?folder=${encodeURIComponent(folderName)}`
        : `${API_BASE_URL}/api/public/showcase`;
      const response = await fetch(url); // Public doesn't need headers
      if (!response.ok) throw new Error('Failed to fetch showcase');
      return await response.json();
  },

  getShowcaseStatus: async () => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/public/status`);
      if (!response.ok) throw new Error('Failed to fetch status');
      return await response.json();
  },

  // --- SYNC TO WHATSAPP ---
  syncFileToWhatsApp: async (fileId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/files/${fileId}/sync`, {
          method: 'POST'
      });
      if (!response.ok) throw new Error('Sync failed');
      return await response.json();
  },

  getMediaLibrary: async (path: string = '/') => {
      // Encode path for URL safety
      const encodedPath = encodeURIComponent(path);
      const response = await fetchWithRetry(`${API_BASE_URL}/api/media?path=${encodedPath}`);
      if (!response.ok) throw new Error('Failed to fetch media');
      return await response.json(); // Returns { folders: [], files: [] }
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
      const response = await fetchWithRetry(`${API_BASE_URL}/api/files/${id}`, {
          method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to delete file');
      return await response.json();
  },

  deleteFolder: async (id: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${id}`, {
          method: 'DELETE'
      });
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
      const response = await fetchWithRetry(`${API_BASE_URL}/api/assistant/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, history })
      });
      if (!response.ok) throw new Error('Failed to chat with assistant');
      return await response.json();
  }
};
