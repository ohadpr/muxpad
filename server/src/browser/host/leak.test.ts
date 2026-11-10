import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBrowserHost } from './run.js';

/**
 * A BROWSER MUST NOT OUTLIVE THE HOST THAT STARTED IT.
 *
 * This is written from a real incident rather than from a worry. Measured on
 * the owner's machine: 1,001 orphaned `chrome-headless-shell` processes — 3,014
 * with their gpu and utility helpers, out of 4,040 on the box. The machine was
 * unusable and had been getting worse for ten hours.
 *
 * The mechanism was two lines cooperating. `startBrowserHost` spawns Chrome and
 * then awaits a CDP port; the await can throw, nothing caught it, so the
 * process died with Chrome still running. `muxpad serve` restarted the host,
 * which leaked another. And because every instance of a profile asks for the
 * SAME debugging port, the first orphan held it forever — so each restart was
 * guaranteed to time out and donate one more. One leak was permanent failure.
 *
 * A fake "Chrome" stands in: a sleep. What matters is whether the process that
 * was spawned is still alive afterwards, and that question does not need a real
 * browser to ask.
 */
const dirs: string[] = [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A script that stands in for Chrome: runs, never opens a debugging port. */
function fakeChrome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muxpad-fakechrome-'));
  dirs.push(dir);
  const path = join(dir, 'chrome');
  // Prints its own pid so the test can watch it, then sits there.
  writeFileSync(path, '#!/bin/sh\necho "FAKE_CHROME_PID=$$" >&2\nexec sleep 120\n');
  chmodSync(path, 0o755);
  return path;
}
/** A free port inside the range the host insists on (9400–9499). Bound and
 *  released, so the number is known to be takeable a moment ago. */
async function freeReservedPort(): Promise<number> {
  for (let port = 9499; port >= 9400; port--) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port in the reserved range');
}

const opts = (chromePath: string, port: number, log: (l: string) => void) => ({
  profile: 'leak-test',
  port,
  dataDir: mkdtempSync(join(tmpdir(), 'muxpad-leak-')),
  chromePath,
  log,
});

afterEach(() => {
  // Belt: nothing this file starts may survive it either.
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
});
const started: number[] = [];

describe('a failed start does not leave a browser behind', () => {
  it('kills the Chrome it spawned when CDP never comes up', async () => {
    const lines: string[] = [];
    const chromePath = fakeChrome();
    // A port in the reserved range that nothing holds: the fake browser never
    // opens it, so CDP cannot come up and the start must fail.
    const port = await freeReservedPort();
    await expect(startBrowserHost(opts(chromePath, port, (l) => lines.push(l)))).rejects.toThrow();

    const stamp = lines.find((l) => l.includes('FAKE_CHROME_PID='));
    expect(stamp, 'the fake browser never started — the test proves nothing').toBeTruthy();
    const pid = Number(/FAKE_CHROME_PID=(\d+)/.exec(stamp as string)?.[1]);
    started.push(pid);
    expect(Number.isFinite(pid)).toBe(true);

    // THE ASSERTION. Before the fix this process outlived the failure, one per
    // restart, for ever.
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid), `pid ${pid} outlived the host that started it`).toBe(false);
  }, 40_000);

  it('does not spawn at all when something already owns the port', async () => {
    // Stand in for an orphan that is still holding the debugging port.
    const squatter = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'HeadlessChrome/1.0' }));
    });
    const port = await freeReservedPort();
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', r));

    const lines: string[] = [];
    const chromePath = fakeChrome();
    await expect(startBrowserHost(opts(chromePath, port, (l) => lines.push(l)))).rejects.toThrow(
      /already answering/,
    );
    // Nothing was spawned, so there is nothing to leak — the cheapest possible
    // failure, and the one that breaks the self-feeding loop.
    expect(lines.some((l) => l.includes('FAKE_CHROME_PID='))).toBe(false);
    await new Promise<void>((r) => squatter.close(() => r()));
  }, 20_000);

  it('leaves no stray children of this test run', () => {
    // A guard on the guard: if the implementation ever spawns via a shell
    // wrapper that detaches, the assertions above could pass while a process
    // survives under a different parent.
    const out = spawnSync('pgrep', ['-f', 'muxpad-fakechrome'], { encoding: 'utf8' });
    const pids = out.stdout.split('\n').filter(Boolean);
    expect(pids, `strays: ${pids.join(',')}`).toEqual([]);
  });
});
