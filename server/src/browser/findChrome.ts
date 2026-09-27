import { constants, accessSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding a Chrome to own.
 *
 * WHY NOT THE USER'S OWN GOOGLE CHROME, FIRST
 * -------------------------------------------
 * Because launching it against a muxpad profile directory while the person has
 * Chrome open is how you get a second dock icon, a window on their screen, and
 * a profile-lock fight with their actual browsing. Playwright's bundled
 * `Chrome for Testing` is a separate binary with no such entanglement, it is
 * already on this machine (the MCP servers use it), and it is the build every
 * CDP behaviour in this subsystem was verified against.
 *
 * So the order is: an explicit override, then Chrome for Testing, and the
 * user's own Chrome only as a last resort — where it still runs headless
 * against its own profile dir, but is likelier to surprise someone.
 *
 * Nothing here spawns anything, so it is testable with an injected lister.
 */

/** Env var that pins the binary, for a machine where discovery guesses wrong. */
export const CHROME_BIN_ENV = 'MUXPAD_CHROME_BIN';

export interface FindChromeDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Directory listing, injected for tests. Returns [] for a missing dir. */
  list?: (dir: string) => string[];
  /** Existence check, injected for tests. */
  exists?: (path: string) => boolean;
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
 * Playwright keeps every chromium build it has ever downloaded, named
 * `chromium-<revision>`. Pick the HIGHEST revision numerically — string sort
 * puts `chromium-999` above `chromium-1246`, which silently pins a browser
 * several versions old and makes "works on my machine" depend on download
 * history.
 */
export function newestPlaywrightChromium(entries: string[]): string | null {
  const revisions = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  return revisions.length ? `chromium-${revisions[0]}` : null;
}

/** Absolute path to a Chrome muxpad may own, or null. */
export function findChrome(deps: FindChromeDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const list = deps.list ?? defaultList;
  const exists = deps.exists ?? defaultExists;

  // 1. An explicit override always wins, and is not second-guessed.
  const override = env[CHROME_BIN_ENV];
  if (override) return exists(override) ? override : null;

  // 2. Playwright's Chrome for Testing — separate from the user's browser.
  const cache = join(home, 'Library', 'Caches', 'ms-playwright');
  const newest = newestPlaywrightChromium(list(cache));
  if (newest) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-linux/chrome',
    ]) {
      const candidate = join(cache, newest, rel);
      if (exists(candidate)) return candidate;
    }
  }

  // 3. The user's own Chrome, last. Still headless, still its own profile dir,
  //    but likelier to collide with a browser they are actually using.
  for (const candidate of [
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
