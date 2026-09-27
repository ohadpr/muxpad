import { describe, expect, it } from 'vitest';
import { CHROME_BIN_ENV, findChrome, newestPlaywrightChromium } from './findChrome.js';

const PW = '/home/Library/Caches/ms-playwright';
const CFT =
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

function deps(opts: { entries?: string[]; present?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const present = new Set(opts.present ?? []);
  return {
    env: opts.env ?? {},
    home: '/home',
    list: (dir: string) => (dir === PW ? (opts.entries ?? []) : []),
    exists: (p: string) => present.has(p),
  };
}

describe('picking a playwright build', () => {
  it('takes the HIGHEST revision numerically, not alphabetically', () => {
    // String sort puts chromium-999 above chromium-1246, which silently pins a
    // browser several versions old depending on download history.
    expect(newestPlaywrightChromium(['chromium-999', 'chromium-1246', 'chromium-1187'])).toBe(
      'chromium-1246',
    );
  });

  it('ignores entries that are not chromium builds', () => {
    expect(
      newestPlaywrightChromium(['webkit-2361', 'ffmpeg-1011', 'chromium_headless_shell-1246']),
    ).toBeNull();
    expect(newestPlaywrightChromium(['chromium-1246', 'webkit-2361'])).toBe('chromium-1246');
  });

  it('is null when there is nothing to pick', () => {
    expect(newestPlaywrightChromium([])).toBeNull();
  });
});

describe('finding chrome', () => {
  it('prefers Chrome for Testing over the user’s own browser', () => {
    // Launching the user's Google Chrome puts a second dock icon on their
    // machine and fights their real profile. Chrome for Testing does neither.
    const path = findChrome(
      deps({
        entries: ['chromium-1246'],
        present: [
          `${PW}/chromium-1246/${CFT}`,
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ],
      }),
    );
    expect(path).toContain('ms-playwright');
  });

  it('falls back to the user’s Chrome only when there is nothing else', () => {
    const path = findChrome(
      deps({ present: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] }),
    );
    expect(path).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('lets an explicit override win outright', () => {
    const path = findChrome(
      deps({
        env: { [CHROME_BIN_ENV]: '/opt/my-chrome' },
        present: ['/opt/my-chrome', `${PW}/chromium-1246/${CFT}`],
        entries: ['chromium-1246'],
      }),
    );
    expect(path).toBe('/opt/my-chrome');
  });

  it('returns null for an override that is not there, rather than guessing past it', () => {
    // Silently ignoring a pin and launching something else is how you spend an
    // hour debugging a browser you did not think you were running.
    const path = findChrome(
      deps({
        env: { [CHROME_BIN_ENV]: '/opt/missing' },
        entries: ['chromium-1246'],
        present: [`${PW}/chromium-1246/${CFT}`],
      }),
    );
    expect(path).toBeNull();
  });

  it('is null when the machine has no chrome at all', () => {
    expect(findChrome(deps())).toBeNull();
  });
});
