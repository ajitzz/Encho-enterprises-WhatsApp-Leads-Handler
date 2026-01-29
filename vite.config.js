
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    define: {
      // SECURITY UPDATE: Only expose non-sensitive public configs to the frontend.
      // API Keys (Gemini, AWS, Meta) are now strictly backend-only.
      'process.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(env.VITE_GOOGLE_CLIENT_ID),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
    },
    server: {
      headers: {
        // CRITICAL FIX: Allow Google OAuth popups to communicate back to the app
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Cross-Origin-Embedder-Policy": "require-corp"
      }
    },
    build: {
      outDir: 'dist' 
    }
  };
});
