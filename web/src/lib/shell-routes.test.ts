import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepsShell } from './shell-routes';

/**
 * Artifacts and Apps are destinations that belong to no WORKSPACE, which is a
 * different claim from belonging to no APP — and AppLayout could only express
 * the first one, so they inherited "no shell at all" and read as having left
 * muxpad. Reported exactly that way.
 */
describe('keepsShell', () => {
  it('keeps the rail for the two destination lists', () => {
    expect(keepsShell('/artifacts')).toBe(true);
    expect(keepsShell('/apps')).toBe(true);
    expect(keepsShell('/activity')).toBe(true);
  });

  it('tolerates a trailing slash', () => {
    expect(keepsShell('/artifacts/')).toBe(true);
    expect(keepsShell('/apps/')).toBe(true);
  });

  it('does NOT claim an app’s own full-screen view', () => {
    // `/hosted/a/:slug` is somebody else's page, and the chrome around it is
    // the thing you came to get away from. A prefix test would have taken it.
    expect(keepsShell('/hosted/a/notes')).toBe(false);
    expect(keepsShell('/hosted')).toBe(false);
  });

  it('does not claim a nested path under either list', () => {
    // A future `/apps/settings` should have to opt in here rather than
    // inherit silently — which is the whole reason this is not a prefix test.
    expect(keepsShell('/apps/settings')).toBe(false);
    expect(keepsShell('/artifacts/report')).toBe(false);
  });

  it('leaves the picker and the chat routes alone', () => {
    // `/` exists to redirect: a rail that flashes up for one frame on the way
    // somewhere else is worse than none. A chat route already has the shell
    // by the workspace branch.
    expect(keepsShell('/')).toBe(false);
    expect(keepsShell('/w/personal/t/investing')).toBe(false);
    expect(keepsShell('/doc')).toBe(false);
  });

  it('is the list AppLayout actually asks', () => {
    // The predicate is worth nothing if the layout stopped calling it. Read
    // out of the source, like the publish-route contract test next door.
    const src = readFileSync(join(__dirname, '../components/AppLayout.tsx'), 'utf8');
    expect(src).toContain('keepsShell(pathname)');
    // …and the shell branch has to consider it, not just compute it.
    expect(src).toMatch(/rendersAppBody\(\{ wsSlug, shellRoute, sidebarMode/);
  });
});
