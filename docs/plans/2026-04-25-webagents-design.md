# webagents — v1 design

A self-hosted browser-based replacement for an SSH+zellij workflow. The Mac mini at home runs a single Node daemon that owns PTYs and serves a React app. Each browser tab is a workspace with a tree of native-DOM panes; each pane is one xterm.js instance backed by one PTY. Image and text paste, text copy, and OSC 52 clipboard writes all work end-to-end. Tailscale is the access boundary; no auth in v1.

## Goals

- Replace SSH+zellij as the daily workflow for working with terminal apps (Claude Code, log tails, custom CLIs) from any browser on Tailscale.
- Browser tabs are the multiplexer: closing/opening tabs is non-destructive, and every workspace has a stable URL.
- Native DOM panes inside a workspace, not a muxed terminal canvas. Resize via DOM splitters; rearrange via drag.
- Reliable rendering of modern TUIs (Claude Code, vim, fzf, btop) via xterm.js — the same stack VS Code uses.
- First-class clipboard: paste images, paste text (with bracketed-paste), copy with selection, and OSC 52 writes.
- OSS-friendly: one stack (TS), permissive license, easy for others to self-host.

## Non-goals (v1)

- Custom Claude UI rendering JSON-stream output as HTML. Claude runs as a PTY like everything else. (v2.)
- Moving panes between workspaces. (v2.)
- Auth, multi-user, or sharing URLs. Tailscale is the v1 boundary.
- Survival of PTY runtime state across daemon restart. By design — workspace specs persist; PTYs do not.
- Mobile-optimized UI, file browsing, IDE-style features.

## Stack

- **Backend:** Node 22 + TypeScript. `ws` (WebSocket), `node-pty` (PTYs), `better-sqlite3` (workspace store), `express` or `hono` (HTTP).
- **Frontend:** React + Vite + TypeScript. `xterm.js` + `@xterm/addon-fit` + `@xterm/addon-clipboard` + `@xterm/addon-web-links`. `react-mosaic-component` for the split tree. TanStack Router for URL ↔ workspace.
- **Repo:** monorepo, three packages: `server/`, `web/`, `shared/` (zod-validated message types and DTOs).
- **Build:** Vite for `web/`; tsup or esbuild for `server/`. Output: a single `dist/` containing the bundled server and the static frontend.

Rationale: xterm.js + node-pty is the proven combination behind VS Code's integrated terminal. Single-language monorepo keeps the OSS contributor surface low-friction.

## Architecture

One Node process on the Mac mini owns everything:

```
┌──────────────────────────── Mac mini ────────────────────────────┐
│                                                                   │
│  ┌─ webagents-server (Node, single process, launchd-managed) ──┐ │
│  │                                                              │ │
│  │  HTTP/WS server (bound to 100.x.x.x:7777 — Tailscale only)  │ │
│  │   - serves static frontend bundle                           │ │
│  │   - /api/*  REST: workspaces, panes, attachments            │ │
│  │   - /ws/pane/:id  per-pane binary WebSocket                 │ │
│  │                                                              │ │
│  │  PaneManager — Map<paneId, PaneRuntime>                     │ │
│  │   PaneRuntime: node-pty handle, ring buffer (~10k lines /   │ │
│  │   2MB), set of attached WebSockets (mirror broadcast)       │ │
│  │                                                              │ │
│  │  WorkspaceStore — SQLite at ~/.muxpad/db.sqlite          │ │
│  │   workspaces, panes, attachments                            │ │
│  │                                                              │ │
│  └─────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
                              ▲
                              │  Tailscale (100.x.x.x:7777)
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   Mac mini local browser   Laptop browser     Phone browser
```

- launchd auto-restarts the daemon on crash. Runtime state (PTYs, scrollback) is not persisted across restarts; workspace specs are.
- Mirror concurrency = N WebSockets attached to one `PaneRuntime`. Output broadcasts to all; input from any goes to the PTY. Each browser maintains its own xterm selection state.

## Conceptual model

- **Workspace** — a long-lived named entity with a stable URL `/w/:slug`. Has a layout (binary split tree) and zero or more panes. Persisted to disk. Killed only by explicit Delete from the dashboard (cascades to all panes).
- **Pane** — a process running inside a shell, plus a ring-buffer scrollback. Belongs to exactly one workspace (its home). Identified by a globally unique id; can be viewed via its workspace's layout or directly at `/p/:paneId` (popout). Killed only by: explicit X in workspace UI; cascade from workspace delete; the shell exits naturally.
- **Pane lifecycle** — every pane runs an interactive shell (default `$SHELL`, typically zsh). On spawn, an optional startup command is auto-typed into the shell. When the startup command exits, the pane stays at the shell prompt — same scrollback, same cwd, same pane. When the user types `exit` (or Ctrl+D) at the shell prompt, the PTY closes and the pane is removed from the workspace's layout, with the binary tree rebalancing (sibling expands; parent split collapses if it now has one child).
- **View** — a browser tab attached to a workspace or popout. Closing any browser tab is **non-destructive** — it just disconnects the WebSocket. State is preserved on the daemon. Re-attach via the URL or the dashboard.

## Data model

SQLite, three tables:

```sql
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,         -- ulid
  slug        TEXT UNIQUE NOT NULL,     -- /w/:slug
  name        TEXT NOT NULL,
  layout      TEXT NOT NULL,            -- JSON: react-mosaic tree
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE panes (
  id            TEXT PRIMARY KEY,       -- ulid
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shell         TEXT NOT NULL,          -- e.g. "/bin/zsh"
  startup_cmd   TEXT,                   -- nullable; auto-typed on spawn
  cwd           TEXT NOT NULL,
  env           TEXT,                   -- JSON object, nullable
  created_at    INTEGER NOT NULL
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,       -- ulid
  pane_id       TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  mime          TEXT NOT NULL,
  path          TEXT NOT NULL,          -- absolute path on disk
  created_at    INTEGER NOT NULL
);

CREATE TABLE schema_version (version INTEGER NOT NULL);
```

`layout` is the binary split tree as nested JSON, identical in shape to `react-mosaic-component`'s internal model so no translation layer is needed:

```json
{
  "direction": "row",
  "splitPercentage": 50,
  "first":  { "direction": "column", "splitPercentage": 60, "first": "pane-01", "second": "pane-02" },
  "second": "pane-03"
}
```

Leaves are pane ids; nodes are split objects.

Layout/resize writes are debounced (300ms) to avoid hammering SQLite during drag.

## REST API

```
POST   /api/workspaces                       { name } -> { id, slug }
GET    /api/workspaces                       -> [{ id, slug, name, paneCount, lastActivity }]
GET    /api/workspaces/:id                   -> { ...workspace, panes: [...] }
PATCH  /api/workspaces/:id                   { name?, slug?, layout? }
DELETE /api/workspaces/:id                   -> 204 (cascade kills panes)

POST   /api/workspaces/:id/panes             { shell?, startup_cmd?, cwd?, env? } -> { id }
GET    /api/panes/:id                        -> { ...pane, isRunning }
DELETE /api/panes/:id                        -> 204 (kills process)
POST   /api/panes/:id/respawn                -> 204
POST   /api/panes/:id/attachments            multipart file -> { path }
```

Errors are JSON with `{ error: { code, message } }`.

## WebSocket protocol

`/ws/pane/:id` — binary framing. First byte is the message kind.

Client → server:

| Byte | Kind   | Payload                |
|------|--------|------------------------|
| 0x01 | input  | utf-8 bytes            |
| 0x02 | resize | uint16 cols, uint16 rows |

Server → client:

| Byte | Kind         | Payload                    |
|------|--------------|----------------------------|
| 0x01 | output       | utf-8 bytes (PTY stdout)   |
| 0x03 | exit         | int32 exit code (process exited; pane stays in layout, falls back to shell prompt; if the shell itself exited, server closes the WS) |
| 0x04 | error        | utf-8 message              |

On WS open, the server replays the ring buffer to the new client (one or more `0x01` frames) before live-streaming. Reconnects are the same flow. Mirror = many WSs sharing one `PaneRuntime`.

## Frontend layout & UX

**Workspace view (`/w/:slug`):**

`react-mosaic-component` renders the binary tree. Resize handles between panes and drag-to-rearrange are built-in. Each leaf is a `<Pane>` that renders:

- A chrome strip on top: title (defaults to startup command or shell), connection dot, kebab menu (split right / split down / popout / respawn / kill).
- An xterm.js terminal below filling the rest. `@xterm/addon-fit` keeps it sized to the container; resize observers debounce-emit `0x02` resize frames.

Adding a pane: kebab → "Split right / down" opens a small dialog (defaults: shell = `$SHELL`, startup_cmd = empty, cwd = focused pane's cwd or `$HOME`). On submit, POST creates the pane, the daemon spawns the PTY lazily on first WS attach, and the mosaic tree updates with the new leaf.

Killing a pane: kebab → "Kill" → confirm once per session → DELETE → tree rebalances. `exit` at the shell prompt does the same thing without the confirm.

**Popout view (`/p/:paneId`):**

Single full-viewport `<Pane>`. Layout-affecting menu items (split, drag, popout) hidden; kill and respawn still available.

**Dashboard (`/`):**

Plain table of workspaces with name, slug, pane count, last activity. "+ New workspace" creates one and navigates to it. Per-row kebab: rename, change slug, delete (confirm — destructive).

## Clipboard

A unified flow inside the `<XtermPane>` wrapper.

**Text paste (Cmd+V or OS paste):**
xterm.js's native paste event writes pasted text into the PTY. Bracketed paste mode is left enabled — TUIs opted in via DECSET 2004 receive `ESC[200~…ESC[201~`-wrapped pastes and treat them as a single chunk (so multi-line code pasted into zsh, Claude, or vim works correctly).

**Image paste (Cmd+V with image in clipboard):**
A `paste` listener on the xterm element checks `clipboardData.items` for `image/*`. If present, prevent default, POST each blob to `/api/panes/:id/attachments` (returns absolute path on disk), then write the path(s) into the PTY as if typed (space-separated for multiple images). Falls through to native text paste when no image is present. Backend stores attachments at `~/.muxpad/attachments/<workspaceId>/<random>.<ext>`; rows in the `attachments` table feed a startup-time GC of files older than 7 days that are no longer referenced.

**Text copy (Cmd+C with selection):**
- Click-drag selection works in xterm.js by default.
- Cmd+C with a selection: copy `xterm.getSelection()` to `navigator.clipboard.writeText()`. Without a selection: pass through to the PTY (SIGINT).
- Right-click opens a Copy / Paste context menu (instead of the browser default).
- Option-drag bypasses TUI mouse capture (Claude Code, vim with mouse, fzf), letting the user select text inside a mouse-grabbing TUI.
- `@xterm/addon-clipboard` is enabled, so TUIs that emit OSC 52 (`\e]52;c;…\a`) write directly to the system clipboard.

**Between panes / between machines:**
The system clipboard is the bridge — no special cross-pane mechanism. Copy in pane A on laptop → paste in pane B on the mini-local browser. Mirrored selections are local to each browser; this is correct.

## Process model & deployment

- **Single Node process.** All HTTP, WebSockets, PTYs, and SQLite I/O are in one process. No worker pool; no IPC.
- **PTY spawn is lazy.** A pane's process is spawned the first time a WebSocket attaches. Closing all attached WebSockets does NOT kill the PTY — it keeps running, output keeps filling the ring buffer.
- **Daemon restart.** launchd restarts on crash. On startup, no PTYs are spawned eagerly; the user reopens workspaces, and panes spawn lazily on attach with their stored `(shell, startup_cmd, cwd)` spec.
- **Bind address.** Configurable in `~/.muxpad/config.json`. Default for v1 is the Tailscale interface only.
- **Logs.** `~/Library/Logs/webagents/server.log` and `error.log`. JSON-line format. launchd handles rotation via `StandardOutPath` / `StandardErrorPath`.
- **Install.** A `webagents` CLI shipped alongside the server: `webagents install` writes the launchd plist; `webagents start|stop|status|logs` are thin wrappers around `launchctl`. Manual install path is documented for non-launchd users (Linux self-hosters).

## Reliability checks

A small smoke harness ships with the repo:

- A test that spawns 10 panes, runs a fixed workload (`yes`, `top -b`, `claude --help` loop), holds them open for 24h via CI, and asserts daemon RSS growth stays under threshold.
- Standard unit tests for the PaneRuntime ring buffer, layout serialization round-trip, and REST handlers.
- An e2e Playwright test driving the dashboard → create workspace → split panes → paste image → copy text → close.

## Future (v2+)

- Claude-block pane type rendering `claude --output-format=stream-json` as native HTML.
- Move panes between workspaces.
- Auth (token + signed cookie) for non-Tailscale hosting.
- Workspace templates ("dev box for repo X") and pane libraries.
- Tab drop-down workspace switcher inside a workspace view.
- OSC 7 / cwd tracking so split-from-here defaults to the pane's current directory.
