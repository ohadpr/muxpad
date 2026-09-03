import { ClipboardAddon } from '@xterm/addon-clipboard';
import type { ClipboardSelectionType, IClipboardProvider } from '@xterm/addon-clipboard';
import { readClipboard, writeClipboard } from './clipboard-write';

/**
 * A clipboard provider for xterm's ClipboardAddon that works in non-secure
 * contexts and never throws back into term.write().
 *
 * Why this exists: navigator.clipboard is undefined in any non-secure context
 * — the app served over http://<hostname> or http://<lan-ip> rather than
 * localhost/https (e.g. Tailscale serve). The stock BrowserClipboardProvider
 * calls navigator.clipboard.writeText() unconditionally; when that's
 * undefined the TypeError is thrown *inside* term.write()'s synchronous OSC
 * 52 handler, aborting the rest of the write and truncating the terminal
 * frame. Claude Code emits OSC 52 frequently, so the visible result is a
 * terminal that only renders a fraction of its output.
 *
 * Delegates to writeClipboard/readClipboard, which fall back to
 * document.execCommand('copy') so OSC 52 clipboard writes actually land even
 * without navigator.clipboard. Reads still degrade to '' (no non-secure read
 * path exists in browsers).
 */
export function createSafeClipboardProvider(): IClipboardProvider {
  return {
    readText: (_selection: ClipboardSelectionType): Promise<string> => readClipboard(),
    writeText: async (_selection: ClipboardSelectionType, text: string): Promise<void> => {
      await writeClipboard(text);
    },
  };
}

/**
 * The published @xterm/addon-clipboard@0.1.0 typings declare the constructor
 * as `constructor(provider?: IClipboardProvider)` — a single argument. The
 * actual compiled constructor is `constructor(base64 = new Base64(), provider
 * = new BrowserClipboardProvider())` — the provider is the SECOND argument.
 *
 * So `new ClipboardAddon(createSafeClipboardProvider())` silently passes our
 * provider as the base64 codec and leaves the crashing BrowserClipboardProvider
 * installed. We cast around the wrong typing and pass the provider in the
 * real second slot. `undefined` for the first arg lets the constructor's
 * default Base64 codec apply.
 */
type ClipboardAddonCtor = new (base64?: unknown, provider?: IClipboardProvider) => ClipboardAddon;

export function createSafeClipboardAddon(): ClipboardAddon {
  const Ctor = ClipboardAddon as unknown as ClipboardAddonCtor;
  return new Ctor(undefined, createSafeClipboardProvider());
}
