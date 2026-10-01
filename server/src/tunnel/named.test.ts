import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NAMED_TUNNEL_FILE,
  type NamedTunnel,
  namedTunnelArgs,
  namedTunnelBaseUrl,
  quickTunnelArgs,
  readNamedTunnel,
} from './named.js';

/**
 * A NAMED tunnel is the only answer that is public AND permanent, and the
 * difference from the quick tunnel is entirely about where the hostname comes
 * from: Cloudflare assigns a quick tunnel's name at connect time, while a named
 * tunnel's is a CNAME you own, pointed at a UUID whose credentials sit on disk.
 * So muxpad does not have to discover it — it has to be TOLD it, once, and then
 * remember. That memory is this file.
 */

let dir: string;
const CREDS = 'creds.json';

const config = (over: Record<string, unknown> = {}) => ({
  name: 'muxpad',
  hostname: 'artifacts.example.dev',
  credentials_file: join(dir, CREDS),
  ...over,
});

const write = (value: unknown) =>
  writeFileSync(join(dir, NAMED_TUNNEL_FILE), JSON.stringify(value));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-named-'));
  // `tunnel create` writes this; its presence is what "credentials exist" means.
  writeFileSync(join(dir, CREDS), '{"AccountTag":"x","TunnelSecret":"y","TunnelID":"z"}');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readNamedTunnel', () => {
  it('reads a config written by `muxpad tunnel setup`', () => {
    write(config());
    expect(readNamedTunnel(dir)).toEqual({
      name: 'muxpad',
      hostname: 'artifacts.example.dev',
      credentialsFile: join(dir, CREDS),
    });
  });

  it('is null when nothing has been set up — the ordinary case', () => {
    expect(readNamedTunnel(dir)).toBeNull();
  });

  it('is null when the CREDENTIALS are gone, however good the config looks', () => {
    // The decisive check. A config file is a note-to-self; the credentials are
    // what makes the tunnel runnable. Trusting the note would mean announcing a
    // permanent hostname and then crash-looping a cloudflared that cannot
    // authenticate — every published link pointing at a name nothing serves.
    write(config());
    rmSync(join(dir, CREDS));
    expect(readNamedTunnel(dir)).toBeNull();
  });

  it('refuses a hostname that is not a bare hostname', () => {
    // This value becomes the origin of every published link, so it is validated
    // here rather than at the point of use. A scheme or a path would produce
    // `https://https://x/y` downstream.
    for (const bad of [
      'https://artifacts.example.dev',
      'artifacts.example.dev/path',
      'artifacts.example.dev:8443',
      'artifacts example dev',
      '-leading-dash.example.dev',
      '',
      '.',
      'x'.repeat(300),
    ]) {
      write(config({ hostname: bad }));
      expect(readNamedTunnel(dir), `accepted ${bad}`).toBeNull();
    }
  });

  it('refuses a tunnel name that could not be passed to cloudflared safely', () => {
    for (const bad of ['', 'two words', 'semi;colon', '--flag', 'x'.repeat(200)]) {
      write(config({ name: bad }));
      expect(readNamedTunnel(dir), `accepted ${bad}`).toBeNull();
    }
  });

  it('treats a half-written or hand-edited file as absent, never as an error', () => {
    // Read on the publish path. A malformed file must degrade to "no named
    // tunnel" — the quick tunnel and the tailnet base still work — not take
    // publishing down.
    writeFileSync(join(dir, NAMED_TUNNEL_FILE), '{"name": "muxpad", ');
    expect(() => readNamedTunnel(dir)).not.toThrow();
    expect(readNamedTunnel(dir)).toBeNull();
    write({ hostname: 'artifacts.example.dev' }); // no name, no credentials
    expect(readNamedTunnel(dir)).toBeNull();
  });
});

describe('namedTunnelBaseUrl', () => {
  it('is https on the default port, which is the whole point of a real domain', () => {
    const t: NamedTunnel = {
      name: 'muxpad',
      hostname: 'artifacts.example.dev',
      credentialsFile: '/x',
    };
    // Not :8443. The tailnet fallback carries that port and it is blocked
    // outbound on many networks; a named tunnel is on 443 like everything else.
    expect(namedTunnelBaseUrl(t)).toBe('https://artifacts.example.dev');
  });
});

describe('the cloudflared command line', () => {
  const local = 'http://127.0.0.1:7778';

  it('puts --no-autoupdate before `run` and the tunnel name last', () => {
    // Read off the installed binary's own help (2026.8.2), not from memory:
    // `--no-autoupdate` is a TUNNEL command option, `--url` is a `run`
    // subcommand option, and the tunnel is the final positional.
    //   cloudflared tunnel [tunnel options] run [run options] [TUNNEL]
    expect(
      namedTunnelArgs(
        { name: 'muxpad', hostname: 'artifacts.example.dev', credentialsFile: '/x' },
        local,
      ),
    ).toEqual(['tunnel', '--no-autoupdate', 'run', '--url', local, 'muxpad']);
  });

  it('keeps the quick-tunnel form exactly as it was', () => {
    // The fallback must not shift under a feature that is about the other case.
    expect(quickTunnelArgs(local)).toEqual(['tunnel', '--url', local, '--no-autoupdate']);
  });

  it('never lets muxpad run a named tunnel through a config file instead', () => {
    // `--config` would let cloudflared pick its own ingress, bypassing the
    // port muxpad passes AND the fingerprint check in run.ts that keeps the
    // unauthenticated main server off the internet. The port is always ours.
    const args = namedTunnelArgs(
      { name: 'muxpad', hostname: 'artifacts.example.dev', credentialsFile: '/x' },
      local,
    );
    expect(args).not.toContain('--config');
    expect(args[args.indexOf('--url') + 1]).toBe(local);
  });
});
