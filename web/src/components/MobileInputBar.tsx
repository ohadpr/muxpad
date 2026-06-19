import { useEffect, useRef } from 'react';
import { api } from '../api';
import { companionTextForImagePaste, splitClipboard } from '../lib/clipboard-detect';
import { planSubmit } from '../lib/mobile-submit';
import { isCursorAgentCmd } from '../lib/xterm-internals';
import './MobileInputBar.css';

/**
 * Always-visible mobile composer for sending input to the active shell
 * pane. The native xterm hidden textarea + soft keyboard is awkward on
 * touch (the bar disappears, focus is finicky, no easy way to send Esc /
 * Tab / arrows), so on small viewports we render a real composer pinned
 * above the keyboard.
 *
 * The bar dispatches a `muxpad:send-input` CustomEvent which XtermPane
 * subscribes to. The event-bus indirection keeps this component from
 * needing a direct ref into the active terminal — it just knows the
 * paneId of the active pane.
 *
 * The composer is a `contenteditable` div, NOT a <textarea>: iOS attaches
 * its keyboard accessory bar (the "< > / Done" form-assistant strip) only
 * to real form controls. A contenteditable element isn't a form field, so
 * the keyboard comes up clean. We force plaintext editing and manage the
 * content imperatively via a ref (React must not own a contenteditable's
 * children or it fights the caret).
 *
 * Behavior:
 *   - 1 line by default; grows up to the CSS max-height as the user types
 *     or pastes; scrolls internally past that. Clears after send.
 *   - The Send button submits the buffer with a trailing CR so a typed
 *     command actually runs. Empty submit sends a bare CR (a blank Enter).
 *   - The special-keys row above the composer sends raw escape sequences
 *     for Esc / Tab / arrows / Ctrl-C — keys an iOS keyboard can't reach.
 *
 * Hidden when the active pane is a URL pane (nothing to send to).
 */
// Gap between sending composed text and the submitting Enter. Keeps the CR
// out of the same PTY read so a paste-detecting TUI (Claude Code) treats it
// as a real keypress, not pasted-newline content. See submit().
const SUBMIT_ENTER_DELAY_MS = 50;

export interface MobileInputBarProps {
  paneId: string | null;
  paneKind: 'shell' | 'url' | null;
  /** Best-effort foreground command — drives ↑/↓/End behavior. */
  foregroundCmd?: string | null | undefined;
}

export function MobileInputBar({ paneId, paneKind, foregroundCmd = null }: MobileInputBarProps) {
  const cursorBufferScroll = isCursorAgentCmd(foregroundCmd);
  const editableRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The bar is ALWAYS rendered (hidden via the `hidden` attribute when the
  // active pane isn't a shell) so the positioning effect below — which runs
  // once per mount — always has a live element to observe. The previous
  // `return null` early-out broke two ways: (a) mount while a URL pane was
  // active → barRef was null when the effect ran, so the bar was never
  // positioned even after switching to a shell pane; (b) shell → URL → shell
  // re-created the DOM node while the effect still observed the old detached
  // one. Hiding via attribute keeps one stable element for the lifetime of
  // the component.
  // Hide only for a *confirmed* URL pane. Using `!== 'url'` (rather than
  // `=== 'shell'`) means a transient null kind — which happens for a frame
  // while a pane.updated / tab refetch is in flight — doesn't flip the bar to
  // `hidden`, blur the contenteditable, and dismiss the soft keyboard "on its
  // own". A shell pane briefly reading as unknown stays visible.
  const visible = !!paneId && paneKind !== 'url';

  // Anchor the bar's bottom edge to the visual viewport bottom (= top
  // of the on-screen keyboard when open). We position by `top`, not by
  // `bottom:0`, because iOS Safari's keyboard-aware handling of
  // bottom:0 fixed elements is inconsistent — sometimes it floats them
  // above the keyboard with a visible gap. Positioning by an
  // explicitly-computed top kills the ambiguity.
  //
  // Also mirrors the bar's height into a CSS variable so the workspace
  // above can leave matching padding-bottom (the bar is position:fixed
  // and doesn't reserve flow space). The variable is set on this tab's
  // own .workspace-root, NOT document.documentElement: WorkspaceLayout
  // keeps one TabView (and thus one MobileInputBar) mounted per tab, and
  // a hidden tab's ResizeObserver firing with offsetHeight 0 used to zero
  // the global variable out from under the visible tab. Scoping the var
  // to the bar's own subtree makes each tab self-consistent — a hidden
  // bar writes 0px to a root nobody can see, and doubles as the "no
  // padding while a URL pane is active" behavior (hidden ⇒ 0px).
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = el.closest<HTMLElement>('.workspace-root');
    // In standalone PWA mode (home-screen install) iOS has no URL bar
    // or form-accessory bar to fight, and its native handling of
    // `position: fixed; bottom: 0` correctly anchors to the visual
    // viewport (= keyboard top) on its own. Our JS-positioning hack is
    // only needed for the in-browser case where iOS chrome would leave
    // a gap. So in standalone: keep CSS bottom:0 and skip the JS.
    const isStandalone =
      // iOS-specific legacy property
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;

    let barHeight = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      barHeight = el.offsetHeight;
      root?.style.setProperty('--mobile-input-bar-height', `${barHeight}px`);
      reposition();
    });
    ro.observe(el);

    let reposition = () => {};
    let cleanup = () => {};
    if (isStandalone) {
      el.style.bottom = '0';
      el.style.top = 'auto';
    } else {
      const vv = window.visualViewport;
      reposition = () => {
        const vH = vv ? vv.height : window.innerHeight;
        const vTop = vv ? vv.offsetTop : 0;
        el.style.top = `${vTop + vH - barHeight}px`;
        el.style.bottom = 'auto';
      };
      vv?.addEventListener('resize', reposition);
      vv?.addEventListener('scroll', reposition);
      // iOS Safari can fire visualViewport 'resize' only at the END of
      // its keyboard animation — run a short rAF loop on focus to track
      // through the slide.
      let trackingFrame: number | null = null;
      const trackUntil = (deadline: number) => {
        reposition();
        if (Date.now() < deadline) {
          trackingFrame = requestAnimationFrame(() => trackUntil(deadline));
        } else {
          trackingFrame = null;
        }
      };
      const onFocusIn = () => {
        if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
        trackUntil(Date.now() + 600);
      };
      const onFocusOut = () => {
        if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
        trackUntil(Date.now() + 600);
      };
      el.addEventListener('focusin', onFocusIn);
      el.addEventListener('focusout', onFocusOut);
      reposition();
      cleanup = () => {
        vv?.removeEventListener('resize', reposition);
        vv?.removeEventListener('scroll', reposition);
        el.removeEventListener('focusin', onFocusIn);
        el.removeEventListener('focusout', onFocusOut);
        if (trackingFrame !== null) cancelAnimationFrame(trackingFrame);
      };
    }
    return () => {
      ro.disconnect();
      cleanup();
      root?.style.removeProperty('--mobile-input-bar-height');
    };
  }, []);

  const send = (data: string) => {
    if (!paneId) return;
    window.dispatchEvent(
      new CustomEvent('muxpad:send-input', {
        detail: { paneId, data },
      }),
    );
  };

  const scrollBuffer = (lines: number) => {
    if (!paneId) return;
    window.dispatchEvent(new CustomEvent('muxpad:scroll-buffer', { detail: { paneId, lines } }));
  };

  const scrollBufferBottom = () => {
    if (!paneId) return;
    window.dispatchEvent(
      new CustomEvent('muxpad:scroll-buffer', { detail: { paneId, toBottom: true } }),
    );
  };

  // Toggle the empty state so the CSS :before placeholder shows/hides.
  // Driven off textContent (not :empty) so a stray <br> the browser may
  // leave behind doesn't keep the placeholder hidden on an empty field.
  const syncEmpty = () => {
    const el = editableRef.current;
    if (el) el.classList.toggle('is-empty', (el.textContent ?? '').length === 0);
  };

  const insertAtCaret = (text: string) => {
    const el = editableRef.current;
    if (!el) return;
    el.focus();
    // This runs after an await (image upload), by which point the prior
    // caret/selection may be gone (blur, context-menu paste). Collapse the
    // selection to the end of the field so the inserted path lands
    // predictably instead of at position 0 / nowhere.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // execCommand('insertText') respects the caret/selection and undo stack
    // in a contenteditable; fall back to append if unavailable.
    if (!document.execCommand('insertText', false, text)) {
      el.textContent = (el.textContent ?? '') + text;
    }
    syncEmpty();
  };

  // Upload image blobs to muxpad's attachments endpoint and splice the returned
  // path(s) in at the caret, with an optional trailing text. Shared by the
  // paste handler and the photo/camera picker so both behave identically.
  const uploadAndInsert = async (items: Array<{ blob: Blob; name: string }>, tail: string) => {
    if (!paneId || items.length === 0) return;
    const paths: string[] = [];
    for (const { blob, name } of items) {
      try {
        const { path } = await api.uploadAttachment(paneId, blob, name);
        paths.push(path);
      } catch {
        // ignore — drop this image; the rest still get a chance
      }
    }
    if (paths.length === 0) return;
    insertAtCaret(`${paths.join(' ')} ${tail}`);
  };

  // Image paste: text fields don't natively accept image clipboard data —
  // intercept paste, upload the blob(s), and splice the returned path(s) in at
  // the caret so the user can add context before sending. Plain-text pastes
  // fall through to the contenteditable's own plaintext-only handling. Mirrors
  // the XtermPane paste handler.
  const onPaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!paneId) return;
    const { imageOnly, imageItems } = splitClipboard(e.clipboardData);
    if (imageItems.length === 0) return; // plain text → contenteditable handles it
    e.preventDefault();
    // Read the text portion now — clipboardData is cleared once this handler
    // returns / awaits.
    const tail = imageOnly ? '' : companionTextForImagePaste(e.clipboardData.getData('text/plain'));
    const items = imageItems
      .map((item) => {
        const blob = item.getAsFile();
        if (!blob) return null;
        const ext = blob.type.split('/')[1] ?? 'png';
        return { blob, name: `pasted.${ext}` };
      })
      .filter((x): x is { blob: File; name: string } => x !== null);
    await uploadAndInsert(items, tail);
  };

  // Photo/camera button → native file picker. `accept="image/*"` with NO
  // `capture` attribute makes iOS show the full sheet (Photo Library / Take
  // Photo / Choose File) and Android offer camera + gallery, so the one button
  // covers both grabbing an existing photo and shooting a new one. Uploads the
  // chosen image(s) through the same path as paste.
  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const items = Array.from(input.files ?? [])
      // The OS already constrained the picker to images via accept="image/*";
      // accept empty-type too — some Android providers and HEIC captures report
      // type "" and would otherwise be silently dropped (photo taken, nothing
      // happens). Reject only files that explicitly declare a non-image type.
      .filter((f) => f.type === '' || f.type.startsWith('image/'))
      .map((f) => ({ blob: f, name: f.name || `image.${f.type.split('/')[1] ?? 'png'}` }));
    // Reset first so picking the SAME file again still fires onChange.
    input.value = '';
    await uploadAndInsert(items, '');
  };

  const submit = () => {
    const el = editableRef.current;
    const current = el?.textContent ?? '';
    // Send the text and the submitting Enter as TWO separate frames (see
    // planSubmit). If they go out together (one PTY read), Claude Code's paste
    // detection sees a multi-char burst ending in CR and treats the whole
    // thing as a paste — so the trailing CR is inserted as a literal newline
    // in the prompt instead of submitting, and the command just sits there. A
    // standalone CR a beat later reads as a real Enter keypress and runs the
    // command. The delay must exceed the TUI's paste-coalescing window (a few
    // ms); 50ms is imperceptible but safely clear of it.
    const { text, enter } = planSubmit(current);
    // Collapse the keyboard after send — the common next act is READING
    // the command's output, which the keyboard covers half of. Tapping
    // the composer brings it straight back. MUST run only after the
    // submitting Enter has been handed to the websocket: blurring
    // earlier kicks off the keyboard-dismiss resize cascade
    // (visualViewport → xterm refit → PTY SIGWINCH), which races the
    // deferred CR and can swallow the submit.
    const collapseKeyboard = () => editableRef.current?.blur();
    if (text !== null) {
      send(text);
      window.setTimeout(() => {
        send(enter);
        collapseKeyboard();
      }, SUBMIT_ENTER_DELAY_MS);
    } else {
      // Empty submit = bare CR (blank Enter at the prompt).
      send(enter);
      collapseKeyboard();
    }
    if (el) {
      el.textContent = '';
      syncEmpty();
    }
  };

  return (
    <div ref={barRef} className="mobile-input-bar" data-pane={paneId} hidden={!visible}>
      <div className="mobile-input-keys" role="toolbar" aria-label="Special keys">
        <button type="button" className="mobile-input-key" onClick={() => send('\x1b')}>
          Esc
        </button>
        <button type="button" className="mobile-input-key" onClick={() => send('\t')}>
          Tab
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() => (cursorBufferScroll ? scrollBuffer(-8) : send('\x1b[A'))}
          aria-label={cursorBufferScroll ? 'Scroll up' : 'Up'}
        >
          ↑
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() => (cursorBufferScroll ? scrollBuffer(8) : send('\x1b[B'))}
          aria-label={cursorBufferScroll ? 'Scroll down' : 'Down'}
        >
          ↓
        </button>
        <button
          type="button"
          className="mobile-input-key"
          onClick={() => (cursorBufferScroll ? scrollBufferBottom() : send('\x1b[6~'.repeat(50)))}
          aria-label="Jump to bottom"
        >
          End
        </button>
        <button
          type="button"
          className="mobile-input-key mobile-input-key-danger"
          onClick={() => send('\x03')}
          aria-label="Ctrl-C interrupt"
        >
          ^C
        </button>
        {/* Pane action, not a keystroke — pushed to the far end and
            accent-tinted to read apart from the key chips. This is the
            only always-available "new pane" affordance on mobile: the
            pane strip (which also carries a "+") only renders once a
            tab has two panes. */}
        <button
          type="button"
          className="mobile-input-key mobile-input-key-pane"
          onClick={() => window.dispatchEvent(new CustomEvent('muxpad:add-pane'))}
          title="New pane"
          aria-label="New pane"
        >
          ⊞
        </button>
      </div>
      <div className="mobile-input-row">
        {/* Photo/camera attach. The hidden input does the work; the button is
            the visible affordance. accept="image/*" + no `capture` → native
            sheet offers both library and camera (see onPickFiles). */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onPickFiles}
        />
        <button
          type="button"
          className="mobile-input-attach"
          onClick={() => fileInputRef.current?.click()}
          title="Add photo"
          aria-label="Add photo or take a picture"
        >
          <SvgCamera />
        </button>
        {/* contenteditable, not <textarea>: keeps iOS's keyboard accessory
            bar off (it only attaches to real form controls). plaintext-only
            forces plain text + a sane paste model. */}
        <div
          ref={editableRef}
          className="mobile-input-editable is-empty"
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="textbox"
          tabIndex={0}
          aria-multiline="true"
          aria-label="Send to pane"
          data-placeholder="Send to pane…"
          onInput={syncEmpty}
          onPaste={onPaste}
        />
        <button type="button" className="mobile-input-send" onClick={submit} aria-label="Send">
          Send
        </button>
      </div>
    </div>
  );
}

/** Simple camera glyph for the photo/attach button. */
function SvgCamera() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M4 8a2 2 0 0 1 2-2h1.2a2 2 0 0 0 1.66-.89l.62-.92A1 1 0 0 1 10.3 4h3.4a1 1 0 0 1 .82.43l.62.92A2 2 0 0 0 16.8 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
