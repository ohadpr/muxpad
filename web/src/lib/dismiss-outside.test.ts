import { beforeEach, describe, expect, it } from 'vitest';
import { isOutsideDismiss } from './dismiss-outside';

describe('clicking away closes the panel — except when it should not', () => {
  let panel: HTMLElement;
  let toggle: HTMLElement;
  let elsewhere: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    panel = document.createElement('aside');
    panel.innerHTML = '<button id="inside">row</button>';
    toggle = document.createElement('button');
    elsewhere = document.createElement('div');
    elsewhere.innerHTML = '<p id="log">the conversation</p>';
    document.body.append(panel, toggle, elsewhere);
  });

  const ask = (target: EventTarget | null) => isOutsideDismiss({ target, panel, toggle });

  it('closes on a click in the page behind it', () => {
    expect(ask(document.getElementById('log'))).toBe(true);
  });

  it('does not close on a click inside the panel', () => {
    expect(ask(document.getElementById('inside'))).toBe(false);
    expect(ask(panel)).toBe(false);
  });

  it('does not close on the toggle — or the panel would reopen itself', () => {
    // The button has its own handler. Treating this as "outside" closes the
    // panel and then the toggle reopens it, so it looks like nothing happens.
    expect(ask(toggle)).toBe(false);
  });

  it('does not close for a modal above it', () => {
    // A <dialog> is not in the panel's subtree, so an approval prompt opened
    // from a sub-chat would otherwise dismiss the panel behind it.
    const dlg = document.createElement('dialog');
    dlg.innerHTML = '<button id="approve">Approve</button>';
    document.body.append(dlg);
    expect(ask(document.getElementById('approve'))).toBe(false);
    const aria = document.createElement('div');
    aria.setAttribute('role', 'dialog');
    aria.innerHTML = '<button id="x">x</button>';
    document.body.append(aria);
    expect(ask(document.getElementById('x'))).toBe(false);
  });

  it('ignores a click whose target has already left the page', () => {
    // A pointerdown on a row that re-renders arrives detached, and `contains`
    // then says "outside" about a node that was inside.
    const gone = document.createElement('button');
    panel.append(gone);
    gone.remove();
    expect(ask(gone)).toBe(false);
  });

  it('ignores a non-element target, and a panel that is not mounted', () => {
    expect(ask(null)).toBe(false);
    expect(ask(document)).toBe(false);
    expect(isOutsideDismiss({ target: elsewhere, panel: null })).toBe(false);
  });

  it('closes even with no toggle given', () => {
    expect(isOutsideDismiss({ target: elsewhere, panel })).toBe(true);
  });
});
