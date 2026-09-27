import {
  BROWSER_PORT_RANGE,
  browserAppName,
  browserAppSlug,
  browserAppUrl,
  browserProfileDir,
  normalizeProfileName,
} from './BrowserProfile.js';

/**
 * How a muxpad-owned browser is launched.
 *
 * THE INVARIANT
 * -------------
 * It is HEADLESS. Always. There is deliberately no option to pass, which is why
 * {@link BrowserLaunchOptions} has no `headless` field: the only way to launch a
 * headed browser through this module is to edit this file, and the test suite
 * fails when you do.
 *
 * This is not fussiness. muxpad runs on a live workstation. A browser window
 * opening on the user's actual screen — mid-meeting, driven by an agent that
 * decided to check something — is the single outcome the browser policy in
 * agent-instructions.ts exists to prevent, and it is also the reason that policy
 * forbids agents from launching browsers by hand.
 *
 * "But sometimes the human has to drive it" is the obvious objection and it is
 * answered elsewhere, not here: the human drives it over a CDP screencast, from
 * whatever device they happen to be holding. The pixels never have to exist on
 * this machine's display for a person to see and click them. Headless costs us
 * exactly one thing — native `<select>` popups are OS widgets and do not appear
 * in the screencast — and that is paid for with a dropdown shim in the viewer,
 * not by putting a window on someone's desk.
 *
 * WHY THERE IS NO SHELL STRING HERE
 * ---------------------------------
 * A profile name is user input and it ends up next to a path on a command line.
 * Everything this module returns is argv-shaped — a command plus an array — so
 * a profile called `; rm -rf ~` is a directory name with a silly spelling
 * rather than an incident. {@link normalizeProfileName} would reject it anyway;
 * this is the second lock on the same door.
 */

export interface BrowserLaunchOptions {
  /** Profile name. Normalized, and the only thing that varies between owners. */
  profile: string;
  /** Loopback CDP port. Must be inside {@link BROWSER_PORT_RANGE}. */
  port: number;
  /** muxpad's data dir; profiles live under it. */
  dataDir: string;
  /** Absolute path to the Chrome/Chromium binary. */
  chromePath: string;
  /** Viewport of the single window the owner opens. */
  windowSize?: { width: number; height: number };
}

export interface BrowserLaunchSpec {
  /** App-row slug. One per profile — see BrowserProfile.ts. */
  slug: string;
  /** Human-facing row name. */
  name: string;
  /** Loopback base URL of the owner. */
  url: string;
  /** Profile directory; the caller creates it before launching. */
  profileDir: string;
  /** Executable. Never interpolated into a shell. */
  command: string;
  /** Arguments, as a list. */
  args: string[];
}

const DEFAULT_WINDOW = { width: 1280, height: 900 };

/**
 * Chrome's argv for a muxpad-owned browser.
 *
 * @throws if the port is outside the reserved range, or the profile name is
 *   not a legal path segment.
 */
export function chromeArgv(opts: BrowserLaunchOptions): string[] {
  const profile = normalizeProfileName(opts.profile);
  const [lo, hi] = BROWSER_PORT_RANGE;
  if (!Number.isInteger(opts.port) || opts.port < lo || opts.port > hi) {
    throw new Error(`browser port ${opts.port} is outside the reserved range ${lo}-${hi}`);
  }
  const win = opts.windowSize ?? DEFAULT_WINDOW;

  return [
    // Not configurable. See the module comment.
    '--headless=new',

    // Loopback only. This machine is on a tailnet, and a debugging port bound
    // wide is a driveable browser — holding every cookie the user has — offered
    // to every device on the network.
    `--remote-debugging-port=${opts.port}`,
    '--remote-debugging-address=127.0.0.1',

    // The whole point: a real profile on disk that accumulates cookies and
    // reputation between runs. Emphatically NOT --incognito or --guest.
    `--user-data-dir=${browserProfileDir(opts.dataDir, profile)}`,

    // NO KEYCHAIN. Chrome reaches for the macOS Keychain to encrypt its saved
    // password store, and on this machine that is a MODAL SYSTEM DIALOG on the
    // user's real screen — headless or not, because it belongs to the OS rather
    // than to the browser. Observed on the first real run of the host. Nothing
    // would be able to dismiss it either, since no agent can see it.
    //
    // The cost is that saved passwords are not encrypted at rest by the
    // Keychain. That is the right trade here: these profiles hold session
    // cookies muxpad manages, not a password vault, and a browser that cannot
    // start unattended is worth nothing.
    '--password-store=basic',
    '--use-mock-keychain',

    `--window-size=${win.width},${win.height}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** Everything the app registry needs to own this browser. */
export function browserLaunchSpec(opts: BrowserLaunchOptions): BrowserLaunchSpec {
  const profile = normalizeProfileName(opts.profile);
  return {
    slug: browserAppSlug(profile),
    name: browserAppName(profile),
    url: browserAppUrl(opts.port),
    profileDir: browserProfileDir(opts.dataDir, profile),
    command: opts.chromePath,
    args: chromeArgv(opts),
  };
}
