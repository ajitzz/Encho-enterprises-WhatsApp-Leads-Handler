import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // Polyfill process.env for the frontend code that uses it
    'process.env': {}
  },
  build: {
    // Output to 'build' folder to match what Vercel/CRA often expects
    outDir: 'build' 
  }
});