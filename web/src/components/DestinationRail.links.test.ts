import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  destinationAction,
  destinationHref,
  navigatesOnClick,
} from '../lib/desktop-destinations';

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
    expect(src).toMatch(/<Link\s+key=\{d\}\s+to=\{href\}/);
    expect(src).toMatch(/import \{[^}]*\bLink\b[^}]*\} from '@tanstack\/react-router'/);
  });

  it('decides which entries NAVIGATE from one predicate, not a second list', () => {
    // A hand-written list here would be a second source of truth for "is this
    // a page", and the first thing to drift when a destination is added.
    expect(src).toContain('navigatesOnClick(d)');
  });

  it('keeps no dead route helper beside the live one', () => {
    // There WAS one. `pageRoute` survived the move to destinationHref /
    // navigatesOnClick, unreachable, and two tests here asserted on its
    // SOURCE TEXT — so they passed while the function was dead and would
    // have survived the whole feature being deleted. Found by review, not by
    // the suite, which is exactly the weakness of asserting on source.
    expect(src).not.toContain('pageRoute');
  });

  it('agrees with destinationAction about exactly which three are pages', () => {
    const pages = DESTINATIONS.filter((d) => {
      const to = destinationAction(d, '/w/personal/t/main').to;
      return to === '/cards' || to === '/artifacts' || to === '/apps';
    });
    expect(pages).toEqual(['cards', 'artifacts', 'apps']);
  });

  it('EVERY entry has an href, including the three that switch a view', () => {
    // The first pass made only the page entries anchors, on the reasoning
    // that a view switch is not a navigation. Right about the click, wrong
    // about the element: "icon rail still not using <a>." A button cannot be
    // right-clicked into a new tab and no handler can add that.
    for (const d of DESTINATIONS) expect(destinationHref(d, 'personal'), d).toBeTruthy();
    expect(destinationHref('unread', 'personal')).toBe('/unread');
    expect(destinationHref('activity', 'personal')).toBe('/activity');
    expect(destinationHref('home', 'personal')).toBe('/w/personal');
  });

  it('Home has no href before any workspace has been visited', () => {
    // A link to nothing is worse than a button.
    expect(destinationHref('home', '')).toBeNull();
  });

  it('a plain click on a VIEW entry does not navigate', () => {
    expect(navigatesOnClick('unread')).toBe(false);
    expect(navigatesOnClick('activity')).toBe(false);
    expect(navigatesOnClick('home')).toBe(false);
    expect(navigatesOnClick('cards')).toBe(true);
  });

  it('leaves a MODIFIED click to the browser', () => {
    // This is the whole reason the href was added. Intercepting cmd-click
    // would re-break what the element was changed to fix.
    const handler =
      /onClick=\{\(e: React\.MouseEvent\) => \{[\s\S]*?\n {12}\}\}/.exec(src)?.[0] ?? '';
    expect(handler).toContain('navigatesOnClick');
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey', 'button'])
      expect(handler, key).toContain(key);
    expect(handler).toContain('preventDefault');
  });

  it('both shapes carry the same attributes, from one object', () => {
    // The marking, the label and the title must not depend on whether an
    // entry happened to render as a link or (Home, pre-workspace) a button.
    expect(src).toMatch(/const shared = \{/);
    expect(src).toMatch(/<Link\s+key=\{d\}\s+to=\{href\}\s+\{\.\.\.shared\}/);
    expect(src).toMatch(/<button key=\{d\} type="button" \{\.\.\.shared\}/);
  });
});
