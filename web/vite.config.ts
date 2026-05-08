import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Accept Tailscale MagicDNS hostnames (anything ending in .ts.net) in
    // addition to the default localhost / IP allowlist. Without this, vite
    // rejects requests with "Blocked request. This host is not allowed."
    // when reaching the dev server via e.g. https://your-machine.tail-xxxx.ts.net.
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': 'http://localhost:7777',
      '/ws': { target: 'ws://localhost:7777', ws: true },
    },
  },
});
