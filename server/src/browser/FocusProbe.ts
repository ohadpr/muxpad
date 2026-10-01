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

/**
 * Every text field's box, in top-document viewport coordinates.
 *
 * IT DESCENDS, for the same reason the focus probe does — and because the two
 * disagreeing is worse than either being wrong alone. On a page whose input
 * lives in an iframe or a shadow root, the flat version returned NO fields: the
 * viewer then knew of nowhere worth a keyboard, so a tap on the login box raised
 * nothing on its own and waited for the page's answer, which is exactly the
 * round trip the boxes exist to avoid. One half of the pair had been taught
 * about frames and the other had not.
 *
 * Frame rects are OFFSET by the frame's own position, because the viewer
 * hit-tests a tap in the top document's coordinates and an inner rect is
 * relative to the inner document. An unoffset box is a keyboard that appears
 * for taps somewhere else entirely.
 */
export function textFieldBoxes(): Array<[number, number, number, number]> {
  const SKIP = [
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
  const SELECTOR = 'input,textarea,[contenteditable=""],[contenteditable=true]';
  const out: Array<[number, number, number, number]> = [];
  const CAP = 80;

  const collect = (root: unknown, dx: number, dy: number, depth: number): void => {
    if (depth > 4 || out.length >= CAP) return;
    const scope = root as {
      querySelectorAll?: (s: string) => Iterable<unknown>;
    };
    let found: Iterable<unknown> = [];
    try {
      found = scope.querySelectorAll?.(SELECTOR) ?? [];
    } catch {
      return;
    }
    for (const node of found) {
      if (out.length >= CAP) return;
      const el = node as {
        tagName?: string;
        type?: string;
        getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
      };
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' && SKIP.indexOf((el.type || 'text').toLowerCase()) !== -1) continue;
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      out.push([
        Math.round(r.left + dx),
        Math.round(r.top + dy),
        Math.round(r.width),
        Math.round(r.height),
      ]);
    }

    // Shadow roots: the host element is in this scope, its fields are not.
    let hosts: Iterable<unknown> = [];
    try {
      hosts = scope.querySelectorAll?.('*') ?? [];
    } catch {
      hosts = [];
    }
    for (const node of hosts) {
      if (out.length >= CAP) return;
      const el = node as {
        tagName?: string;
        shadowRoot?: unknown;
        contentDocument?: unknown;
        getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
      };
      if (el.shadowRoot) collect(el.shadowRoot, dx, dy, depth + 1);
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'iframe' || tag === 'frame') {
        let doc: unknown = null;
        // Cross-origin THROWS in some engines and returns NULL in others —
        // Chrome hands back null for a sandboxed frame, which is how the first
        // version of this fix missed the very case it was written for. Both
        // mean the same thing: we cannot look inside.
        try {
          doc = el.contentDocument ?? null;
        } catch {
          doc = null;
        }
        const box = el.getBoundingClientRect?.();
        if (doc && box) {
          collect(doc, dx + box.left, dy + box.top, depth + 1);
        } else {
          // CANNOT LOOK IN, SO ASSUME THE WORST USEFUL THING. A cross-origin
          // frame is an SSO widget, a payment field, a third-party login — and
          // nothing in this page, or in the focus probe beside it, can see
          // whether it holds an input. Reporting nothing meant a tap on such a
          // login box raised no keyboard AT ALL, which is a dead end rather than
          // a blemish.
          //
          // So the FRAME becomes the candidate. A tap inside it raises a
          // keyboard the person can dismiss with one press; the alternative is a
          // field they cannot type into. The same rule makes a tap on a
          // cross-origin ad raise one too, which is the price and the right way
          // round.
          if (box && box.width > 0 && box.height > 0) {
            out.push([
              Math.round(box.left + dx),
              Math.round(box.top + dy),
              Math.round(box.width),
              Math.round(box.height),
            ]);
          }
        }
      }
    }
  };

  collect(document, 0, 0, 0);
  return out;
}

/** The expression the host evaluates. Same text as the tested function. */
export function fieldBoxesExpression(): string {
  return `(${textFieldBoxes.toString()})()`;
}

/**
 * Whether the page is asking somebody to sign in, and where.
 *
 * WHY THE VIEWER NEEDS TO KNOW. A password manager fills forms in the page it is
 * looking at — and the page it is looking at is muxpad, not the site. 1Password
 * sees `dt-mac-mini.ts.net/browser/s-01m…`, has no entry for it, and offers
 * nothing; the site's real form is a JPEG. So the viewer puts up a REAL form of
 * its own, which a password manager can see and fill from a manually chosen
 * entry, and the values are then typed into the page over CDP.
 *
 * For that to work the viewer has to know a sign-in is on screen at all, and
 * which fields to fill afterwards. This reports both: descending through frames
 * and shadow roots exactly as the other two probes do, because a login form is
 * more often inside one of those than not.
 */
export interface LoginFormReport {
  /** A password field is on the page. */
  present: boolean;
  /** Whether a username-ish field was found next to it. */
  username: boolean;
  /** The page's own idea of who it is, for the panel to name. */
  host: string;
}

export function findLoginForm(): LoginFormReport {
  const USERNAME = ['text', 'email', 'tel'];
  const scan = (root: unknown, depth: number): { pw: unknown; user: unknown } => {
    const out: { pw: unknown; user: unknown } = { pw: null, user: null };
    if (depth > 4) return out;
    const scope = root as { querySelectorAll?: (s: string) => Iterable<unknown> };
    let all: Iterable<unknown> = [];
    try {
      all = scope.querySelectorAll?.('input') ?? [];
    } catch {
      return out;
    }
    for (const node of all) {
      const el = node as {
        type?: string;
        getBoundingClientRect?: () => { width: number; height: number };
      };
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const type = (el.type || 'text').toLowerCase();
      if (type === 'password' && !out.pw) out.pw = el;
      // The username is the last text-ish field BEFORE the password, which is
      // how every sign-in form on the web is laid out.
      else if (USERNAME.indexOf(type) !== -1 && !out.pw) out.user = el;
    }
    if (out.pw) return out;

    let hosts: Iterable<unknown> = [];
    try {
      hosts = scope.querySelectorAll?.('*') ?? [];
    } catch {
      hosts = [];
    }
    for (const node of hosts) {
      const el = node as { tagName?: string; shadowRoot?: unknown; contentDocument?: unknown };
      const deeper = el.shadowRoot
        ? scan(el.shadowRoot, depth + 1)
        : (el.tagName || '').toLowerCase() === 'iframe'
          ? (() => {
              try {
                return el.contentDocument ? scan(el.contentDocument, depth + 1) : out;
              } catch {
                return out;
              }
            })()
          : out;
      if (deeper.pw) return deeper;
    }
    return out;
  };

  const found = scan(document, 0);
  return {
    present: Boolean(found.pw),
    username: Boolean(found.user),
    host: location.hostname || '',
  };
}

/** The expression the host evaluates. Same text as the tested function. */
export function loginFormExpression(): string {
  return `(${findLoginForm.toString()})()`;
}

/**
 * Puts a username and password into the page's own sign-in form.
 *
 * Runs in the page, after a password manager has filled the viewer's stand-in
 * form. Sets the value AND fires `input`/`change`, because every modern login
 * form is a controlled component: a value assigned without events is a box with
 * text in it that the site does not believe is there, and the submit button
 * stays disabled.
 *
 * It does NOT submit. Pressing the button is the person's decision, and a form
 * that submits itself the instant it is filled takes away the moment where you
 * notice it filled the wrong thing.
 */
export function fillLoginForm(username: string, password: string): boolean {
  const USERNAME = ['text', 'email', 'tel'];
  const put = (el: unknown, value: string) => {
    const input = el as {
      value?: string;
      dispatchEvent?: (e: unknown) => void;
      focus?: () => void;
    };
    input.focus?.();
    // The native setter, so React's own value tracker does not swallow it.
    const proto = Object.getPrototypeOf(input) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(input, value);
    else input.value = value;
    for (const type of ['input', 'change']) {
      input.dispatchEvent?.(new Event(type, { bubbles: true }));
    }
  };

  const scan = (root: unknown, depth: number): { pw: unknown; user: unknown } => {
    const out: { pw: unknown; user: unknown } = { pw: null, user: null };
    if (depth > 4) return out;
    const scope = root as { querySelectorAll?: (s: string) => Iterable<unknown> };
    let all: Iterable<unknown> = [];
    try {
      all = scope.querySelectorAll?.('input') ?? [];
    } catch {
      return out;
    }
    for (const node of all) {
      const el = node as {
        type?: string;
        getBoundingClientRect?: () => { width: number; height: number };
      };
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const type = (el.type || 'text').toLowerCase();
      if (type === 'password' && !out.pw) out.pw = el;
      else if (USERNAME.indexOf(type) !== -1 && !out.pw) out.user = el;
    }
    if (out.pw) return out;
    let hosts: Iterable<unknown> = [];
    try {
      hosts = scope.querySelectorAll?.('*') ?? [];
    } catch {
      hosts = [];
    }
    for (const node of hosts) {
      const el = node as { tagName?: string; shadowRoot?: unknown; contentDocument?: unknown };
      let deeper = out;
      if (el.shadowRoot) deeper = scan(el.shadowRoot, depth + 1);
      else if ((el.tagName || '').toLowerCase() === 'iframe') {
        try {
          if (el.contentDocument) deeper = scan(el.contentDocument, depth + 1);
        } catch {
          // Cross-origin. Nothing to fill in there from here.
        }
      }
      if (deeper.pw) return deeper;
    }
    return out;
  };

  const found = scan(document, 0);
  if (!found.pw) return false;
  if (found.user && username) put(found.user, username);
  if (password) put(found.pw, password);
  return true;
}

/** The expression the host evaluates, with the values baked in. */
export function fillLoginExpression(username: string, password: string): string {
  return `(${fillLoginForm.toString()})(${JSON.stringify(username)}, ${JSON.stringify(password)})`;
}
