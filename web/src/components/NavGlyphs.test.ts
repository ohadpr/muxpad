import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "copy the ribbon icon design from the desktop app to the mobile app": the
 * ribbon and the phone's bottom bar draw from ONE set (NavGlyphs), so Home,
 * Unread and Activity cannot drift apart again.
 */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('one glyph set, two surfaces', () => {
  it('both the ribbon and the phone bar draw with NavGlyph', () => {
    expect(read('DestinationRail.tsx')).toMatch(/<NavGlyph name=\{d\}/);
    expect(read('MobileNav.tsx')).toMatch(/<NavGlyph name=\{section\}/);
  });

  it('neither keeps drawings of its own any more', () => {
    // The phone's old filled house / envelope / bell, and the ribbon's local
    // copy, are gone — a path here would be a second, drifting drawing.
    const phoneIcon = read('MobileNav.tsx').match(/function SectionIcon[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(phoneIcon).not.toMatch(/<path|<circle|<rect/);
    expect(read('DestinationRail.tsx')).not.toMatch(/<path|<circle|<rect/);
  });

  it('draws Search into the same family — the phone’s fourth tab has no ribbon twin', () => {
    const set = read('NavGlyphs.tsx');
    for (const name of ['home', 'unread', 'activity', 'artifacts', 'apps', 'search'])
      expect(set).toMatch(new RegExp(`\\n  ${name}: `));
    expect(set).toContain('strokeLinecap="round"');
    expect(set).toContain('strokeLinejoin="round"');
  });
});
