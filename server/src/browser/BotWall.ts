/**
 * IS THIS PAGE REFUSING US FOR BEING A ROBOT?
 *
 * muxpad drives `chrome-headless-shell` because it is the browser with no app
 * surface: no bundle, no menu bar, nothing macOS will raise a permission
 * dialog about (findChrome.ts has the whole argument). It is also the most
 * obviously automated thing we could drive — it says `HeadlessChrome` in its
 * user agent and in its client hints — so a site that screens for bots turns
 * it away.
 *
 * The full browser gets further. Measured 2026-11-17: on Chrome for Testing,
 * `navigator.webdriver` is false, the client hints stop naming
 * `HeadlessChrome`, and Cloudflare's own Turnstile demo issues a token with no
 * interaction. It also costs 1,338 MB against 20 MB, and there are a dozen
 * session browsers, so it cannot simply be the default.
 *
 * So the decision moves here: notice the refusal, and upgrade THAT session.
 *
 * ─── WHY THIS IS A DETECTOR AND NOT A GUESS ────────────────────────────────
 *
 * A false positive costs a gigabyte of memory for a page that was fine, so the
 * signals are the ones a wall actually produces, and a long page never
 * matches: these interstitials are small, and an article ABOUT Cloudflare is
 * not a Cloudflare block. A refusal STATUS alone is enough; prose alone is not
 * unless the page is short enough to be nothing but the refusal.
 */

/** What the host can see about the page it just landed on. */
export interface PageEvidence {
  /** Main-document HTTP status, when the host saw it. */
  status?: number | null | undefined;
  /** The page's visible text, bounded by the caller. */
  text?: string | null | undefined;
  /** `Server` response header, lower-cased, when seen. */
  server?: string | null | undefined;
  /** Did a bot-check widget render and never produce a token? */
  unsolvedChallenge?: boolean | undefined;
}

export interface BotWallVerdict {
  walled: boolean;
  /** Short reason, for the log and the chat notice. Empty when not walled. */
  why: string;
}

/** The sentences these interstitials are made of. */
const WALL_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/verification failed/i, 'the bot check refused this browser'],
  [/checking your browser/i, 'a browser check interstitial'],
  [/enable javascript and cookies to continue/i, 'a Cloudflare interstitial'],
  [/you have been blocked/i, 'the site blocked this browser'],
  [/access denied/i, 'access denied'],
  [/unusual traffic from your computer/i, 'flagged as unusual traffic'],
  [/are you a (?:robot|human)/i, 'an are-you-a-robot interstitial'],
];

/** Longer than a wall. A refusal page is a sentence and a logo. */
const WALL_TEXT_MAX = 1_200;

/** Statuses a bot wall answers with. 403 and 429 are the pair that matter;
 *  503 is Cloudflare's "checking" page and only counts with its own prose. */
const REFUSAL_STATUS = new Set([403, 429]);

export function botWallVerdict(page: PageEvidence): BotWallVerdict {
  const text = (page.text ?? '').trim();
  const short = text.length > 0 && text.length <= WALL_TEXT_MAX;
  const byStatus = typeof page.status === 'number' && REFUSAL_STATUS.has(page.status);

  // A widget that rendered and never answered is the clearest signal there is:
  // nothing else produces it, and it is exactly what a person sees as
  // "Verification failed" on a page that otherwise looks fine.
  if (page.unsolvedChallenge) return { walled: true, why: 'a bot check that never completed' };

  for (const [re, why] of WALL_PHRASES) {
    if (!re.test(text)) continue;
    // Prose on a FULL page is a page that talks about blocking, not one doing
    // it. With a refusal status it is the real thing whatever its length.
    if (byStatus || short) return { walled: true, why };
  }

  if (byStatus) {
    const who = (page.server ?? '').toLowerCase();
    const named = /cloudflare|akamai|incapsula|perimeterx|datadome/.exec(who)?.[0];
    return {
      walled: true,
      why: named ? `${named} refused with ${page.status}` : `HTTP ${page.status}`,
    };
  }
  return { walled: false, why: '' };
}

/**
 * How long after a navigation to look.
 *
 * A challenge page paints its text, and sometimes its failure, a moment after
 * the document arrives — reading immediately gets an empty body and calls
 * every site fine. Long enough to see the refusal, short enough that the agent
 * is still on the page when the answer comes back.
 */
export const WALL_CHECK_DELAY_MS = 2_500;

/**
 * Asked in the page: what does this look like?
 *
 * Bounded text, because the verdict only cares whether the page is SHORT and
 * what it says; a megabyte of article would be a megabyte over the wire to
 * prove the same thing. An unanswered bot-check widget is reported separately
 * — it is the signal that needs no prose at all.
 */
export function pageEvidenceExpression(): string {
  return `(() => { try {
    const t = (document.body && document.body.innerText || '').slice(0, 4000);
    const widget = !!document.querySelector('[name="cf-turnstile-response"], [name="g-recaptcha-response"], iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"]');
    const answered = [...document.querySelectorAll('[name="cf-turnstile-response"], [name="g-recaptcha-response"]')].some(e => e.value);
    return { text: t, unsolvedChallenge: widget && !answered && /fail|went wrong|error|verify you are human/i.test(t) };
  } catch { return {}; } })()`;
}
