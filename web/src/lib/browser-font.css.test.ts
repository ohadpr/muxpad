import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
it('keeps the root at the browser default without applying the body scale twice', () => {
  const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  expect(css).toMatch(/html\s*\{\s*font-size:\s*100%;\s*\}/);
  const reset = css.match(/html,\s*body,\s*#root\s*\{([^}]+)\}/)?.[1];
  expect(reset).toBeDefined();
  expect(reset).not.toMatch(/font-size:/);
});
it('allows mobile zoom rather than imposing a viewport maximum', () => {
  const html = readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8');
  expect(html).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=/);
});
