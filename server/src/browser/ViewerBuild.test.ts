import { describe, expect, it } from 'vitest';
import { VIEWER_BUILD_MARK, stampViewer, viewerBuildId } from './ViewerBuild.js';

describe('stamping the viewer with its own build', () => {
  /**
   * The bug this exists for is not in the page — it is in TESTING the page. A
   * host restarts when its code changes; the tab already open on a phone does
   * not. Its socket reconnects, frames resume, nothing looks stale, and the
   * script running it is the one served before the restart.
   *
   * An evening went into fixes verified in the served HTML and then tested
   * against a tab running the version from before them. The reports back were
   * accurate about code that no longer existed.
   */
  it('gives different pages different ids', () => {
    expect(viewerBuildId('<p>one</p>')).not.toBe(viewerBuildId('<p>two</p>'));
  });

  it('gives the same page the same id, so a match means a match', () => {
    expect(viewerBuildId('<p>one</p>')).toBe(viewerBuildId('<p>one</p>'));
  });

  it('replaces the placeholder with the id', () => {
    const { html, build } = stampViewer(`<script>const B='${VIEWER_BUILD_MARK}'</script>`);
    expect(html).toContain(build);
    expect(html).not.toContain(VIEWER_BUILD_MARK);
  });

  it('hashes BEFORE substituting, so the id is reproducible', () => {
    // Hashing afterwards would hash bytes containing the hash, which nothing
    // reading the result could ever recompute.
    const src = `<script>const B='${VIEWER_BUILD_MARK}'</script>`;
    expect(stampViewer(src).build).toBe(viewerBuildId(src));
  });

  it('replaces every occurrence, not just the first', () => {
    const src = `${VIEWER_BUILD_MARK}|${VIEWER_BUILD_MARK}`;
    expect(stampViewer(src).html).not.toContain(VIEWER_BUILD_MARK);
  });

  it('leaves a page without the placeholder alone', () => {
    expect(stampViewer('<p>no mark</p>').html).toBe('<p>no mark</p>');
  });

  it('is short enough to read in a log line', () => {
    expect(viewerBuildId('x')).toHaveLength(12);
  });
});
