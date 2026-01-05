import { Driver, BotSettings } from '../types';

// In Vercel (and with Vite Proxy locally), we can use relative paths.
const API_BASE_URL = ''; 

export const liveApiService = {
  // Fetch drivers
  getDrivers: async (): Promise<Driver[]> => {
    try {
      const url = `${API_BASE_URL}/api/drivers`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('API Error');
      return await response.json();
    } catch (error: any) {
      console.error("Fetch Error:", error);
      throw error;
    }
  },

  // Check System Health
  checkHealth: async (): Promise<{ database: string, whatsapp: string, ai: string }> => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/health`);
      if (!response.ok) return { database: 'disconnected', whatsapp: 'unknown', ai: 'unknown' };
      return await response.json();
    } catch (error) {
      return { database: 'disconnected', whatsapp: 'unknown', ai: 'unknown' };
    }
  },

  // Update Driver Details
  updateDriver: async (id: string, updates: Partial<Driver>) => {
    const response = await fetch(`${API_BASE_URL}/api/drivers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!response.ok) throw new Error('Failed to update driver');
    return await response.json();
  },

  // Optimized Polling (15 Seconds)
  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(callback, 15000); 
    return () => clearInterval(interval);
  },

  // --- BOT SETTINGS API ---
  
  getBotSettings: async (): Promise<BotSettings> => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/bot-settings`);
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