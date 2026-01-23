
import { Driver, BotSettings, MessageButton, Message, DriverDocument } from '../types';

// Determine Base URL
const getBaseUrl = () => {
    if (typeof window === 'undefined') return '';
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:3001';
    return ''; 
};

const API_BASE_URL = getBaseUrl();

const fetchWithRetry = async (url: string, options?: RequestInit, retries = 3, delay = 500): Promise<Response> => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
             const method = options?.method?.toUpperCase() || 'GET';
             if (method !== 'GET' && method !== 'HEAD') {
                 let errMessage = `Request Failed: ${response.status}`;
                 try {
                     const errData = await response.json();
                     if (errData.error) errMessage = errData.error;
                 } catch(e) {}
                 throw new Error(errMessage);
             }

             if (response.status >= 500) {
                 if (retries > 0) {
                     await new Promise(res => setTimeout(res, delay));
                     return fetchWithRetry(url, options, retries - 1, delay * 2);
                 }
                 let errMessage = `Server Error: ${response.status}`;
                 try {
                     const errData = await response.json();
                     if (errData.error) errMessage = errData.error;
                 } catch(e) {}
                 throw new Error(errMessage);
             }
             let errMessage = `Request Failed: ${response.status}`;
             try {
                 const errData = await response.json();
                 if (errData.error) errMessage = errData.error;
             } catch(e) {}
             throw new Error(errMessage);
        }
        return response;
    } catch (err: any) {
        const method = options?.method?.toUpperCase() || 'GET';
        if (retries > 0 && !err.message.includes('4') && (method === 'GET' || method === 'HEAD')) { 
            await new Promise(res => setTimeout(res, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 2); 
        }
        throw err;
    }
};

let lastSyncTimestamp = 0;

export const liveApiService = {
  getDrivers: async (): Promise<Driver[]> => {
    try {
      // Reset cursor on full fetch
      lastSyncTimestamp = Date.now();
      const url = `${API_BASE_URL}/api/drivers`;
      const response = await fetchWithRetry(url);
      return await response.json();
    } catch (error: any) {
      console.warn("Fetch Error (handled):", error);
      throw error;
    }
  },

  // Correct Sync Logic: Use Server Cursor
  syncDrivers: async (): Promise<Driver[]> => {
      try {
          const url = `${API_BASE_URL}/api/sync?since=${lastSyncTimestamp}`;
          const response = await fetchWithRetry(url);
          
          const data = await response.json();
          // The server now returns { drivers: [], nextCursor: number }
          if (data.nextCursor) {
              lastSyncTimestamp = data.nextCursor;
          }
          return data.drivers || [];
      } catch (e) {
          return [];
      }
  },

  // Paginated Message Fetching
  getDriverMessages: async (driverId: string, limit = 50, before?: number): Promise<Message[]> => {
      try {
          let url = `${API_BASE_URL}/api/drivers/${driverId}/messages?limit=${limit}`;
          if (before) url += `&before=${before}`;
          
          const response = await fetchWithRetry(url);
          return await response.json();
      } catch (e) {
          return [];
      }
  },

  getDriverDocuments: async (driverId: string): Promise<DriverDocument[]> => {
      try {
          const response = await fetchWithRetry(`${API_BASE_URL}/api/drivers/${driverId}/documents`);
          return await response.json();
      } catch(e) {
          return [];
      }
  },

  updateDocumentStatus: async (docId: string, status?: string, notes?: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/documents/${docId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, notes })
      });
      return await response.json();
  },

  subscribeToUpdates: (callback: (updatedDrivers: Driver[]) => void) => {
    // Polling every 6 seconds to save DB load
    const interval = setInterval(async () => {
        try { 
            const updates = await liveApiService.syncDrivers();
            if (updates.length > 0) {
                callback(updates);
            }
        } catch(e) {}
    }, 6000); 
    return () => clearInterval(interval);
  },

  getBotSettings: async (): Promise<BotSettings> => {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/bot-settings`);
    return await response.json();
  },

  saveBotSettings: async (settings: BotSettings) => {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/bot-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    return await response.json();
  },

  sendMessage: async (driverId: string, text: string, attachments?: { mediaUrl?: string, mediaType?: string, options?: string[], headerImageUrl?: string, footerText?: string, buttons?: MessageButton[], templateName?: string }) => {
    const clientMessageId = `web_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const response = await fetchWithRetry(`${API_BASE_URL}/api/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          driverId, 
          text,
          clientMessageId,
          mediaUrl: attachments?.mediaUrl,
          mediaType: attachments?.mediaType,
          options: attachments?.options,
          headerImageUrl: attachments?.headerImageUrl,
          footerText: attachments?.footerText,
          buttons: attachments?.buttons,
          templateName: attachments?.templateName 
      })
    });
    return await response.json();
  },

  scheduleMessage: async (driverIds: string[], content: { text: string, mediaUrl?: string, mediaType?: string, options?: string[], headerImageUrl?: string, footerText?: string, buttons?: MessageButton[], templateName?: string }, scheduledTime: number) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/messages/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              driverIds,
              scheduledTime,
              ...content
          })
      });
      return await response.json();
  },

  updateDriver: async (driverId: string, updates: Partial<Driver>) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/drivers/${driverId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
      });
      return await response.json();
  },

  uploadMedia: async (file: File, folderPath: string = '/') => {
      // STRATEGY: Smart Routing based on File Size
      // Files < 4.5MB: Use Proxy (Bypasses CORS entirely, no AWS config needed by user)
      // Files > 4.5MB: Use Direct Upload (Requires AWS CORS config)
      
      const PROXY_LIMIT = 4.5 * 1024 * 1024; // 4.5 MB (Vercel limit)

      if (file.size < PROXY_LIMIT) {
          try {
              const formData = new FormData();
              formData.append('file', file);
              formData.append('folderPath', folderPath);

              const response = await fetch(`${API_BASE_URL}/api/s3/proxy-upload`, {
                  method: 'POST',
                  body: formData
              });

              if (!response.ok) {
                  const err = await response.json();
                  throw new Error(err.error || "Proxy upload failed");
              }
              
              const result = await response.json();
              return { url: result.url, type: result.type };
          } catch (e: any) {
              console.warn("Proxy upload failed, falling back to direct...", e);
              // Fallthrough to Direct Upload if proxy server is down
          }
      }

      // Direct Upload Logic (For large files OR if proxy failed)
      try {
          const presignResponse = await fetchWithRetry(`${API_BASE_URL}/api/s3/presign`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: file.name, fileType: file.type, folderPath })
          });
          
          const { uploadUrl, key, publicUrl } = await presignResponse.json();

          const uploadResponse = await fetch(uploadUrl, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': file.type }
          });

          if (!uploadResponse.ok) throw new Error(`Direct upload failed: ${uploadResponse.statusText}`);

          // Register in DB
          const fileType = file.type.split('/')[0];
          await fetchWithRetry(`${API_BASE_URL}/api/files/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key, url: publicUrl, filename: file.name, type: fileType, folderPath })
          });

          return { url: publicUrl, type: fileType };

      } catch (error: any) {
          // If we are here, both Proxy (if attempted) and Direct failed.
          // This is likely a CORS issue for the Direct Upload.
          throw error;
      }
  },

  syncFromS3: async () => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/media/sync`, { method: 'POST' });
      return await response.json();
  },

  setPublicFolder: async (folderId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${folderId}/public`, { method: 'POST' });
      return await response.json();
  },

  unsetPublicFolder: async (folderId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${folderId}/public`, { method: 'DELETE' });
      return await response.json();
  },

  getPublicShowcase: async (token?: string) => {
      let url = `${API_BASE_URL}/api/public/showcase`;
      if (token) {
          // Changed to always use generic 'folder' param, letting backend handle Name OR ID resolution.
          // This supports both human-readable names and stable IDs.
          url += `?folder=${encodeURIComponent(token)}`;
      }
      const response = await fetchWithRetry(url);
      return await response.json();
  },

  getShowcaseStatus: async () => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/public/status`);
      return await response.json();
  },

  syncFileToWhatsApp: async (fileId: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/files/${fileId}/sync`, { method: 'POST' });
      return await response.json();
  },

  getMediaLibrary: async (path: string = '/') => {
      const encodedPath = encodeURIComponent(path);
      const response = await fetchWithRetry(`${API_BASE_URL}/api/media?path=${encodedPath}`);
      return await response.json();
  },

  createFolder: async (name: string, parentPath: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parentPath })
      });
      return await response.json();
  },

  renameFolder: async (id: string, newName: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
      });
      return await response.json();
  },

  deleteMediaFile: async (id: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/files/${id}`, { method: 'DELETE' });
      return await response.json();
  },

  deleteFolder: async (id: string) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/folders/${id}`, { method: 'DELETE' });
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
  
  getSystemSettings: async (): Promise<any> => {
      try {
          const response = await fetchWithRetry(`${API_BASE_URL}/api/system/settings`);
          return await response.json();
      } catch (e) {
          return { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
      }
  },

  updateSystemSettings: async (settings: any) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/system/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings })
      });
      return await response.json();
  },
  
  sendAssistantMessage: async (message: string, history: any[]) => {
      return { text: "AI Assistant is disabled in this mode." };
  }
};
