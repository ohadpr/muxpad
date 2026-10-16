// The second file in the server that is browser code: its source is evaluated
// inside the page. DOM types are declared here rather than added to the
// project, so nothing else on the server can start reaching for `document`.
/// <reference lib="dom" />
/**
 * DROP-DOWNS, WHICH THE SCREENCAST CANNOT SHOW.
 *
 * A native `<select>` popup is not page content. It is drawn by the BROWSER,
 * outside the page's own compositing, so `Page.startScreencast` never captures
 * it — tapping a select in the viewer sends a perfectly good click to a
 * perfectly good element and then absolutely nothing appears. From the other
 * end that is indistinguishable from a dead relay, which is how this went
 * unnoticed: every other control paints itself.
 *
 * Nothing on the host side can fix that. A popup that is not in the frame
 * cannot be put into the frame. So the choice is made in the VIEWER instead:
 * the page is asked what the select contains, the viewer draws that list with
 * its own markup, and the answer is applied back to the element. The page sees
 * a value change with the events it would have got from a person; it never
 * learns the list was drawn three hundred miles away.
 *
 * This file is the page half of that: describe the select under a tap, and
 * apply a choice to it. Both are written as self-contained functions with no
 * imports and no closure — see {@link selectAtExpression} — because the thing
 * under test and the thing that ships have to be the same text.
 *
 * CUSTOM DROP-DOWNS NEED NONE OF THIS. A listbox built out of divs (every
 * component library) is page content, paints into the frame, and already works.
 * This is only for the native element.
 */

/** One option, as the viewer needs to draw it. */
export interface SelectOption {
  /** The value to send back. */
  v: string;
  /** What to show. */
  l: string;
  selected: boolean;
  disabled: boolean;
}

/** What the page says is under the tap. */
export interface SelectDescription {
  options: SelectOption[];
  /**
   * A multi-select is a different control: it renders as a LIST BOX inside the
   * page, which the screencast captures perfectly well. Same for `size > 1`.
   * Reported so the host can leave those alone — drawing a sheet over a control
   * that is already visible and already works would be the only thing in the
   * way.
   */
  multiple: boolean;
  /** Rows shown. Anything above 1 is an in-page list box, not a popup. */
  size: number;
  /** For the sheet's title — the field's own label, when it has one. */
  label: string;
}

/**
 * The attribute stamped on the select being chosen for.
 *
 * The alternative is to describe the element by a selector and hope it still
 * matches when the answer comes back — but the tap and the choice are separated
 * by however long a person takes to read a list, and a page that re-renders in
 * between (every React page) invalidates any selector built from its position.
 * A stamp survives a re-render of the surrounding tree and is removed the
 * moment it is used.
 */
export const SELECT_MARK = 'data-muxpad-select';

/** Runs INSIDE the page. No closure, no imports — its own source is shipped. */
export function describeSelectAt(x: number, y: number, mark: string): string {
  // Hit-test descends: elementFromPoint on the document returns the shadow HOST
  // for anything inside a web component, and a select inside one is common
  // enough (every design system) that stopping there would miss it.
  const deepest = (root: unknown, px: number, py: number, depth: number): unknown => {
    const scope = root as { elementFromPoint?: (a: number, b: number) => unknown };
    const hit = scope.elementFromPoint?.(px, py) as {
      shadowRoot?: unknown;
      tagName?: string;
    } | null;
    if (!hit || depth > 6) return hit;
    if (hit.shadowRoot) {
      const deeper = deepest(hit.shadowRoot, px, py, depth + 1);
      // A shadow root that hit-tests to nothing means the point is on the host
      // itself, which is still a real answer.
      if (deeper && deeper !== hit) return deeper;
    }
    return hit;
  };

  const hit = deepest(document, x, y, 0) as {
    closest?: (s: string) => unknown;
    tagName?: string;
  } | null;
  if (!hit) return '';
  // `closest` so a tap on the text inside the select still finds the select.
  const el = (hit.closest?.('select') ?? null) as {
    options?: ArrayLike<unknown>;
    multiple?: boolean;
    size?: number;
    setAttribute?: (k: string, v: string) => void;
    getAttribute?: (k: string) => string | null;
    id?: string;
    name?: string;
    labels?: ArrayLike<{ textContent?: string }>;
    getRootNode?: () => { querySelectorAll?: (s: string) => ArrayLike<unknown> };
  } | null;
  if (!el || !el.options) return '';

  const options: SelectOption[] = [];
  for (let i = 0; i < el.options.length; i++) {
    const o = el.options[i] as {
      value?: string;
      label?: string;
      text?: string;
      textContent?: string;
      selected?: boolean;
      disabled?: boolean;
    };
    const text = (o.label || o.text || o.textContent || '').trim();
    options.push({
      v: typeof o.value === 'string' ? o.value : text,
      // A blank option is a real option — a placeholder row you can go back to
      // — and drawing it as an empty line nobody can aim at loses it.
      l: text || '—',
      selected: Boolean(o.selected),
      disabled: Boolean(o.disabled),
    });
  }

  let label = '';
  try {
    const first = el.labels?.[0];
    label = (first?.textContent || '').trim();
  } catch {
    label = '';
  }
  if (!label) label = (el.name || el.id || '').trim();

  // Stamped last, so a select we could not describe is never marked.
  el.setAttribute?.(mark, '1');
  return JSON.stringify({
    options,
    multiple: Boolean(el.multiple),
    size: Number(el.size) || 0,
    label,
  });
}

/**
 * Puts the chosen value into the select the probe stamped.
 *
 * Fires `input` AND `change`, through the native setter, for the same reason
 * the login fill does: a value assigned without events is a value the site does
 * not believe is there, and on a controlled React select the component simply
 * re-renders its old value back over the top. Measured — the first version set
 * `.value` and the page snapped straight back.
 *
 * The stamp is removed whatever happens, so a page is never left carrying an
 * attribute from a dropdown somebody opened and dismissed.
 */
export function applySelectChoice(value: string, mark: string): boolean {
  const scan = (root: unknown, depth: number): unknown => {
    if (depth > 4) return null;
    const scope = root as {
      querySelector?: (s: string) => unknown;
      querySelectorAll?: (s: string) => Iterable<unknown>;
    };
    try {
      const direct = scope.querySelector?.(`[${mark}]`);
      if (direct) return direct;
    } catch {
      return null;
    }
    let hosts: Iterable<unknown> = [];
    try {
      hosts = scope.querySelectorAll?.('*') ?? [];
    } catch {
      hosts = [];
    }
    for (const node of hosts) {
      const el = node as { shadowRoot?: unknown; tagName?: string; contentDocument?: unknown };
      if (el.shadowRoot) {
        const found = scan(el.shadowRoot, depth + 1);
        if (found) return found;
      } else if ((el.tagName || '').toLowerCase() === 'iframe') {
        try {
          if (el.contentDocument) {
            const found = scan(el.contentDocument, depth + 1);
            if (found) return found;
          }
        } catch {
          // Cross-origin. Nothing reachable in there.
        }
      }
    }
    return null;
  };

  const el = scan(document, 0) as {
    value?: string;
    focus?: () => void;
    removeAttribute?: (k: string) => void;
    dispatchEvent?: (e: unknown) => void;
  } | null;
  if (!el) return false;
  try {
    el.focus?.();
    const proto = Object.getPrototypeOf(el) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    for (const type of ['input', 'change']) {
      el.dispatchEvent?.(new Event(type, { bubbles: true }));
    }
    return true;
  } finally {
    el.removeAttribute?.(mark);
  }
}

/** Clears a stamp nobody chose for — a sheet that was dismissed. */
export function clearSelectMark(mark: string): void {
  const all = document.querySelectorAll(`[${mark}]`);
  for (let i = 0; i < all.length; i++) all[i]?.removeAttribute(mark);
}

/** The expression the host evaluates. Same text as the tested function. */
export function selectAtExpression(x: number, y: number): string {
  return `(${describeSelectAt.toString()})(${Number(x)}, ${Number(y)}, ${JSON.stringify(SELECT_MARK)})`;
}

/** The expression the host evaluates, with the chosen value baked in. */
export function selectChoiceExpression(value: string): string {
  return `(${applySelectChoice.toString()})(${JSON.stringify(value)}, ${JSON.stringify(SELECT_MARK)})`;
}

/** The expression the host evaluates when a sheet is dismissed. */
export function clearSelectMarkExpression(): string {
  return `(${clearSelectMark.toString()})(${JSON.stringify(SELECT_MARK)})`;
}
