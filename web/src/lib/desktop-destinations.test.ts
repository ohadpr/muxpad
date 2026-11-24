import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  DESTINATION_LABEL,
  currentDestination,
  destinationAction,
} from './desktop-destinations';

describe('the destination rail', () => {
  it('holds them in his order, each with its word', () => {
    // The five he named, plus Cards — added later, and placed at the head of
    // the three PAGE entries rather than at the end of the strip: the views
    // above are the chat list, and Cards belongs with the things that belong
    // to no workspace. It leads them because it is the one that changes on
    // its own.
    expect(DESTINATIONS.map((d) => DESTINATION_LABEL[d])).toEqual([
      'Home',
      'Unread',
      'Activity',
      'Cards',
      'Artifacts',
      'Apps',
    ]);
  });

  it('standing on /unread marks Unread, not whatever view the list holds', () => {
    // The page and the rail's view are the same list; the rail must agree
    // about which one you are looking at. It said 'home' at first, because
    // currentDestination fell through to the list's view for an unknown path.
    expect(currentDestination('/unread', 'home')).toBe('unread');
    expect(currentDestination('/activity', 'home')).toBe('activity');
  });

  it('Cards is a page, so standing on it is where you are', () => {
    // A page entry wins over the list's view beside it — the same rule
    // Artifacts and Apps follow, and the reason a view entry clicked FROM a
    // page also navigates back to the work.
    expect(currentDestination('/cards', 'home')).toBe('cards');
    expect(destinationAction('cards', '/w/personal/t/main')).toEqual({ to: '/cards' });
    expect(destinationAction('home', '/cards')).toEqual({ view: 'home', to: 'back-to-work' });
  });
});

describe('which entry is current', () => {
  it('on a chat, the list’s view', () => {
    expect(currentDestination('/w/personal/t/main', 'home')).toBe('home');
    expect(currentDestination('/w/personal/t/main', 'unread')).toBe('unread');
    expect(currentDestination('/w/personal/t/main', 'activity')).toBe('activity');
  });

  it('on a page, the page — whatever the list beside it shows', () => {
    expect(currentDestination('/artifacts', 'unread')).toBe('artifacts');
    expect(currentDestination('/apps/', 'home')).toBe('apps');
    expect(currentDestination('/hosted/a/notes', 'home')).toBe('apps');
    expect(currentDestination('/activity', 'home')).toBe('activity');
  });
});

describe('what a click does', () => {
  it('a page entry goes to its route', () => {
    expect(destinationAction('artifacts', '/w/p/t/x')).toEqual({ to: '/artifacts' });
    expect(destinationAction('apps', '/artifacts')).toEqual({ to: '/apps' });
  });

  it('a view entry on a chat switches the list and moves you nowhere', () => {
    expect(destinationAction('unread', '/w/p/t/x')).toEqual({ view: 'unread' });
  });

  it('a view entry on a page switches the list AND takes you back to your work', () => {
    expect(destinationAction('activity', '/apps')).toEqual({
      view: 'activity',
      to: 'back-to-work',
    });
    expect(destinationAction('home', '/artifacts')).toEqual({ view: 'home', to: 'back-to-work' });
  });
});

describe('the chat list beside it', () => {
  const nav = readFileSync(join(__dirname, '../components/NavTree.tsx'), 'utf8');
  it('has no switcher of its own, and no Artifacts/Apps foot on the desktop', () => {
    expect(nav).not.toContain('<RailViewSwitch');
    expect(nav.match(/<HostedFoot/g) ?? []).toHaveLength(1); // the phone's sheet only
  });

  it('sits under ONE header that spans both strips, on the desktop only', () => {
    const layout = readFileSync(join(__dirname, '../components/AppLayout.tsx'), 'utf8');
    const aside = layout.indexOf('<aside className="sidenav sidenav-with-rail">');
    const brand = layout.indexOf('<div className="sidenav-brand">', aside);
    const body = layout.indexOf('<div className="sidenav-body">', brand);
    const rail = layout.indexOf('<DestinationRail', body);
    const list = layout.indexOf('className="sidenav-list"', rail);
    // header, THEN the two strips side by side under it — rail first.
    expect(aside).toBeGreaterThan(-1);
    expect([brand, body, rail, list].every((x, k, a) => x > (a[k - 1] ?? aside))).toBe(true);
    // The dragged width belongs to the chat list's column, not the whole side.
    expect(layout).toMatch(/className="sidenav-list"\s+ref=\{sidenavRef\}/);
  });
});
