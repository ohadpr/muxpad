import { describe, expect, it } from 'vitest';
import { CHROME_BIN_ENV, findChrome, newestPlaywrightChromium } from './findChrome.js';

/**
 * Finding a browser WITHOUT raising a macOS permission dialog.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ----------------------------
 * The first version of this walked a candidate list that included
 * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and stat'd it.
 * On macOS, any syscall into another application's bundle is TCC-gated, so that
 * put
 *
 *     "node" would like to access data from other apps   [Don't Allow] [Allow]
 *
 * on the physical screen of the machine running muxpad, while somebody was
 * working. `agent-instructions.ts` forbids putting a window on the user's
 * screen; a system permission dialog is a window on their screen.
 *
 * The same mistake, in a different file, was fixed hours earlier in `7dcf5f1`
 * (muxpad was exec'ing the binary inside Tailscale.app to print a URL). The rule
 * that came out of it is NEVER TOUCH THE BUNDLE — not "touch it less".
 *
 * So the invariant these tests hold is not about which browser wins. It is:
 * **no syscall is ever made against a path inside a `.app`.** Discovery may
 * RETURN such a path — the Playwright build is one — but it constructs it from
 * directory listings that stop at the bundle boundary, and lets `spawn` be the
 * thing that finds out whether it is really there.
 */

const PW = '/home/Library/Caches/ms-playwright';

/** Records every filesystem touch so a test can assert where we did NOT go. */
function deps(
  opts: {
    tree?: Record<string, string[]>;
    present?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const present = new Set(opts.present ?? []);
  const listed: string[] = [];
  const stated: string[] = [];
  return {
    listed,
    stated,
    deps: {
      env: opts.env ?? {},
      home: '/home',
      list: (dir: string) => {
        listed.push(dir);
        return opts.tree?.[dir] ?? [];
      },
      exists: (p: string) => {
        stated.push(p);
        return present.has(p);
      },
    },
  };
}

/** A realistic playwright cache: a revision dir holding a platform dir. */
const PW_TREE = {
  [PW]: ['chromium-1187', 'chromium-1246', 'chromium_headless_shell-1246', 'webkit-2361'],
  [`${PW}/chromium-1246`]: ['chrome-mac-arm64'],
  [`${PW}/chromium-1246/chrome-mac-arm64`]: ['Google Chrome for Testing.app', 'ABOUT'],
};

describe('THE RULE: never syscall into an app bundle', () => {
  it('stats nothing inside a .app, in any discovery path', () => {
    const { deps: d, stated } = deps({ tree: PW_TREE });
    findChrome(d);
    for (const path of stated) expect(path, path).not.toContain('.app/');
  });

  it('lists nothing inside a .app — the listing stops at the bundle', () => {
    const { deps: d, listed } = deps({ tree: PW_TREE });
    findChrome(d);
    for (const dir of listed) expect(dir, dir).not.toContain('.app/');
  });

  it('never even CONSIDERS another application’s bundle', () => {
    // With no playwright cache at all, the old code fell through to
    // /Applications. It must now find nothing rather than reach for it.
    const {
      deps: d,
      stated,
      listed,
    } = deps({
      present: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ],
    });
    expect(findChrome(d)).toBeNull();
    for (const path of [...stated, ...listed]) {
      expect(path, path).not.toContain('/Applications/');
    }
  });

  it('does not stat an explicit override either — the stat IS the hazard', () => {
    // Somebody may point MUXPAD_CHROME_BIN at a browser inside a bundle. We
    // take them at their word and let spawn find out, rather than provoking a
    // dialog to check.
    const { deps: d, stated } = deps({
      env: { [CHROME_BIN_ENV]: '/Applications/Some Browser.app/Contents/MacOS/x' },
    });
    expect(findChrome(d)?.path).toBe('/Applications/Some Browser.app/Contents/MacOS/x');
    expect(stated).toHaveLength(0);
  });
});

describe('what it picks', () => {
  it('prefers an explicit override, and says so', () => {
    const { deps: d } = deps({ env: { [CHROME_BIN_ENV]: '/opt/my-chrome' }, tree: PW_TREE });
    expect(findChrome(d)).toEqual({ path: '/opt/my-chrome', source: CHROME_BIN_ENV });
  });

  it('otherwise takes the Playwright-managed build muxpad already owns', () => {
    const { deps: d } = deps({ tree: PW_TREE });
    const found = findChrome(d);
    expect(found?.path).toBe(
      `${PW}/chromium-1246/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    );
    expect(found?.source).toBe('playwright');
  });

  it('handles the older Chromium.app layout', () => {
    const { deps: d } = deps({
      tree: {
        [PW]: ['chromium-1100'],
        [`${PW}/chromium-1100`]: ['chrome-mac'],
        [`${PW}/chromium-1100/chrome-mac`]: ['Chromium.app'],
      },
    });
    expect(findChrome(d)?.path).toBe(
      `${PW}/chromium-1100/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
    );
  });

  it('handles linux, where there is no bundle at all', () => {
    const { deps: d } = deps({
      tree: {
        [PW]: ['chromium-1246'],
        [`${PW}/chromium-1246`]: ['chrome-linux'],
        [`${PW}/chromium-1246/chrome-linux`]: ['chrome', 'headless_shell'],
      },
    });
    expect(findChrome(d)?.path).toBe(`${PW}/chromium-1246/chrome-linux/chrome`);
  });

  it('is null when there is no managed build and no override', () => {
    // Null is the honest answer, and the caller turns it into a message that
    // names the fix. Guessing at somebody's real browser is what caused this.
    expect(findChrome(deps().deps)).toBeNull();
  });
});

describe('picking a playwright build', () => {
  it('takes the HIGHEST revision numerically, not alphabetically', () => {
    // String sort puts chromium-999 above chromium-1246, silently pinning a
    // browser several versions old depending on download history.
    expect(newestPlaywrightChromium(['chromium-999', 'chromium-1246', 'chromium-1187'])).toBe(
      'chromium-1246',
    );
  });

  it('ignores entries that are not chromium builds', () => {
    expect(
      newestPlaywrightChromium(['webkit-2361', 'ffmpeg-1011', 'chromium_headless_shell-1246']),
    ).toBeNull();
  });

  it('is null when there is nothing to pick', () => {
    expect(newestPlaywrightChromium([])).toBeNull();
  });
});
