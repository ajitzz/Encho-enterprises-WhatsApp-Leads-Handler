import { Driver } from '../types';

// Determine if we are in local development or production
// When deployed on Vercel, the backend and frontend share the same domain, so we use relative paths.
// In local dev, if you run frontend on 5173/3000 and node on 3000, we might need localhost.
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// If local, assume Node is on 3000. If deployed, use relative path.
// NOTE: If you run both on 3000 locally via a proxy, empty string works too.
const API_BASE_URL = isLocal ? 'http://localhost:3000' : ''; 

export const liveApiService = {
  // Fetch all drivers from the backend
  getDrivers: async (): Promise<Driver[]> => {
    try {
      // Clean path construction
      const url = `${API_BASE_URL}/api/drivers`;
      const response = await fetch(url);
      
      if (!response.ok) throw new Error('Network response was not ok');
      return await response.json();
    } catch (error) {
      console.error("Failed to fetch drivers:", error);
      return [];
    }
  },

  // In a real app, you would use WebSockets (Socket.io) to listen for updates
  // instead of polling.
  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(callback, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  },

  // Calls the backend to update Meta Webhook configuration
  configureWebhook: async (config: { appId: string, appSecret: string, webhookUrl: string, verifyToken: string }) => {
    const url = `${API_BASE_URL}/api/configure-webhook`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to configure webhook');
    }
    return data;
  }
};