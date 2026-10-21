import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('offers workspace organization without tool switches or instruction overrides', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../scripts/muxpad', import.meta.url)),
    'utf8',
  );
  expect(source).toContain('{new|list|delete}');
  expect(source).not.toContain('cmd_workspace_caps');
  expect(source).not.toContain('cmd_workspace_instructions');
});
