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

/**
 * A path that cannot be written to, on any platform, in constant time.
 *
 * A regular FILE with a child path hung off it: `mkdir -p` under it fails
 * ENOTDIR immediately, which is exactly the "the disk said no" case this file
 * needs and nothing more exotic.
 *
 * It used to be `/proc/nope`, and that cost four days of red CI with no test
 * ever named. On macOS there is no /proc, so the call failed instantly and the
 * test was honest. On the Linux runner /proc is a procfs, and procfs answers a
 * create attempt with ENOENT rather than EPERM — which node's recursive mkdir
 * takes as "make the parent and retry", finds the parent already there, and
 * retries forever. Measured in plain node on the runner, no vitest involved:
 * `mkdirSync('/proc/nope')` throws ENOENT in 0ms, the same call with
 * `{ recursive: true }` NEVER RETURNS. Node 22 and 24 both, io_uring on or
 * off. Vitest then waits on a worker that will never report, prints its `RUN`
 * banner and nothing else, and the job dies at the 20-minute ceiling. Two
 * files did this (see KeyboardLog.test.ts) — one in shard 2, one in shard 4,
 * which is exactly the two shards that were red on every run since sharding
 * landed. Do not reach for a system path to mean "unwritable".
 */
function unwritable(): string {
  const d = temp();
  const file = join(d, 'a-file-not-a-directory');
  writeFileSync(file, 'x');
  return join(file, 'nope');
}

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
    expect(saveBrowserShot(unwritable(), 'shopping', 42, Buffer.from([1]))).toBe(false);
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
