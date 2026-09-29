import { findCloudflared } from './cloudflared.js';
import { createTunnelRunner } from './run.js';

/**
 * Entry point for `muxpad tunnel` (scripts/muxpad execs this the same way it
 * execs the agent runner). Argument parsing, environment, signals — the policy
 * is all in run.ts and TunnelApp.ts.
 */

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const portRaw = arg('port', argv) ?? process.env.MUXPAD_PUBLIC_PORT ?? '7778';
  const publicPort = Number(portRaw);
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    console.error(`muxpad tunnel: --port must be a port number (got ${portRaw})`);
    process.exit(2);
  }
  const apiUrl = arg('api', argv) ?? process.env.MUXPAD_API_URL ?? 'http://127.0.0.1:7777';

  // The main port is refused by NAME here purely so the error is readable; the
  // real guarantee is run.ts's fingerprint of the target, which does not depend
  // on anyone having configured the right port number.
  const apiPort = Number(new URL(apiUrl).port || '7777');
  if (publicPort === apiPort) {
    console.error(
      `muxpad tunnel: refusing to expose :${publicPort} — that is the MAIN muxpad server, which has no authentication. The tunnel may only expose the public artifact port.`,
    );
    process.exit(2);
  }

  const runner = createTunnelRunner({
    publicPort,
    apiUrl,
    // Both tokens, always. In a pane, MUXPAD_PANE_ID is set and the pane is the
    // stronger owner (the pid then only sharpens it — see TunnelApp.ts). Under
    // launchd there is no pane, and the pid is the ONLY thing whose liveness the
    // server can check, so a paneless runner is not a special mode here: it is
    // the same call with one of the two tokens absent.
    paneId: process.env.MUXPAD_PANE_ID ?? null,
    pid: process.pid,
    bin: findCloudflared(),
    log: (m) => console.log(m),
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      console.log(`muxpad tunnel: ${sig} — taking the tunnel down`);
      runner.stop();
    });
  }
  const outcome = await runner.run();
  // A refusal or a missing binary is a real failure and must not look like a
  // clean stop: `muxpad serve` backs off and retries, the serve supervisor
  // eventually gives up, and giving up is what pushes a notification.
  //
  // `not-wanted` is the deliberate exception and the reason this is not just
  // `=== 'stopped'`: a permanent public base makes the tunnel pointless, and
  // under launchd's `KeepAlive: {SuccessfulExit: false}` exiting 0 is the only
  // way to say "and do not bring me back". Exiting 1 there would crash-loop a
  // tunnel against a domain that already works.
  process.exit(outcome === 'stopped' || outcome === 'max-runs' || outcome === 'not-wanted' ? 0 : 1);
}

void main();
