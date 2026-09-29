import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_SHOT_CAP,
  browserShotDir,
  browserShotPath,
  clearBrowserShots,
  saveBrowserShot,
  shotsToPrune,
} from './BrowserShots.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'shots-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('where a still lives', () => {
  it('is named by the moment it belongs to', () => {
    // One file per MOMENT, not one per browser: a single "current.jpg" would
    // rewrite history, so yesterday's summons would illustrate itself with
    // today's page.
    expect(browserShotPath('/data', 'shopping', 1700)).toBe(
      '/data/browser-shots/shopping/1700.jpg',
    );
  });

  it('refuses a profile name that could climb out of the directory', () => {
    // The same guard the profile directories use — this one writes files.
    expect(() => browserShotDir('/data', '../../etc')).toThrow();
  });
});

describe('not filling the disk', () => {
  it('drops the OLDEST beyond the cap', () => {
    const files = ['5.jpg', '1.jpg', '3.jpg', '2.jpg', '4.jpg'];
    expect(shotsToPrune(files, 2)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
  });

  it('keeps everything while under it', () => {
    expect(shotsToPrune(['1.jpg', '2.jpg'], 5)).toEqual([]);
  });

  it('ignores anything that is not a still', () => {
    // A stray file in the directory must not be deleted by a cleanup that only
    // understands its own.
    expect(shotsToPrune(['notes.txt', '1.jpg', '2.jpg'], 1)).toEqual(['1.jpg']);
  });

  it('ignores a name that is not a timestamp', () => {
    expect(shotsToPrune(['old.jpg', '9.jpg'], 0)).toEqual(['9.jpg']);
  });
});

describe('saving one', () => {
  it('writes it, and says it landed', () => {
    const dir = temp();
    expect(saveBrowserShot(dir, 'shopping', 42, Buffer.from([1, 2, 3]))).toBe(true);
    expect(readdirSync(browserShotDir(dir, 'shopping'))).toEqual(['42.jpg']);
  });

  it('refuses an empty image rather than writing a hole', () => {
    // A card pointing at a zero-byte file renders as a broken picture, which is
    // worse than a card with none.
    const dir = temp();
    expect(saveBrowserShot(dir, 'shopping', 42, Buffer.alloc(0))).toBe(false);
  });

  it('says so when it cannot write, instead of throwing', () => {
    // The card is worth more than its illustration: a disk problem must not
    // take the moment with it.
    expect(saveBrowserShot('/proc/nope', 'shopping', 42, Buffer.from([1]))).toBe(false);
  });

  it('prunes as it goes, so a busy browser cannot grow a gallery', () => {
    const dir = temp();
    for (let i = 1; i <= BROWSER_SHOT_CAP + 4; i++) {
      saveBrowserShot(dir, 'shopping', i, Buffer.from([i]));
    }
    const left = readdirSync(browserShotDir(dir, 'shopping'));
    expect(left).toHaveLength(BROWSER_SHOT_CAP);
    expect(left).not.toContain('1.jpg');
    expect(left).toContain(`${BROWSER_SHOT_CAP + 4}.jpg`);
  });
});

describe('forgetting them', () => {
  it('takes the whole directory when a browser is reaped', () => {
    const dir = temp();
    saveBrowserShot(dir, 'shopping', 1, Buffer.from([1]));
    clearBrowserShots(dir, 'shopping');
    expect(() => readdirSync(browserShotDir(dir, 'shopping'))).toThrow();
  });

  it('is fine when there were none', () => {
    expect(() => clearBrowserShots(temp(), 'never-used')).not.toThrow();
  });

  it('leaves other profiles alone', () => {
    const dir = temp();
    saveBrowserShot(dir, 'shopping', 1, Buffer.from([1]));
    saveBrowserShot(dir, 'research', 1, Buffer.from([1]));
    clearBrowserShots(dir, 'shopping');
    expect(readdirSync(browserShotDir(dir, 'research'))).toEqual(['1.jpg']);
  });
});
