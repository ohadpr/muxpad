import { describe, expect, it } from 'vitest';
import { botWallVerdict } from './BotWall.js';

/**
 * A false positive costs 1.3 GB of memory for a page that was fine; a false
 * negative costs a page that stays broken with no explanation. So both
 * directions are pinned.
 */
describe('noticing that a site refused this browser', () => {
  it('reads an unanswered bot check as the clearest signal there is', () => {
    // What was on screen the night this was written: the widget rendered, the
    // owner clicked it, and it said "Verification failed" — because the
    // browser was being judged, not the click.
    expect(botWallVerdict({ unsolvedChallenge: true }).walled).toBe(true);
  });

  it('reads a refusal status as a refusal, and names who said it', () => {
    const v = botWallVerdict({ status: 403, server: 'cloudflare' });
    expect(v.walled).toBe(true);
    expect(v.why).toContain('cloudflare');
    expect(botWallVerdict({ status: 429 }).walled).toBe(true);
  });

  it('believes the prose on a SHORT page', () => {
    // An interstitial is a sentence and a logo.
    for (const t of [
      'Verification failed. Please refresh and try again.',
      'Checking your browser before accessing the site.',
      'Enable JavaScript and cookies to continue',
      'Sorry, you have been blocked',
    ])
      expect(botWallVerdict({ text: t }).walled, t).toBe(true);
  });

  it('does NOT believe the same words inside a long page', () => {
    // An article about Cloudflare blocking people is not a Cloudflare block,
    // and upgrading on it would spend a gigabyte on a news story.
    const article = `${'Cloudflare access denied is a common error. '.repeat(60)}`;
    expect(article.length).toBeGreaterThan(1_200);
    expect(botWallVerdict({ text: article, status: 200 }).walled).toBe(false);
  });

  it('believes prose on a long page when the STATUS also refuses', () => {
    const article = `${'you have been blocked '.repeat(100)}`;
    expect(botWallVerdict({ text: article, status: 403 }).walled).toBe(true);
  });

  it('says nothing about an ordinary page', () => {
    expect(botWallVerdict({ status: 200, text: 'Pay $107.26' }).walled).toBe(false);
    expect(botWallVerdict({}).walled).toBe(false);
    expect(botWallVerdict({ status: 404, text: 'Not found' }).walled).toBe(false);
  });
});
