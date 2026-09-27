// The one file in the server that is browser code: its source is evaluated
// inside the page. DOM types are declared here rather than added to the
// project, so nothing else on the server can start reaching for `document`.
/// <reference lib="dom" />
/**
 * Whether the page has a text field focused — asked in a way that survives the
 * two places real sign-in forms put their inputs.
 *
 * THE BUG THIS IS. `document.activeElement` on the top document reports the
 * IFRAME when the focus is inside a frame, and the HOST element when it is
 * inside a shadow root. Both answer "not an input", so the host reported "not
 * editable" and the viewer took the phone keyboard away again a third of a
 * second after the tap raised it — which is exactly what "it comes up and
 * immediately disappears" is. Measured on the real browser, all three shapes:
 *
 *     plain input   → activeElement = input   → editable ✓
 *     in an iframe  → activeElement = iframe  → editable ✗   (wrong)
 *     in a shadow   → activeElement = div     → editable ✗   (wrong)
 *
 * So it descends. The SOURCE of the function below is what gets evaluated in
 * the page — see {@link focusProbeExpression} — which is why it is written as a
 * self-contained function with no imports and no closure: the thing under test
 * and the thing that ships are the same text.
 *
 * It still cannot see into a CROSS-ORIGIN frame, and nothing can. That is why
 * the viewer does not treat this as the last word: a tap it has already matched
 * against a known field box wins over a "no" from here.
 */

/** Runs INSIDE the page. No closure, no imports — its own source is shipped. */
export function deepEditableFocus(): boolean {
  const NOT_TEXT = [
    'button',
    'submit',
    'reset',
    'checkbox',
    'radio',
    'file',
    'range',
    'color',
    'image',
    'hidden',
  ];
  const editable = (el: unknown): boolean => {
    const a = el as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
    if (!a) return false;
    const tag = (a.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (a.isContentEditable) return true;
    if (tag !== 'input') return false;
    return NOT_TEXT.indexOf((a.type || 'text').toLowerCase()) === -1;
  };

  let node = document.activeElement as unknown as {
    tagName?: string;
    shadowRoot?: { activeElement?: unknown } | null;
    contentDocument?: { activeElement?: unknown } | null;
  } | null;

  // Bounded: a cycle here would hang the page we are trying to describe.
  for (let depth = 0; depth < 12 && node; depth++) {
    const inShadow = node.shadowRoot?.activeElement;
    if (inShadow) {
      node = inShadow as typeof node;
      continue;
    }
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'iframe' || tag === 'frame') {
      try {
        const inFrame = node.contentDocument?.activeElement;
        if (inFrame) {
          node = inFrame as typeof node;
          continue;
        }
      } catch {
        // Cross-origin. Unknowable from here, by the design of the web.
      }
    }
    break;
  }
  return editable(node);
}

/** The expression the host evaluates in the page. Same text as the tested function. */
export function focusProbeExpression(): string {
  return `(${deepEditableFocus.toString()})()`;
}
