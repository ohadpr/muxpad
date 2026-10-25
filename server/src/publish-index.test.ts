import { describe, expect, it } from 'vitest';
import { indexForFiles } from './publish-index.js';

/**
 * THE 404 THAT WASN'T MISSING.
 *
 * `publish` hands back a DIRECTORY url and the public server serves
 * `index.html` or nothing (no listings, by design). So publishing a lone `.md`
 * produced a link that 404'd while the file served fine one segment away — 21
 * of 208 live slugs, and the user reported it twice as "not found" before
 * anybody looked at why.
 */
describe('the generated index', () => {
  it('renders a lone markdown file as the page itself', () => {
    const html = indexForFiles(['proposal.md']);
    expect(html).toContain('<!doctype html>');
    // It fetches its own sibling — allowed from the sandbox's opaque origin
    // because the server sends access-control-allow-origin for exactly this.
    expect(html).toContain('proposal.md');
    expect(html).toMatch(/fetch\(/);
    expect(html).toMatch(/<title>/);
  });

  it('embeds audio rather than linking it', () => {
    // A published recording whose link opens a download has not been published
    // to anybody. This was the reshet-opener-sample report.
    const html = indexForFiles(['sample.mp3', 'spec.png']);
    expect(html).toContain('<audio controls src="sample.mp3">');
    expect(html).toContain('<img src="spec.png"');
  });

  it('lists what it cannot render, and says so', () => {
    const html = indexForFiles(['KIPPAH_base.stl', 'PRINT_SETTINGS.md']);
    expect(html).toContain('KIPPAH_base.stl');
    expect(html).toContain('(download)');
    expect(html).toContain('PRINT_SETTINGS.md');
  });

  it('escapes a filename instead of trusting it', () => {
    // Filenames come off disk, and this page is served from a shared public
    // origin. A `<script>` in a filename must be text, not markup.
    const html = indexForFiles(['<script>alert(1)</script>.md', 'b.txt']);
    expect(html).not.toContain('<script>alert(1)</script>.md');
    expect(html).toContain('&lt;script&gt;');
  });

  it('percent-encodes the href, so a space or a hash still resolves', () => {
    const html = indexForFiles(['my notes #2.txt', 'x.bin']);
    expect(html).toContain('href="my%20notes%20%232.txt"');
  });

  it('titles the page with the slug when there is one', () => {
    expect(indexForFiles(['a.bin', 'b.bin'], 'kippah-v21')).toContain('<h1>kippah-v21</h1>');
  });
});
