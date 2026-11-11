/**
 * SHOULD THIS CLICK CLOSE THE PANEL?
 *
 * A panel that covers part of the screen and can only be dismissed by its own
 * × is a panel people leave open. Clicking away is what everyone tries first.
 *
 * Pure, and separate from the component, because the interesting part is not
 * "add a listener" — it is the three things that look outside and are not:
 *
 *   · THE TOGGLE ITSELF. The button that opened the panel has its own
 *     handler. Treating its click as "outside" closes the panel and then the
 *     button reopens it, so the panel appears not to respond at all — the
 *     classic version of this bug.
 *   · A MODAL ABOVE IT. A <dialog> is not inside the panel's subtree, so an
 *     approval prompt opened from a sub-chat would dismiss the panel behind
 *     it the moment you touched the prompt.
 *   · A CLICK ON SOMETHING ALREADY GONE. A pointerdown on a row that
 *     re-renders can arrive with a target no longer in the document, and
 *     `contains` then says "outside" about a node that was inside. Anything
 *     detached is ignored rather than guessed about.
 */
export interface OutsideOpts {
  /** The control that opens and closes the panel; its own click wins. */
  toggle?: Element | null;
  /** Where the click landed. */
  target: EventTarget | null;
  /** The panel's own root. */
  panel: Element | null;
  /** The document the click happened in; injected so this is testable. */
  root?: Document | null;
}

export function isOutsideDismiss({ target, panel, toggle, root }: OutsideOpts): boolean {
  if (!panel) return false;
  if (!(target instanceof Element)) return false;
  const doc = root ?? panel.ownerDocument;
  // Detached: the node is not in the page any more, so this click says
  // nothing about where the pointer was relative to the panel.
  if (doc && !doc.contains(target)) return false;
  if (panel.contains(target)) return false;
  if (toggle?.contains(target)) return false;
  if (target.closest('dialog, [role="dialog"], [role="alertdialog"]')) return false;
  return true;
}
