import { Driver } from '../types';

// Determine if we are in local development or production
// When deployed on Vercel, the backend and frontend share the same domain, so we use relative paths.
// In local dev, if you run frontend on 3000 and node on 3001, we need localhost:3001.
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// CHANGED: Point to port 3001 for local development
const API_BASE_URL = isLocal ? 'http://localhost:3001' : ''; 

export const liveApiService = {
  // Fetch all drivers from the backend
  getDrivers: async (): Promise<Driver[]> => {
    try {
      // Clean path construction
      const url = `${API_BASE_URL}/api/drivers`;
      const response = await fetch(url);
      
      if (!response.ok) {
        // CHANGED: Better error handling to display the actual server error
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`);
      }
      return await response.json();
    } catch (error: any) {
      console.error("Failed to fetch drivers:", error);
      // We re-throw or handle the error in UI. 
      // For now, returning empty to prevent crash, but logging heavily.
      console.warn("Ensure Backend is running: 'node server.js' (Port 3001)");
      throw error;
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