import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESTINATIONS, destinationAction } from '../lib/desktop-destinations';

/**
 * A PLACE IS A LINK; A VIEW IS A BUTTON.
 *
 * Cards, Artifacts and Apps are routes, and they shipped as <button>s with an
 * onClick: no "open in new tab" on right-click, no cmd-click, no target in the
 * status bar, dead middle-click. "card icon rail elements don't offer right
 * click open menu maybe they are not <a> links annoying."
 *
 * Home, Unread and Activity stay buttons deliberately — they switch which view
 * the chat list is showing and the URL does not change, so an href would offer
 * a new tab onto the page you are already on.
 */
const src = readFileSync(join(__dirname, 'DestinationRail.tsx'), 'utf8');

describe('the rail’s entries', () => {
  it('renders a Link when the entry is a route', () => {
    expect(src).toMatch(/<Link\s+key=\{d\}\s+to=\{route\}/);
    expect(src).toMatch(/import \{[^}]*\bLink\b[^}]*\} from '@tanstack\/react-router'/);
  });

  it('decides which entries are places from destinationAction, not a second list', () => {
    // A hand-written list here would be a second source of truth for "is this
    // a page", and the first thing to drift when a destination is added.
    const fn = /const pageRoute[\s\S]*?\n {2}\};/.exec(src)?.[0] ?? '';
    expect(fn).toContain('destinationAction(dest, pathname).to');
  });

  it('never turns back-to-work into an href', () => {
    // It is a view's return trip to the chat you came from, not a destination.
    const fn = /const pageRoute[\s\S]*?\n {2}\};/.exec(src)?.[0] ?? '';
    expect(fn).not.toContain('back-to-work');
  });

  it('agrees with destinationAction about exactly which three are pages', () => {
    const pages = DESTINATIONS.filter((d) => {
      const to = destinationAction(d, '/w/personal/t/main').to;
      return to === '/cards' || to === '/artifacts' || to === '/apps';
    });
    expect(pages).toEqual(['cards', 'artifacts', 'apps']);
  });

  it('a view entry is still a button, with the click that switches the view', () => {
    expect(src).toMatch(/<button key=\{d\} type="button"[\s\S]{0,120}onClick=\{\(\) => go\(d\)\}/);
  });

  it('both shapes carry the same attributes, from one object', () => {
    // The marking, the label and the title must not depend on which element
    // an entry happened to render as.
    expect(src).toMatch(/const shared = \{/);
    expect(src).toMatch(/<Link key=\{d\} to=\{route\} \{\.\.\.shared\}/);
    expect(src).toMatch(/<button key=\{d\} type="button" \{\.\.\.shared\}/);
  });
});
