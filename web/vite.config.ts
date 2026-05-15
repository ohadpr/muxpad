import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Date-based version derived from HEAD's commit date (YYYY.MM.DD).
// Surfaced in the chrome wordmark so users (and bug reporters) can tell
// which build they're running. Falls back to 'dev' if git isn't
// available (e.g., installed-from-tarball).
const muxpadVersion: string = (() => {
  try {
    // %cs = committer date in short ISO form, e.g. "2026-05-13".
    const iso = execSync('git log -1 --format=%cs HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return iso.replace(/-/g, '.');
  } catch {
    return 'dev';
  }
})();

// Ports are env-configurable so a second instance (e.g. a worktree under
// test) can run alongside the primary dev server without conflicts:
//   MUXPAD_WEB_PORT=5273 MUXPAD_PORT=7877 MUXPAD_DATA_DIR=~/.muxpad-test \
//     pnpm --parallel dev
// Defaults match the original hardcoded values.
const webPort = Number(process.env.MUXPAD_WEB_PORT ?? 5173);
const serverPort = Number(process.env.MUXPAD_PORT ?? 7777);

export default defineConfig({
  define: {
    __MUXPAD_VERSION__: JSON.stringify(muxpadVersion),
  },
  plugins: [react()],
  server: {
    port: webPort,
    // Accept Tailscale MagicDNS hostnames (anything ending in .ts.net) in
    // addition to the default localhost / IP allowlist. Without this, vite
    // rejects requests with "Blocked request. This host is not allowed."
    // when reaching the dev server via e.g. https://your-machine.tail-xxxx.ts.net.
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': `http://localhost:${serverPort}`,
      '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
});
