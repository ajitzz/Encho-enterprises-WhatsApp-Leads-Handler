import { Driver, BotSettings } from '../types';

// Default to relative path (Vite proxy)
// If running locally and proxy fails, we try direct port 3001
const API_BASE_URL = ''; 
const FALLBACK_URL = 'http://localhost:3001';

export const liveApiService = {
  // Fetch drivers
  getDrivers: async (): Promise<Driver[]> => {
    let url = `${API_BASE_URL}/api/drivers`;
    
    try {
      let response = await fetch(url);
      
      // If 404/500 and we are local, try direct port fallback
      if (!response.ok && window.location.hostname === 'localhost') {
         console.warn(`Proxy failed at ${url} (${response.status}), trying direct backend...`);
         // Try /api/drivers at port 3001
         url = `${FALLBACK_URL}/api/drivers`;
         response = await fetch(url);
      }

      if (!response.ok) {
          // Clone to read text safely
          const errText = await response.clone().text();
          try {
             const errJson = await response.json();
             throw new Error(`API Error: ${errJson.error || response.statusText}`);
          } catch (e) {
             // If not JSON, it's likely a static 404 page or "File not found" text
             throw new Error(`API Error ${response.status}: ${errText.substring(0, 50)}...`);
          }
      }
      return await response.json();
    } catch (error: any) {
      console.error(`Fetch failed at ${url}`, error);
      throw error;
    }
  },

  updateDriver: async (id: string, updates: Partial<Driver>) => {
      await fetch(`${API_BASE_URL}/api/drivers/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
      });
  },

  // Optimized Polling (2 Seconds)
  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(callback, 2000); 
    return () => clearInterval(interval);
  },

  // --- SYSTEM STATUS ---
  checkHealth: async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/api/health`);
          if (res.ok) return await res.json();
          // Fallback check
          const fallbackRes = await fetch(`${FALLBACK_URL}/api/health`);
          if (fallbackRes.ok) return await fallbackRes.json();
          return { database: 'disconnected', whatsapp: 'unknown', ai: 'unknown' };
      } catch (e) {
          return { database: 'disconnected', whatsapp: 'unknown', ai: 'unknown' };
      }
  },

  // --- BOT SETTINGS API ---
  
  getBotSettings: async (): Promise<BotSettings> => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/bot-settings`);
      if (!response.ok) throw new Error('Failed to fetch bot settings');
      return await response.json();
    } catch (error) {
      console.warn("Could not fetch live bot settings, using default");
      // Fallback object to prevent UI crash
      return { 
          isEnabled: true, 
          routingStrategy: 'HYBRID_BOT_FIRST', 
          systemInstruction: '', 
          steps: [] 
      };
    }
  },

  saveBotSettings: async (settings: BotSettings) => {
    const response = await fetch(`${API_BASE_URL}/api/bot-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!response.ok) throw new Error('Failed to save settings');
    return await response.json();
  },

  // --- CONFIG ---

  configureWebhook: async (config: any) => {
    const response = await fetch(`${API_BASE_URL}/api/configure-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    return await response.json();
  },

  updateCredentials: async (credentials: any) => {
    const response = await fetch(`${API_BASE_URL}/api/update-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    });
    return await response.json();
  }
};