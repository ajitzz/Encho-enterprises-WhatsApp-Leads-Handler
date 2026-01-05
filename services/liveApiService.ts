import { Driver, BotSettings } from '../types';

// Default to relative path (Vite proxy)
// If running locally and proxy fails, we try direct port 3001
const API_BASE_URL = ''; 
const FALLBACK_URL = 'http://localhost:3001';

// Helper to force no-cache fetches (avoid Vercel/browser caching)
const withNoStore = (options: RequestInit = {}): RequestInit => ({
    cache: 'no-store',
    ...options,
});

// Helper: Retry fetch with exponential backoff
const fetchWithRetry = async (url: string, options: RequestInit = {}, retries = 5, delay = 1000): Promise<Response> => {
    try {
        const response = await fetch(url, withNoStore(options));
        
        // Retry on Proxy Errors (502, 503, 504) or HTML 404s (meaning backend not reachable via proxy yet)
        if ((response.status === 502 || response.status === 503 || response.status === 504 || response.status === 404) && retries > 0) {
             const contentType = response.headers.get("content-type");
             const isJson = contentType && contentType.includes("application/json");
             
             // If we got HTML (Vite error page) or a server error, retry
             if (!isJson || response.status >= 500) {
                console.log(`Backend not ready at ${url}, retrying in ${delay}ms... (${retries} left)`);
                await new Promise(res => setTimeout(res, delay));
                return fetchWithRetry(url, options, retries - 1, delay * 1.5);
             }
        }
        return response;
    } catch (error) {
        if (retries > 0) {
            console.log(`Network error connecting to ${url}, retrying in ${delay}ms... (${retries} left)`);
            await new Promise(res => setTimeout(res, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 1.5);
        }
        throw error;
    }
};

export const liveApiService = {
  // New: Explicitly wait for server health check
  waitForServer: async (): Promise<void> => {
      // Poll for up to 20 seconds (20 attempts * 1s) to allow container startup
      for (let i = 0; i < 20; i++) {
          try {
              // Simple fetch to health check, no retries logic here, just pass/fail
              const res = await fetch(`${API_BASE_URL}/api/health`, withNoStore());
              if (res.ok) return;
          } catch (e) {
              // ignore connection errors
          }
          // If fallback needed check localhost (dev only)
          if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
               try {
                   const res = await fetch(`${FALLBACK_URL}/api/health`, withNoStore());
                   if (res.ok) return;
               } catch (e) {}
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error("Backend API not found. The server is taking too long to respond. Ensure 'node server.js' is running.");
  },

  // Fetch drivers
  getDrivers: async (): Promise<Driver[]> => {
    let url = `${API_BASE_URL}/api/drivers`;
    
    try {
      let response = await fetchWithRetry(url);
      
      const contentType = response.headers.get("content-type");
      const isJson = contentType && contentType.indexOf("application/json") !== -1;

      // Check Fallback ONLY if on localhost (dev environment)
      const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
      
      if ((!response.ok || !isJson) && isLocalhost) {
         console.warn(`Primary fetch failed at ${url} (${response.status}), trying direct backend...`);
         url = `${FALLBACK_URL}/api/drivers`;
         try {
             // Don't retry heavily on fallback, just one attempt
             const fallbackResponse = await fetch(url, withNoStore());
             if (fallbackResponse.ok) {
                 response = fallbackResponse;
             }
         } catch(e) {
             console.error("Fallback connection failed", e);
         }
      }

      if (!response.ok) {
          // Clone to read text safely
          const errText = await response.clone().text();
          let errDetail = errText.substring(0, 100);
          try {
             const errJson = await response.json();
             if(errJson.error) errDetail = errJson.error;
          } catch (e) {}
          
          if (response.status === 404 && (errDetail.includes("File not found") || errDetail.includes("Cannot GET") || errDetail.includes("<!DOCTYPE html>"))) {
             throw new Error("Backend API not found. The server might be starting up, or 'node server.js' is not running.");
          }

          throw new Error(`API Error ${response.status}: ${errDetail}`);
      }
      return await response.json();
    } catch (error: any) {
      console.error(`Fetch failed at ${url}`, error);
      throw error;
    }
  },

  updateDriver: async (id: string, updates: Partial<Driver>) => {
      // Try relative first
      try {
          const res = await fetch(`${API_BASE_URL}/api/drivers/${id}`, withNoStore({
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
          }));
          if (!res.ok) throw new Error('Proxy failed');
      } catch (e) {
          // Fallback only if local
           if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
                await fetch(`${FALLBACK_URL}/api/drivers/${id}`, withNoStore({
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updates)
                }));
           }
      }
  },

  // Optimized Polling (2 Seconds)
  subscribeToUpdates: (callback: () => void) => {
    const interval = setInterval(callback, 2000); 
    return () => clearInterval(interval);
  },

  // --- SYSTEM STATUS ---
  checkHealth: async () => {
      try {
          const res = await fetchWithRetry(`${API_BASE_URL}/api/health`, {}, 3, 500);
          if (res.ok) return await res.json();
          throw new Error('Proxy health check failed');
      } catch (e) {
          const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
          if (isLocalhost) {
            try {
                const fallbackRes = await fetch(`${FALLBACK_URL}/api/health`, withNoStore());
                if (fallbackRes.ok) return await fallbackRes.json();
            } catch (err) {
                return { database: 'disconnected', whatsapp: 'unknown', ai: 'unknown' };
            }
          }
          return { database: 'disconnected', whatsapp: 'unknown', ai: 'unknown' };
      }
  },

  // --- BOT SETTINGS API ---
  
  getBotSettings: async (): Promise<BotSettings> => {
    try {
      let response = await fetchWithRetry(`${API_BASE_URL}/api/bot-settings`);
      
      const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
      if (!response.ok && isLocalhost) {
          response = await fetch(`${FALLBACK_URL}/api/bot-settings`, withNoStore());
      }
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
    try {
        const response = await fetch(`${API_BASE_URL}/api/bot-settings`, withNoStore({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        }));
        if (!response.ok) throw new Error('Failed to save settings');
        return await response.json();
    } catch (e) {
        const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
        if (isLocalhost) {
            const response = await fetch(`${FALLBACK_URL}/api/bot-settings`, withNoStore({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            }));
            if (!response.ok) throw new Error('Failed to save settings');
            return await response.json();
        }
        throw e;
    }
  },

  // --- CONFIG ---

  configureWebhook: async (config: any) => {
    try {
        const response = await fetch(`${API_BASE_URL}/api/configure-webhook`, withNoStore({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        }));
        return await response.json();
    } catch (e) {
        const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
        if (isLocalhost) {
            const response = await fetch(`${FALLBACK_URL}/api/configure-webhook`, withNoStore({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            }));
            return await response.json();
        }
        throw e;
    }
  },

  updateCredentials: async (credentials: any) => {
    try {
        const response = await fetch(`${API_BASE_URL}/api/update-credentials`, withNoStore({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials)
        }));
        return await response.json();
    } catch (e) {
        const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
        if (isLocalhost) {
            const response = await fetch(`${FALLBACK_URL}/api/update-credentials`, withNoStore({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(credentials)
            }));
            return await response.json();
        }
        throw e;
    }
  },

  // --- DEBUG TOOLS ---
  getLogs: async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/api/logs`, withNoStore());
          if (res.ok) return await res.json();
          // fallback
          const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
          if (isLocalhost) {
              const fb = await fetch(`${FALLBACK_URL}/api/logs`, withNoStore());
              if (fb.ok) return await fb.json();
          }
          return [];
      } catch (e) {
          return [];
      }
  },

  simulateWebhook: async (data: any) => {
       try {
          const res = await fetch(`${API_BASE_URL}/api/simulate-webhook`, withNoStore({
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify(data)
         }));
          if(res.ok) return true;
          throw new Error('Simulation failed');
       } catch (e) {
           // fallback
          const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
          if (isLocalhost) {
             const fb = await fetch(`${FALLBACK_URL}/api/simulate-webhook`, withNoStore({
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(data)
             }));
             if(fb.ok) return true;
          }
          throw e;
       }
  }
};