import { describe, expect, it } from 'vitest';
import { browserLaunchSpec, chromeArgv } from './BrowserLaunch.js';

/**
 * How a muxpad-owned browser is launched.
 *
 * THE INVARIANT THESE TESTS EXIST TO PIN
 * --------------------------------------
 * It is headless. Always. No flag, no option, no environment variable makes it
 * otherwise. This runs on somebody's live workstation and a browser window
 * appearing on their screen — mid-meeting, driven by an agent — is the one
 * outcome the whole browser policy in agent-instructions.ts exists to prevent.
 *
 * "But the human needs to see it" is NOT an argument for headed: they see it
 * through the CDP screencast, from wherever they are, including their phone.
 * The pixels never need to be on this machine's display.
 */
const OPTS = { profile: 'shopping', port: 9410, dataDir: '/data', chromePath: '/bin/chrome' };

describe('the headless invariant', () => {
  it('always passes a headless flag', () => {
    expect(chromeArgv(OPTS).some((a) => a.startsWith('--headless'))).toBe(true);
  });

  it('cannot be talked out of it by the caller', () => {
    // There is deliberately no `headless` option to pass. If someone adds one,
    // this fails to compile and then fails here — which is the point.
    const sneaky = { ...OPTS, headless: false, headed: true } as never;
    expect(chromeArgv(sneaky).some((a) => a.startsWith('--headless'))).toBe(true);
  });

  it('never touches the macOS Keychain, which is a system password PROMPT', () => {
    // Observed in the first real run: Chrome reaches for the Keychain to
    // encrypt its password store. On this machine that is a modal dialog on the
    // user's actual screen — the exact thing headless is here to prevent, and it
    // would appear with no agent able to dismiss it.
    const argv = chromeArgv(OPTS);
    expect(argv).toContain('--password-store=basic');
    expect(argv).toContain('--use-mock-keychain');
  });

  it('never asks to be the default browser or shows first-run UI', () => {
    const argv = chromeArgv(OPTS);
    expect(argv).toContain('--no-first-run');
    expect(argv).toContain('--no-default-browser-check');
  });
});

describe('the debugging port', () => {
  it('binds loopback, never a wide interface', () => {
    const argv = chromeArgv(OPTS);
    expect(argv).toContain('--remote-debugging-port=9410');
    expect(argv).toContain('--remote-debugging-address=127.0.0.1');
    expect(argv.some((a) => a.includes('0.0.0.0'))).toBe(false);
  });

  it('refuses a port outside the reserved range', () => {
    expect(() => chromeArgv({ ...OPTS, port: 3000 })).toThrow(/port/i);
    expect(() => chromeArgv({ ...OPTS, port: 0 })).toThrow(/port/i);
  });
});

describe('the profile', () => {
  it('points at the named profile directory under the data dir', () => {
    expect(chromeArgv(OPTS)).toContain('--user-data-dir=/data/browser-profiles/shopping');
  });

  it('is NOT isolated — the whole point is that cookies survive', () => {
    const argv = chromeArgv(OPTS);
    expect(argv.some((a) => a.includes('incognito'))).toBe(false);
    expect(argv.some((a) => a.includes('guest'))).toBe(false);
  });

  it('rejects a profile name that would escape the directory', () => {
    expect(() => chromeArgv({ ...OPTS, profile: '../../etc' })).toThrow(/profile name/i);
  });
});

describe('the launch spec as a whole', () => {
  it('names the app row after the profile it owns', () => {
    const spec = browserLaunchSpec(OPTS);
    expect(spec.slug).toBe('browser-shopping');
    expect(spec.url).toBe('http://127.0.0.1:9410');
  });

  it('carries the profile directory so the caller can create it', () => {
    expect(browserLaunchSpec(OPTS).profileDir).toBe('/data/browser-profiles/shopping');
  });

  it('quotes nothing and escapes nothing — argv is a list, not a shell string', () => {
    // A profile name is user input. If this were ever joined into a shell
    // command, `; rm -rf` would be a profile name. Keeping it argv-shaped is
    // what makes that structurally impossible.
    const spec = browserLaunchSpec({ ...OPTS, chromePath: '/path with spaces/chrome' });
    expect(spec.command).toBe('/path with spaces/chrome');
    expect(Array.isArray(spec.args)).toBe(true);
    expect(spec.args.every((a) => typeof a === 'string')).toBe(true);
  });
});

describe('nothing it launches may reach the local network on its own', () => {
  const args = chromeArgv({ profile: 'p', port: 9400, dataDir: '/d', chromePath: '/c' });

  it('turns off Cast discovery, which is what raised the Local Network prompt', () => {
    // Observed on the owner's real screen, from a browser with NO WINDOW:
    // "Allow Google Chrome for Testing Helper to find devices on local
    // networks?" — Chrome's own multicast, not anything an agent navigated
    // to. Same family as the Keychain dialog this file already guards.
    const features = args.find((a) => a.startsWith('--disable-features='));
    expect(features).toBeDefined();
    expect(features).toContain('MediaRouter');
  });

  it('does no background networking either', () => {
    expect(args).toContain('--disable-background-networking');
    expect(args).toContain('--disable-component-update');
  });

  it('still binds the debugger to loopback only', () => {
    // Re-asserted beside the new flags: this machine is on a tailnet, and the
    // one thing that must never widen is the port that drives the browser.
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args.some((a) => /--remote-debugging-address=(0\.0\.0\.0|::)/.test(a))).toBe(false);
  });
});
