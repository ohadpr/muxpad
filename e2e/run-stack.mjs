#!/usr/bin/env node
/**
 * Start e2e API server + vite preview for Playwright. Exits when either child dies.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const serverPort = process.env.MUXPAD_E2E_PORT ?? '7878';
const webPort = process.env.MUXPAD_E2E_WEB_PORT ?? '5188';
const runtimePath = join(here, '.runtime.json');

function waitForRuntime(ms = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(runtimePath)) {
        resolve(undefined);
        return;
      }
      if (Date.now() - start > ms) {
        reject(new Error('e2e bootstrap did not write .runtime.json'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitForPort(port, ms = 60_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const { connect } = await import('node:net');
        await new Promise((res, rej) => {
          const s = connect(port, '127.0.0.1', () => {
            s.destroy();
            res();
          });
          s.on('error', rej);
        });
        resolve(undefined);
      } catch {
        if (Date.now() - start > ms) reject(new Error(`port ${port} not ready`));
        else setTimeout(tick, 200);
      }
    };
    tick();
  });
}

const bootstrap = spawn('pnpm', ['exec', 'tsx', 'e2e/bootstrap.ts'], {
  cwd: root,
  env: { ...process.env, MUXPAD_E2E_PORT: serverPort },
  stdio: 'inherit',
});

await waitForRuntime();
const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
console.log(`[e2e stack] server port=${runtime.port} web port=${webPort}`);

const preview = spawn(
  'pnpm',
  [
    '--filter',
    '@muxpad/web',
    'exec',
    'vite',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    webPort,
    '--strictPort',
  ],
  {
    cwd: root,
    env: { ...process.env, MUXPAD_PORT: String(runtime.port), MUXPAD_E2E: '1' },
    stdio: 'inherit',
  },
);

await waitForPort(Number(webPort));
console.log(`[e2e stack] preview ready on 127.0.0.1:${webPort}`);

const shutdown = (code = 0) => {
  bootstrap.kill('SIGTERM');
  preview.kill('SIGTERM');
  process.exit(code);
};

bootstrap.on('exit', (code) => shutdown(code ?? 1));
preview.on('exit', (code) => shutdown(code ?? 1));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
