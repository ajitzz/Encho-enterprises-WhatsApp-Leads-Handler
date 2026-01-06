import { Driver, BotSettings } from '../types';

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE_URL = isLocal ? 'http://localhost:3001' : ''; 

// Helper: Custom fetch with configurable timeout and retry logic
const fetchWithRetry = async (url: string, options?: RequestInit, retries = 3, delay = 500, timeout = 10000): Promise<Response> => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        
        if (!response.ok) {
             if (response.status >= 500 && retries > 0) throw new Error('Server Error');
             return response;
        }
        return response;
    } catch (err: any) {
        clearTimeout(id);
        if (err.name === 'AbortError') {
             throw new Error(`Request timed out after ${timeout}ms`);
        }
        if (retries > 0) {
            await new Promise(res => setTimeout(res, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 2, timeout);
        }
        throw err;
    }
};

export const liveApiService = {
  getDrivers: async (): Promise<Driver[]> => {
    const url = `${API_BASE_URL}/api/drivers`;
    const response = await fetchWithRetry(url);
    if (!response.ok) throw new Error('API Error');
    return await response.json();
  },

  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(async () => {
        try { await callback(); } catch(e) {}
    }, 2000); 
    return () => clearInterval(interval);
  },

  getBotSettings: async (): Promise<BotSettings> => {
    try {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/bot-settings`);
      if (!response.ok) throw new Error('Failed to fetch bot settings');
      return await response.json();
    } catch (error) {
      return { isEnabled: true, routingStrategy: 'HYBRID_BOT_FIRST', systemInstruction: '', steps: [] };
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

  getProjectContext: async (): Promise<{files: Array<{path: string, content: string}>}> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/project-context`, undefined, 3, 500, 30000); 
      if (!response.ok) throw new Error('Failed to read project context');
      return await response.json();
  },

  // --- SYSTEM DOCTOR NEW API ---
  analyzeSystem: async (issueDescription: string): Promise<{ diagnosis: string, changes: any[] }> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/analyze-system`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issueDescription })
      }, 0, 0, 90000); 
      
      if (!response.ok) throw new Error('Analysis Failed');
      return await response.json();
  },

  // --- NEW SERVER-SIDE AUDIT ---
  auditBotFlow: async (nodes: any[]): Promise<any> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/audit-flow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes })
      }, 0, 0, 30000);
      if (!response.ok) throw new Error('Audit Failed');
      return await response.json();
  },

  undoLastPatch: async (): Promise<{ success: boolean, message: string }> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/undo-patch`, { method: 'POST' });
      if (response.status === 400 || response.status === 404) {
          const err = await response.json();
          throw new Error(err.error || "Undo failed");
      }
      if (!response.ok) throw new Error('Undo Failed');
      return await response.json();
  },

  applySystemPatch: async (changes: Array<{filePath: string, content: string}>): Promise<{success: boolean, message: string}> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/write-files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changes })
      }, 0, 0, 60000);
      if (!response.ok) throw new Error('Failed to patch system');
      return await response.json();
  },

  sendAssistantMessage: async (message: string, history: any[]) => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/assistant/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, history })
      }, 0, 500, 90000); 
      
      if (!response.ok) throw new Error('Failed to chat with assistant');
      return await response.json();
  }
};