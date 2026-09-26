import { beforeEach, describe, expect, it } from 'vitest';
import { documentBuildId } from './build-id';

/**
 * Reading the build id off the live document. The parser itself is tested in
 * shared/src/build-id.test.ts; what is specific here is WHICH tag gets read.
 */
const scripts = (...srcs: Array<[src: string, type?: string]>) => {
  document.head.innerHTML = '';
  for (const [src, type] of srcs) {
    const s = document.createElement('script');
    if (type) s.setAttribute('type', type);
    s.setAttribute('src', src);
    document.head.appendChild(s);
  }
};

beforeEach(() => {
  document.head.innerHTML = '';
});

describe('documentBuildId', () => {
  it('reads the entry chunk out of the built shell', () => {
    scripts(['/assets/index-Cgp7p3nE.js', 'module']);
    expect(documentBuildId()).toBe('index-Cgp7p3nE.js');
  });

  it('ignores scripts that are not the bundle entry', () => {
    scripts(['/sw.js'], ['/assets/index-Cgp7p3nE.js', 'module']);
    expect(documentBuildId()).toBe('index-Cgp7p3nE.js');
  });

  it('is null on the dev server, whose shell names a source file', () => {
    scripts(['/src/main.tsx', 'module']);
    expect(documentBuildId()).toBeNull();
  });

  it('is null when there is no script with a src at all', () => {
    expect(documentBuildId()).toBeNull();
  });

  it('reads the same id when the src is written absolute', () => {
    // A shell served through a proxy that rewrote the URL — the id is the
    // filename either way, so the comparison against the server still holds.
    scripts(['http://muxpad.local:7777/assets/index-Cgp7p3nE.js', 'module']);
    expect(documentBuildId()).toBe('index-Cgp7p3nE.js');
  });
});
