import { Driver, BotSettings } from '../types';

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE_URL = isLocal ? 'http://localhost:3001' : ''; 

// ENTERPRISE RESILIENCE: Retry wrapper for Fetch
// This ensures that if the Vercel function is waking up (Cold Start),
// the frontend doesn't crash but retries quietly.
const fetchWithRetry = async (url: string, options?: RequestInit, retries = 3, delay = 500): Promise<Response> => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
             // If server error (500-599), retry
             if (response.status >= 500) {
                 // Clone response to read error body without consuming main response stream
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
  }
};