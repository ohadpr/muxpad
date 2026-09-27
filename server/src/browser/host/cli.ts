import { startBrowserHost } from './run.js';

/**
 * Entry point for a browser owner pane.
 *
 * This is what `browserHostCommand` builds a command line for, and what ptyd
 * actually runs. It stays a thin argv parser on purpose: everything worth
 * testing lives in run.ts and the modules under it, and a process launched by a
 * supervisor is the worst possible place to discover a logic bug.
 *
 * It does not daemonise, fork, or trap its own crashes. `muxpad serve` already
 * supplies crash-loop backoff inside the pane, and a second opinion about
 * restarts fighting the first is exactly the kind of thing that makes a browser
 * that will not die.
 */

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const value = hit.slice(name.length + 3);
  // The command line is built with JSON.stringify for paths, so unwrap it.
  return value.startsWith('"') && value.endsWith('"') ? JSON.parse(value) : value;
}

function required(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`browser host: --${name}= is required`);
    process.exit(2);
  }
  return value;
}

const host = await startBrowserHost({
  profile: required('profile'),
  port: Number(required('port')),
  dataDir: required('data-dir'),
  chromePath: required('chrome'),
});

console.log(`browser host ready · viewer ${host.url} · cdp ${host.cdpUrl}`);

// Shut the browser down on the way out rather than leaving an orphan holding
// the profile lock — the next start would then fail with a lock error that
// looks nothing like its cause.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void host.close().finally(() => process.exit(0));
  });
}
