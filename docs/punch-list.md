# Punch list

Known follow-up work from the v1 code review. The Critical items have been fixed (commit `9d783b4`). What remains is the Important and Minor list, plus design-spec items that v1 explicitly deferred.

## From the v1 review (deferred)

### Important

- **I1 — `GET /api/workspaces/by-slug/:slug`.** Today the workspace page does `listWorkspaces()` then filters client-side, which is two HTTP requests per navigation. Add a slug-keyed read route and stop double-fetching. (`server/src/routes/workspaces.ts`, `web/src/pages/WorkspaceView.tsx:71-78`.)
- **I2 — Debounce layout PATCH.** `<Mosaic onChange>` fires per-pixel during drag, so a multi-second resize is hundreds of SQL writes and HTTP requests. Trailing 200–300 ms debounce, sync local state immediately. (`web/src/pages/WorkspaceView.tsx`.)
- **I4 — Attachment GC.** Design specified a startup-time sweep of `~/.muxpad/attachments/` for files older than 7 days that are no longer referenced in the `attachments` table. Not implemented. ~15 lines: query, unlink, delete row.
- **I5 — RingBuffer byte vs code-unit semantics.** Capacity is named "2MB" but counted in JS string code units. Either rename + document, or accumulate `Uint8Array` chunks with TextDecoder streaming for `snapshot()`. (`server/src/runtime/RingBuffer.ts`.)
- **I6 — PATCH workspace slug validation.** Today an arbitrary string is accepted; collisions and malformed values surface as 500s. Run through the same `slugify`/`uniqueSlug` path used at create time, or reject with 400. (`server/src/routes/workspaces.ts:37`.)

### Minor

- **C3-b — Startup-cmd 50 ms delay is a guess.** Cold zsh + heavy `~/.zshrc` may not be ready in 50 ms; auto-typed `claude\n` interleaves with prompt rendering. Robust fix is to await first `onData` quiet period (~20 ms of no output) before writing. (`server/src/runtime/PaneRuntime.ts`.)
- **I7-a — Orphan pane row on navigate-during-create.** `splitPane` does `await api.createPane(...)`; if the user unmounts mid-call the pane is created server-side but never linked into a layout. Use an `AbortController` or unmount-finalizer that DELETEs the orphan. (`web/src/pages/WorkspaceView.tsx`.)
- **M3 — `mimeExt` coverage.** Add `image/svg+xml`, `image/heic`, `image/avif`. macOS clipboards often hold these. (`server/src/routes/attachments.ts:44-50`.)
- **M4 — Defensive env-JSON parse.** A corrupted `panes.env` row throws and 500s the route. Wrap `JSON.parse` and log + return null. (`server/src/store/PaneStore.ts:79`.)
- **M5 — Document the postinstall chmod.** Add a comment explaining the pnpm-10 / node-pty spawn-helper exec-bit issue so future contributors aren't lost. (`package.json:14`.)
- **M6 — Slug fallback after 1000 collisions.** Today it throws an opaque `unable to allocate slug`. Append a short ulid suffix as the last-resort fallback. (`server/src/store/WorkspaceStore.ts:51`.)
- **M9 — CORS policy.** Default same-origin is fine; document or expose a configurable `Access-Control-Allow-Origin`.
- **M11 — `+ Claude (right)` button needs a `which claude` gate.** Otherwise the user clicks the button without `claude` installed and gets a flash of "command not found" before the C3 fix returns them to the shell prompt.
- **M12 — `MUXPAD_DATA_DIR` permission errors.** `mkdirSync` can throw on launchd if the path is unwritable; surface a clearer message instead of crashing silently into the launchd error log.
- **M13 — WebSocket backpressure.** `ws.send` queues to `bufferedAmount` without limit when a client is slow. For a personal tool this is fine; flag if log-tail panes ever start lagging.
- **M14 — Web has no tests.** The trickiest logic (binary-tree mutations, paste fallthrough, resize flow) has zero coverage. At minimum, unit-test `appendPane`, `removePane`, `toMosaic`, `fromMosaic` in `web/src/pages/WorkspaceView.tsx`. Pure functions, ~30 lines.

## From the original design (deferred to v2)

These were explicitly out of scope for v1 per the option-C scope cut. Listed here so they're not forgotten.

- **Claude-block pane type.** Render `claude --output-format=stream-json` as native HTML (markdown, code blocks, inline images) instead of as a PTY. Per-pane choice when spawning. The single biggest design item v1 left on the table.
- **Move panes between workspaces.** v1 binds a pane to one workspace; the data model and route surface for move-between is v2.
- **Auth.** Tailscale boundary covers v1. For OSS hosting, add token-based auth (signed cookie + login page) before going public.
- **Right-click context menu.** Copy / Paste items in a custom menu instead of the browser default. (`docs/plans/2026-04-25-webagents-design.md:171`.)
- **Spawn-pane dialog.** Today the toolbar offers two preset buttons. Design called for a small dialog with shell / startup_cmd / cwd / env. (`docs/plans/2026-04-25-webagents-v1.md` Task 4.8.)
- **Connection-state indicator on pane chrome.** A small dot in the chrome strip that reflects WebSocket state (open / reconnecting / closed). The reconnect logic exists; the visible affordance does not.
- **OSC 7 cwd tracking.** When a TUI emits OSC 7, update the pane's stored `cwd` so split-from-here defaults to the right directory.
- **Workspace templates.** Pre-defined "dev box for repo X" templates that spawn N panes with prescribed commands.
- **Tab drop-down workspace switcher.** Inside a workspace view, a small switcher that lists other workspaces and lets you open them in new browser tabs.
- **Playwright e2e harness.** Cut from v1; add for OSS release.
- **24h soak harness.** Spawn N panes under simulated load, sample RSS, assert ceiling. Cut from v1.
- **`muxpad` CLI installer.** `muxpad install / start / stop / status / logs` wrapping launchctl. Cut from v1; manual launchd plist documented in README instead.
