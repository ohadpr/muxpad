import { constants, accessSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding a browser without raising a macOS permission dialog.
 *
 * THE RULE: NEVER SYSCALL INTO AN APP BUNDLE
 * ------------------------------------------
 * The first version of this walked a candidate list ending in
 * `/Applications/Google Chrome.app/…` and stat'd each entry. On macOS any
 * syscall into another application's bundle is TCC-gated, so it put
 *
 *     "node" would like to access data from other apps   [Don't Allow] [Allow]
 *
 * on the physical screen of the machine running muxpad, while somebody was
 * working. The browser policy in agent-instructions.ts forbids putting a window
 * on the user's screen, and a system permission dialog is a window on their
 * screen — arguably the worst kind, since it interrupts whatever they were
 * doing and cannot be dismissed by anything muxpad controls.
 *
 * The identical mistake, in `scripts/muxpad`, was fixed hours earlier in
 * `7dcf5f1`: it exec'd the binary inside Tailscale.app to print a URL. The
 * lesson recorded there is that the fix is NEVER CALL IT, not "call it less" —
 * a prompt on a rare path is still a prompt on somebody's screen.
 *
 * So this module does not auto-discover a browser at all. It takes an explicit
 * path, or it uses the Chromium that Playwright manages under
 * `~/Library/Caches/ms-playwright` — which muxpad's own tooling downloaded and
 * which is not a registered application — or it answers null and lets the caller
 * say so. Guessing at somebody's real Chrome is precisely what caused the bug,
 * and it was never even the browser we wanted: launching the user's actual
 * Chrome also fights the profile they are browsing in.
 *
 * WHY IT MAY RETURN A PATH IT HAS NOT CHECKED
 * -------------------------------------------
 * Verifying a path inside a bundle means stat-ing inside a bundle, which is the
 * hazard itself. So discovery stops at the bundle boundary: it lists the
 * revision and platform directories (ordinary directories), sees which `.app` is
 * there by NAME, and composes the executable path from a known layout. Whether
 * that file truly exists is left to `spawn`, which fails loudly and names the
 * path. A loud failure is a fine outcome; a dialog on somebody's desk is not.
 */

/** Env var that pins the binary. Exclusive — set it and nothing else is tried. */
export const CHROME_BIN_ENV = 'MUXPAD_CHROME_BIN';

export interface FindChromeDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Directory listing, injected for tests. Returns [] for a missing dir. */
  list?: (dir: string) => string[];
  /** Existence check. Only ever called on paths OUTSIDE any bundle. */
  exists?: (path: string) => boolean;
}

export interface FoundChrome {
  path: string;
  /** Where it came from, so the log can say why this browser and not another. */
  source: string;
}

const defaultList = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const defaultExists = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Playwright keeps every chromium build it has downloaded, named
 * `chromium-<revision>`. Pick the HIGHEST revision numerically — string sort
 * puts `chromium-999` above `chromium-1246`, which silently pins a browser
 * several versions old depending on download history.
 */
export function newestPlaywrightChromium(entries: string[], prefix = 'chromium'): string | null {
  const revisions = entries
    .map((name) => new RegExp(`^${prefix}-(\\d+)$`).exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  return revisions.length ? `${prefix}-${revisions[0]}` : null;
}

/**
 * ── WHY THE SHELL IS PREFERRED, AND NOT MERELY ALLOWED ───────────────────
 * `--headless=new` means NO WINDOW. It does not mean no app. It is the whole
 * browser: the full `.app` bundle, the macOS menu-bar integration, Cast and
 * its mDNS discovery, and every TCC identity that goes with being a
 * registered application. On this machine that produced two interruptions on
 * the owner's physical screen from a browser with no window — a search icon
 * in the menu bar for every live session, and
 *
 *     Allow "Google Chrome for Testing Helper" to find devices
 *     on local networks?
 *
 * which is the Local Network gate, raised by Chrome's own multicast discovery
 * rather than by anything an agent did. The module comment above records the
 * same lesson from the Keychain dialog: the fix is never to do it, not to do
 * it less.
 *
 * `chrome-headless-shell` is a BARE EXECUTABLE — no bundle, no menu bar, no
 * Dock, no app identity to prompt about, no media router to multicast with.
 * It is the same build number as the Chrome beside it, and it was already on
 * disk. Measured through CDP before this changed: navigation, screenshots,
 * `Page.startScreencast` (the viewer) and `Input.dispatchMouseEvent` (the
 * human taking the wheel) all work.
 *
 * WHAT IT COSTS, stated plainly: the shell is far easier for a site to
 * fingerprint than the full browser, so a login-walled site may block it. The
 * owner's answer, which is what settled this: "the headless browsing isn't a
 * big feature, I use it mostly to validate work we're building here." If a
 * site ever needs the real thing, `MUXPAD_CHROME_BIN` points at it and
 * nothing else changes.
 */
const HEADLESS_SHELL = 'chromium_headless_shell';

/**
 * The executable inside a playwright platform directory, named but not touched.
 *
 * Keyed on the `.app` we can see by LISTING the platform directory — which is an
 * ordinary directory — so the bundle is never opened.
 */
const BUNDLE_EXECUTABLES: ReadonlyArray<[bundle: string, executable: string]> = [
  ['Google Chrome for Testing.app', 'Contents/MacOS/Google Chrome for Testing'],
  ['Chromium.app', 'Contents/MacOS/Chromium'],
];

/** Plain executables, on platforms with no bundles. */
const PLAIN_EXECUTABLES = [
  // First, and deliberately: this is the one with no app surface at all.
  'chrome-headless-shell',
  'chrome',
  'chrome.exe',
  'headless_shell',
];

function executableIn(platformDir: string, entries: string[]): string | null {
  for (const [bundle, rel] of BUNDLE_EXECUTABLES) {
    // By NAME, from the listing. We never descend into the bundle to confirm.
    if (entries.includes(bundle)) return join(platformDir, bundle, rel);
  }
  for (const plain of PLAIN_EXECUTABLES) {
    if (entries.includes(plain)) return join(platformDir, plain);
  }
  return null;
}

/**
 * A browser muxpad may own, or null.
 *
 * Null is a real answer and the caller turns it into a message that names the
 * fix. It is a much better outcome than a dialog.
 */
export function findChrome(deps: FindChromeDeps = {}): FoundChrome | null {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const list = deps.list ?? defaultList;

  // 1. An explicit path wins outright and is NOT verified. Somebody may point
  //    this at a browser inside a bundle, and stat-ing to check would raise the
  //    very prompt this module exists to avoid. Take them at their word.
  const override = env[CHROME_BIN_ENV];
  if (override) return { path: override, source: CHROME_BIN_ENV };

  // 2. The builds Playwright manages for muxpad. Listing stops at the bundle.
  //    THE SHELL FIRST — see the note above. The full browser is the fallback
  //    for an install that has no shell downloaded, not the preference.
  const cache = join(home, 'Library', 'Caches', 'ms-playwright');
  const entries = list(cache);
  for (const [prefix, source] of [
    [HEADLESS_SHELL, 'playwright headless shell'],
    ['chromium', 'playwright chromium'],
  ] as const) {
    const newest = newestPlaywrightChromium(entries, prefix);
    if (!newest) continue;
    const revisionDir = join(cache, newest);
    for (const platform of list(revisionDir)) {
      if (!platform.startsWith('chrome-')) continue;
      const platformDir = join(revisionDir, platform);
      const executable = executableIn(platformDir, list(platformDir));
      if (executable) return { path: executable, source };
    }
  }

  // 3. Nothing. Deliberately NOT falling through to /Applications — see the
  //    module comment. There is no third option that is worth a dialog.
  return null;
}

/** Exported only so a caller can check a NON-bundle path when it wants to. */
export const chromeExists = defaultExists;
