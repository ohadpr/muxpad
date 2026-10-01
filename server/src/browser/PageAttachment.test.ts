import { describe, expect, it } from 'vitest';
import { type TargetInfo, isBrowsingUrl, targetToAttach } from './PageAttachment.js';

const page = (id: string, url = 'https://example.com'): TargetInfo => ({
  targetId: id,
  type: 'page',
  url,
});

describe('noticing the page was swapped underneath us', () => {
  it('keeps the session when its target is still there', () => {
    // Re-attaching needlessly drops the screencast and every enabled domain for
    // a blink — on a page somebody is typing into, worse than the problem.
    expect(targetToAttach('a', [page('a'), page('b')])).toBeNull();
  });

  it('moves to the live page when ours has gone', () => {
    // The fault caught in the wild: the host held a session for a target that
    // no longer existed, so input went nowhere and the screencast refused with
    // "Not attached to an active page" — a viewer black for good, while
    // /healthz reported 200 because it probes the browser, not the page.
    expect(targetToAttach('gone', [page('b')])?.targetId).toBe('b');
  });

  it('attaches from nothing at startup', () => {
    expect(targetToAttach(null, [page('a')])?.targetId).toBe('a');
  });

  it('never streams the debugger', () => {
    const devtools: TargetInfo = {
      targetId: 'd',
      type: 'page',
      url: 'devtools://devtools/bundled/x.html',
    };
    expect(targetToAttach(null, [devtools, page('a')])?.targetId).toBe('a');
    expect(targetToAttach('gone', [devtools])).toBeNull();
  });

  it('waits rather than tearing down when there is no page at all', () => {
    // The instant between one page closing and the next opening. Throwing here
    // turns a blink into a fault.
    expect(targetToAttach('gone', [])).toBeNull();
    expect(targetToAttach(null, [{ targetId: 'w', type: 'worker', url: '' }])).toBeNull();
  });
});

describe('what counts as having used the browser', () => {
  it('a real page does', () => {
    expect(isBrowsingUrl('https://amazon.com/')).toBe(true);
    expect(isBrowsingUrl('http://127.0.0.1:3000/')).toBe(true);
    expect(isBrowsingUrl('file:///Users/x/page.html')).toBe(true);
  });

  it('the browser talking to itself does not', () => {
    // This is the whole bug: a browser provisioned at session start sits on its
    // start page, and announcing THAT put the card above the prompt that
    // caused it.
    expect(isBrowsingUrl('chrome://newtab/')).toBe(false);
    expect(isBrowsingUrl('about:blank')).toBe(false);
    expect(isBrowsingUrl('devtools://devtools/bundled/x.html')).toBe(false);
  });

  it('nor does a page a harness built rather than one anybody visited', () => {
    expect(isBrowsingUrl('data:text/html,<input>')).toBe(false);
  });

  it('nor nothing at all', () => {
    expect(isBrowsingUrl(null)).toBe(false);
    expect(isBrowsingUrl('')).toBe(false);
    expect(isBrowsingUrl('   ')).toBe(false);
  });
});
