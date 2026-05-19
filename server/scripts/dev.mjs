#!/usr/bin/env node
// Dev orchestrator: runs ptyd and the main server as separate processes.
//
// - ptyd runs WITHOUT tsx watch, so edits to main-server files don't restart it.
// - main server runs under tsx watch as before.
// - Both share MUXPAD_PTYD_SOCKET so they agree on the socket path.
// - On SIGINT/SIGTERM, both children are terminated.
// - If ptyd exits for any reason, we tear down the main server too and exit.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');

const socketPath =
  process.env.MUXPAD_PTYD_SOCKET ??
  path.join(os.homedir(), '.muxpad', 'ptyd.sock');

mkdirSync(path.dirname(socketPath), { recursive: true });

const sharedEnv = {
  ...process.env,
  MUXPAD_PTYD_SOCKET: socketPath,
};

/**
 * Wire a child's stdout/stderr to the parent with a per-line prefix.
 * Buffers partial lines so we never emit `[prefix] half-line` mid-chunk.
 */
function pipePrefixed(child, prefix) {
  const attach = (src, dst) => {
    let buf = '';
    const flush = () => {
      if (buf.length > 0) {
        dst.write(`${prefix}${buf}\n`);
        buf = '';
      }
    };
    src.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        dst.write(`${prefix}${line}\n`);
      }
    });
    // A child that exits mid-line (no trailing newline) would otherwise
    // never see its last fragment surface. Flush on both 'end' (stream
    // closed cleanly) and 'close' (fd closed; fires even on abrupt exit).
    src.on('end', flush);
    src.on('close', flush);
  };
  attach(child.stdout, process.stdout);
  attach(child.stderr, process.stderr);
}

const tsxBin = path.join(serverDir, 'node_modules', '.bin', 'tsx');

const spawnOpts = {
  cwd: serverDir,
  stdio: ['ignore', 'pipe', 'pipe'],
};

// Spawn ptyd (no watch)
const ptyd = spawn(
  tsxBin,
  ['src/ptyd/index.ts'],
  { ...spawnOpts, env: sharedEnv },
);
pipePrefixed(ptyd, '[ptyd] ');

// Spawn main server (with tsx watch)
const muxpad = spawn(
  tsxBin,
  ['watch', '--include=../shared/dist', 'src/index.ts'],
  {
    ...spawnOpts,
    env: { ...sharedEnv, MUXPAD_HOST: process.env.MUXPAD_HOST ?? '0.0.0.0' },
  },
);
pipePrefixed(muxpad, '[muxpad] ');

let shuttingDown = false;

function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [ptyd, muxpad]) {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  }
  setTimeout(() => {
    for (const child of [ptyd, muxpad]) {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    process.exit(exitCode);
  }, 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGTERM', 130));
process.on('SIGTERM', () => shutdown('SIGTERM', 143));

ptyd.on('exit', (code, signal) => {
  if (shuttingDown) return;
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  process.stderr.write(
    `\n[dev] ptyd exited unexpectedly (${reason}); shutting down main server.\n`,
  );
  shutdown('SIGTERM', code ?? 1);
});

muxpad.on('exit', (code, signal) => {
  if (shuttingDown) return;
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  process.stderr.write(
    `\n[dev] main server exited (${reason}); shutting down ptyd.\n`,
  );
  shutdown('SIGTERM', code ?? 1);
});
