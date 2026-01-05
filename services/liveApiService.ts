import { Driver, BotSettings } from '../types';

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE_URL = isLocal ? 'http://localhost:3001' : ''; 

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

  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(callback, 2000); 
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
    // We strictly need to send flowData for the new engine
    const payload = {
        flowData: settings.flowData,
        // Legacy fields if needed
        isEnabled: settings.isEnabled,
        routingStrategy: settings.routingStrategy,
        systemInstruction: settings.systemInstruction
    };

    const response = await fetch(`${API_BASE_URL}/api/bot-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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