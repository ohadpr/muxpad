/**
 * The page as it is when a person hands the browser back — read for the agent.
 *
 * The re-check after a handoff used to be a sentence in the instructions: "the
 * url and the DOM both changed, look before you act". A sentence is a request,
 * and the failure it asks the agent to avoid is exactly the one a resumed agent
 * walks into — acting on the snapshot it took before somebody else had the
 * page. So the handback reads the page ITSELF and the message that wakes the
 * agent carries it: the url, the title, and what is on screen.
 *
 * NEVER A VALUE. A person has just been typing on this page, and what they typed
 * is very often a card number, a password or a one-time code. A field is
 * reported by its LABEL and whether it is filled — which is all the agent needs
 * to know whether the step is done — and its contents never leave the page.
 *
 * Written as an expression string for Runtime.evaluate, like
 * typedInputExpression in MobileEmulation.ts, and for the same reason: the
 * decisions in it are testable against a hand-built document without a browser.
 */

/** Lines, not characters: an outline is read by a model, a line at a time. */
export const OUTLINE_MAX_LINES = 30;
/** One line of an outline is a label, not a paragraph. */
export const OUTLINE_MAX_CHARS = 80;

/**
 * Returns `{ url, title, outline }`. Never throws: a page that cannot be read
 * answers with an empty outline, and the message says the page was not read
 * rather than pretending it was empty.
 */
export function pageOutlineExpression(): string {
  return `(() => {
    const MAX = ${OUTLINE_MAX_LINES}, CHARS = ${OUTLINE_MAX_CHARS};
    const clip = (s) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > CHARS ? s.slice(0, CHARS - 1) + '…' : s; };
    const out = [];
    let url = '', title = '';
    try { url = String(location.href); } catch {}
    try { title = clip(document.title); } catch {}
    try {
      const shown = (el) => { try { return el.getClientRects().length > 0; } catch { return true; } };
      const labelOf = (el) => {
        const aria = el.getAttribute && el.getAttribute('aria-label');
        if (aria) return aria;
        try { if (el.labels && el.labels.length) return el.labels[0].textContent; } catch {}
        return el.placeholder || el.name || el.id || '';
      };
      const els = document.querySelectorAll('h1, h2, h3, button, [role=button], a[href], input, select, textarea, iframe');
      for (const el of els) {
        if (out.length >= MAX) { out.push('…'); break; }
        if (!shown(el)) continue;
        const tag = String(el.tagName || '').toLowerCase();
        const type = String(el.type || '').toLowerCase();
        const off = el.disabled ? ' (disabled)' : '';
        if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
          const t = clip(el.textContent); if (t) out.push('heading: ' + t);
        } else if (tag === 'iframe') {
          let host = ''; try { host = new URL(el.src).host; } catch {}
          if (host) out.push('frame: ' + host);
        } else if (tag === 'a') {
          const t = clip(el.textContent || labelOf(el)); if (t) out.push('link: ' + t);
        } else if (tag === 'button' || (el.getAttribute && el.getAttribute('role') === 'button') || type === 'submit' || type === 'button') {
          const t = clip(el.textContent || el.value || labelOf(el)); if (t) out.push('button: ' + t + off);
        } else if (type === 'hidden') {
          continue;
        } else if (type === 'checkbox' || type === 'radio') {
          out.push(type + ' "' + clip(labelOf(el)) + '": ' + (el.checked ? 'checked' : 'unchecked') + off);
        } else {
          // The VALUE is read only to say whether there is one. It is never copied.
          const filled = tag === 'select' ? el.selectedIndex > 0 : String(el.value || '') !== '';
          out.push('field "' + clip(labelOf(el)) + '": ' + (filled ? 'filled' : 'empty') + off);
        }
      }
    } catch {}
    return { url, title, outline: out };
  })()`;
}
