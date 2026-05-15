# Xterm smoke checklist

Run after every commit on the `xterm-hardening` branch. Each section names the symptom it covers.

## A. Scroll-residue under Claude Code (symptom 1)
1. `pnpm --parallel dev` (web on :5173, server on :7777) and open <http://localhost:5173>.
2. Open a workspace, open a tab, start a pane. Run `claude` (or any Ink-based TUI that repaints heavily).
3. Ask Claude something that streams a long answer.
4. While text is streaming, mouse-wheel scroll up and down rapidly.
5. **Pass criteria:** no stuck/leftover glyphs remain visible after scrolling settles. The viewport is clean.

## B. Overlay scrollbar — tracks state AND is draggable (symptom 2)
1. In a shell pane run `seq 1 3000` to build real scrollback.
2. **Pass criteria (tracking):** the thumb on the right appears, shrinks as scrollback grows, and moves as you mouse-wheel scroll.
3. **Pass criteria (draggable):** you can press/drag the scrollbar with the mouse to scroll — and it still works inside a Claude pane that has mouse reporting on (where the wheel is swallowed by the app). Drag works on touch too.
4. With Claude streaming, the thumb moves as scrollback grows; for a pure-Claude session with no prior scrollback the bar stays hidden (nothing to scroll — correct).

## C. Resize stability under mosaic
1. In a tab, open two panes. Run `htop` or `claude` in each.
2. Drag the splitter slowly, then fast. Then rearrange tiles via drag.
3. Resize the browser window itself.
4. Switch to another tab/workspace and back (mosaic re-mounts).
5. **Pass criteria:** Claude input bar never visibly jumps to a tiny size and back; htop redraws cleanly; SIGWINCH count in devtools network (under WS messages) is <= 2 unique (cols,rows) pairs per drag-completion.

## D. Font live-update
1. Scroll a pane up so it has visible scrollback, then Settings → switch font family or size.
2. **Pass criteria:** cell metrics update in place — scrollback and the WS attach survive (no terminal recreate), the pane reflows to the new row count, and a TUI like Claude Code fills the pane (the PTY is resized, not just xterm's view). No SIGWINCH storm.

## E. Reconnect replay
1. In dev: kill the server process (the one bound to :7777) for ~3s, then `pnpm --filter @muxpad/server dev` again. In a packaged install use `pnpm serve:stop` / `pnpm serve:restart`.
2. **Pass criteria:** terminal shows `[reconnected]`, replay arrives without GPU stall, no torn frames.

## F. Paste behaviour (symptom 3)
1. Plain text into Claude prompt: should appear as one line, not be auto-submitted.
2. Image-only clipboard into Claude prompt: should upload + insert path.
3. Image + text mixed clipboard (e.g. macOS Preview "Copy with caption"): should upload image AND paste the text, not silently drop one.
4. Large multiline paste (50+ lines): should arrive intact within bracketed-paste markers.

## G. SIGWINCH wire count
1. Open devtools → Network → WS → frames.
2. Drag splitter once (one gesture, settle).
3. **Pass criteria:** at most 2 distinct (cols,rows) opcodes 0x02 across the gesture.

## H. Debug logging
Enable via `?debug=1` in the URL **or** `localStorage.setItem('muxpad.debug','1')` (survives the `/` → `/w/:slug` redirect chain that strips query params). Logs `[XtermPane]` lines at default console level: WS open/close, refit dims, paste entry.

## I. Mobile touch scroll — KNOWN ISSUE, deferred
Touch scrolling the terminal on a phone is unreliable (plain panes ~50% of
flicks; Claude panes not at all). Several attempted fixes were reverted; this
is deferred for a later pass. **Workaround today:** the draggable overlay
scrollbar (section B) works on touch as a reliable fallback for reaching
scrollback.

## J. Clipboard in non-secure contexts
The app served over plain `http://<host-or-ip>` (Tailscale IP, LAN) is a non-secure context — `navigator.clipboard` is undefined.
1. **Cmd/Ctrl+C** on a selection: works (falls back to `execCommand('copy')`).
2. **Claude's OSC 52 copy** ("N characters copied"): only works over `localhost` or `https://` (secure context). On plain http it silently no-ops — no crash.
3. **Pass criteria:** no `writeText` TypeError in the console on text-select or copy, ever.
