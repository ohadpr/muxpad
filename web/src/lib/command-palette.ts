/**
 * Opening the ⌘K palette from somewhere that is not the keyboard.
 *
 * The palette (components/CommandPalette) is mounted once in AppLayout and owns
 * its own `open` state. The rail's "Search chats" button and the sheet's
 * magnifier live several components away from it — and the sheet's panel is a
 * different subtree altogether — so rather than thread a setter through
 * AppLayout → NavTree → SidebarTree/SheetRail, they ask for it the same way the
 * chord does: through `window`. One event, one listener, no new prop on a
 * component that has nothing else to say about the palette.
 */
export const PALETTE_OPEN_EVENT = 'muxpad:palette-open';

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(PALETTE_OPEN_EVENT));
}

/** The chord the palette listens for on this platform — the same test the
 *  palette's key handler makes, so the hint never names a key that does
 *  nothing. */
export function isMacPlatform(): boolean {
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

export function paletteChordLabel(): string {
  return isMacPlatform() ? '⌘K' : 'Ctrl K';
}
