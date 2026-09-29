import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TAILSCALE_APP_BIN, tailscaleBins } from './tailscale-bin.js';

const execFileAsync = promisify(execFile);
const MUXPAD_BIN = resolve(import.meta.dirname, '../../scripts/muxpad');

describe('tailscaleBins', () => {
  it('prefers PATH, then the macOS app bundle', () => {
    expect(tailscaleBins({})).toEqual(['tailscale', TAILSCALE_APP_BIN]);
  });

  it('an explicit MUXPAD_TAILSCALE_BIN is EXCLUSIVE — no app-bundle fallthrough', () => {
    // The override existing at all is what keeps tests off the real binary.
    // If a missing/broken override silently fell through to the app bundle,
    // a test would exec the real tailscale — expose a funnel, and pop the
    // macOS "access data from other apps" prompt this module exists to stop.
    expect(tailscaleBins({ MUXPAD_TAILSCALE_BIN: '/tmp/stub' })).toEqual(['/tmp/stub']);
  });

  it('treats an empty override as unset', () => {
    expect(tailscaleBins({ MUXPAD_TAILSCALE_BIN: '' })).toEqual(['tailscale', TAILSCALE_APP_BIN]);
  });
});

// The shell CLI cannot import the helper above, so the ONE policy is enforced
// across the language boundary by asking both for their answer. `muxpad
// _tailscale-bin` is the shell side's only seam onto find_tailscale.
describe('the shell CLI agrees with the helper', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-tsbin-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const bin = async (env: Record<string, string>) => {
    const { stdout } = await execFileAsync(MUXPAD_BIN, ['_tailscale-bin'], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    return stdout.trim();
  };

  it('honours an executable MUXPAD_TAILSCALE_BIN', async () => {
    const stub = join(tmp, 'ts-stub.sh');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await bin({ MUXPAD_TAILSCALE_BIN: stub })).toBe(stub);
    expect(tailscaleBins({ MUXPAD_TAILSCALE_BIN: stub })).toEqual([stub]);
  });

  it('resolves NOTHING when the override points at a missing file', async () => {
    // Matching tailscaleBins' exclusivity: the override is the whole list, so
    // when it is absent there is no binary — not the app bundle.
    expect(await bin({ MUXPAD_TAILSCALE_BIN: join(tmp, 'nope') })).toBe('');
  });

  // The pre-flight that decides whether to shell out talks to the server over
  // curl, inside a script that runs `set -euo pipefail`. Under pipefail a
  // failed curl makes the whole `x="$(curl … | jq …)"` assignment non-zero, and
  // under `set -e` that terminates the script — so a server that is down or
  // merely slower than the 2s budget would abort the publish outright. Asking
  // "do I need to discover?" must never be able to do that; the answer to an
  // unanswered question is "assume yes", which is the old behaviour.
  it('survives an unreachable server instead of aborting the publish', async () => {
    // execFileAsync REJECTS on a non-zero exit, so "this call resolved at all"
    // is the assertion that matters — the old code exited 7 here.
    const { stdout, stderr } = await execFileAsync(MUXPAD_BIN, ['_publish-base-url'], {
      env: {
        ...process.env,
        // Nothing is listening here, so the pre-flight curl fails outright.
        MUXPAD_API_URL: 'http://127.0.0.1:59999',
        // …and no tailscale to fall through to either.
        MUXPAD_TAILSCALE_BIN: join(tmp, 'absent'),
      },
      encoding: 'utf-8',
    });
    // Either the no-exec PTR path found a name, or nothing did. Both are fine;
    // a crash is not, and neither is noise on stderr.
    expect(stdout === '' || /^https:\/\/[a-z0-9.-]+\.ts\.net:8443$/.test(stdout.trim())).toBe(true);
    expect(stderr).toBe('');
  });

  // Same hole, worse blast radius. `muxpad agent new` calls printable_base at
  // the very END — the tab is created and the first message already delivered —
  // so aborting there loses the URL for work that has actually happened.
  it('printable_base degrades to the API url instead of aborting', async () => {
    const { stdout } = await execFileAsync(MUXPAD_BIN, ['_printable-base'], {
      env: { ...process.env, MUXPAD_API_URL: 'http://127.0.0.1:59999', MUXPAD_PUBLIC_BASE_URL: '' },
      encoding: 'utf-8',
    });
    expect(stdout.trim()).toBe('http://127.0.0.1:59999');
  });

  /**
   * THE COCKPIT BASE IS NOT THE ARTIFACT BASE.
   *
   * `MUXPAD_PUBLIC_BASE_URL` is documented in exactly one way — config.ts, "the
   * origin published artifact links are built from" — and `printable_base`
   * builds something else entirely: the COCKPIT url, `<base>/w/<ws>/t/<tab>`,
   * printed by `muxpad agent new`.
   *
   * The two are deliberately different hosts and must stay that way. The
   * artifact server (:7778, loopback, serves only `/<slug>/`) is the one meant
   * to be on the public internet; the cockpit (:7777) has NO authentication at
   * all — its whole security model is being tailnet-only, and its api hands out
   * the pane list and a shell. So reading the artifact origin here did two
   * wrong things at once: printed agent links that 404 (no `/w/...` route
   * exists on the public server), and advertised the private surface under the
   * public hostname.
   *
   * Latent until someone sets the variable, which is precisely the migration
   * that makes artifact links permanent — so it would have fired on the day the
   * URLs finally stopped rotating.
   */
  it('does NOT build the cockpit url from the artifact base', async () => {
    const { stdout } = await execFileAsync(MUXPAD_BIN, ['_printable-base'], {
      env: {
        ...process.env,
        // Unreachable on purpose: it empties the candidate list, so the only
        // ways out are the artifact origin (the bug) or this url (correct).
        MUXPAD_API_URL: 'http://127.0.0.1:59999',
        MUXPAD_PUBLIC_BASE_URL: 'https://artifacts.example.com',
      },
      encoding: 'utf-8',
    });
    expect(stdout.trim()).toBe('http://127.0.0.1:59999');
  });

  // THE WHOLE POINT. Tailscale is a Mac App Store install, so the only binary
  // is inside the sandboxed bundle and touching it always prompts. The CLI must
  // therefore work out the tailnet name the way tailnet-hostname.ts does —
  // 100.64/10 address, reverse-resolved through MagicDNS — and reach for the
  // bundle only when that comes up empty.
  describe('the no-exec tailnet path', () => {
    const hasTailnet = async () => (await bin2('_tailnet-hostname')) !== '';
    const bin2 = async (verb: string, env: Record<string, string> = {}) => {
      const { stdout } = await execFileAsync(MUXPAD_BIN, [verb], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
      });
      return stdout.trim();
    };

    it('either finds a *.ts.net name or nothing — never a half-built guess', async () => {
      const got = await bin2('_tailnet-hostname');
      // `scutil --get LocalHostName` was the tempting shortcut and it is wrong:
      // on the affected machine it answers `home` while the tailnet name is
      // `dt-mac-mini`, so gluing it to the tailnet suffix would mint
      // `home.example-tailnet.ts.net` and a public link that cannot work. Only a name
      // that came back from the PTR is acceptable.
      expect(got === '' || /^[a-z0-9-]+(\.[a-z0-9-]+)+\.ts\.net$/.test(got)).toBe(true);
    });

    it('prefers the PTR over the bundle, and never execs it', async () => {
      if (!(await hasTailnet())) return; // no tailnet on this box; nothing to prove
      const log = join(tmp, 'must-not-run.log');
      const stub = join(tmp, 'must-not-run.sh');
      writeFileSync(stub, `#!/bin/sh\necho ran >> "${log}"\nexit 0\n`, { mode: 0o755 });
      // No server answering, so the pre-flight cannot rule discovery out — this
      // is the COLD path, exactly where the old code execed.
      const got = await bin2('_publish-base-url', {
        MUXPAD_API_URL: 'http://127.0.0.1:59999',
        MUXPAD_TAILSCALE_BIN: stub,
      });
      expect(got).toMatch(/^https:\/\/[a-z0-9.-]+\.ts\.net:8443$/);
      expect(existsSync(log), 'the CLI execed tailscale despite the PTR working').toBe(false);
      // …and it agrees with the hostname seam it is built on.
      expect(got).toBe(`https://${await bin2('_tailnet-hostname')}:8443`);
    });
  });

  it('falls back to the app bundle when PATH has no tailscale', async () => {
    // A PATH with no tailscale on it is the machine this bug was reported on:
    // `which tailscale` finds nothing, so every resolver lands on the app
    // bundle. (Trimmed rather than emptied — the script's `env bash` shebang
    // needs /usr/bin to start at all.)
    const got = await bin({ MUXPAD_TAILSCALE_BIN: '', PATH: '/usr/bin:/bin' });
    // Only assert the app bundle when this machine actually has one; the
    // precedence itself is pinned by the pure-helper test above.
    expect(got === TAILSCALE_APP_BIN || got === '').toBe(true);
    expect(tailscaleBins({}).at(-1)).toBe(TAILSCALE_APP_BIN);
  });
});
