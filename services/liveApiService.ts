import { Driver, BotSettings } from '../types';

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE_URL = isLocal ? 'http://localhost:3001' : ''; 

// ENTERPRISE RESILIENCE: Retry wrapper for Fetch
const fetchWithRetry = async (url: string, options?: RequestInit, retries = 3, delay = 500): Promise<Response> => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
             // If server error (500-599), retry
             if (response.status >= 500) {
                 const clone = response.clone();
                 try {
                    const errorBody = await clone.json();
                    console.error("SERVER ERROR DETAILS:", errorBody);
                 } catch(e) {
                    console.error("SERVER ERROR (Text):", await clone.text());
                 }
                 
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
  // Fetch drivers with retry logic
  getDrivers: async (): Promise<Driver[]> => {
    try {
      const url = `${API_BASE_URL}/api/drivers`;
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

  // --- CONFIG ---

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

  // --- SYSTEM DOCTOR (ADMIN) ---
  
  getProjectContext: async (): Promise<{files: Array<{path: string, content: string}>}> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/project-context`);
      if (!response.ok) throw new Error('Failed to read project context');
      return await response.json();
  },

  // Fallback for single file if needed
  getSourceCode: async (): Promise<{code: string}> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/source-code`);
      if (!response.ok) throw new Error('Failed to read source code');
      return await response.json();
  },

  // Multi-file patcher
  applySystemPatch: async (changes: Array<{filePath: string, content: string}>): Promise<{success: boolean, message: string}> => {
      const response = await fetchWithRetry(`${API_BASE_URL}/api/admin/write-files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changes })
      });
      if (!response.ok) throw new Error('Failed to patch system');
      return await response.json();
  }
};
