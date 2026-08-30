import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

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
const apiProxy = {
  '/api': `http://127.0.0.1:${serverPort}`,
  '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
};

/**
 * Emit `<file>.br` and `<file>.gz` next to every compressible build artifact.
 *
 * The server serves these via @hono/node-server's `serveStatic({ precompressed:
 * true })`, which picks br > gzip off the request's Accept-Encoding. Doing it
 * here rather than with a compression middleware buys two things: brotli at
 * quality 11 (a middleware has to stay near q4-5 to keep per-request latency
 * sane) and ZERO CPU per request — the phone on cellular is the bottleneck we
 * care about, and the bundle is compressed exactly once per build.
 *
 * Only text-ish output is worth it. woff2 is already brotli-compressed
 * internally and png/ico are already entropy-coded — re-compressing them
 * wastes build time and can even grow the file, so they are skipped. (The
 * serveStatic side agrees: it only looks for a precompressed sibling when the
 * MIME type is on its compressible list, which excludes font/woff2.)
 */
const COMPRESSIBLE = /\.(js|mjs|css|html|json|webmanifest|svg|map|txt)$/;

function precompressAssets(): Plugin {
  return {
    name: 'muxpad:precompress',
    // `closeBundle` runs after every asset (including public/ copies) is on
    // disk, which `writeBundle` does not guarantee.
    closeBundle() {
      const outDir = join(import.meta.dirname, 'dist');
      let files = 0;
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!COMPRESSIBLE.test(entry.name)) continue;
          // Below ~1KB the framing overhead eats the win and the extra round
          // of file opens on the server isn't worth it.
          if (statSync(full).size < 1024) continue;
          const raw = readFileSync(full);
          writeFileSync(
            `${full}.br`,
            brotliCompressSync(raw, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
              },
            }),
          );
          // gzip fallback: Chrome historically advertises `br` only over
          // secure origins, and muxpad is reachable over plain http on the
          // LAN/loopback path. Cheap insurance.
          writeFileSync(`${full}.gz`, gzipSync(raw, { level: 9 }));
          files++;
        }
      };
      walk(outDir);
      console.log(`precompressed ${files} file(s) → .br + .gz`);
    },
  };
}

export default defineConfig({
  define: {
    __MUXPAD_VERSION__: JSON.stringify(muxpadVersion),
  },
  plugins: [react(), precompressAssets()],
  server: {
    port: webPort,
    // Tailscale MagicDNS hostnames (*.ts.net) otherwise hit vite's
    // "Blocked request. This host is not allowed." guard when accessing the
    // dev server over the tailnet.
    allowedHosts: ['.ts.net'],
    proxy: apiProxy,
  },
  preview: {
    port: webPort,
    proxy: apiProxy,
  },
});
