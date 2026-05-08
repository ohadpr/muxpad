<p align="center">
  <img src="docs/brand.svg" alt="muxpad" width="96" height="96" />
</p>

<h1 align="center">muxpad</h1>

<h3 align="center">An unopinionated browser-based terminal multiplexer.</h3>

<p align="center">
  Browser tabs as workspaces, native-DOM xterm.js panes, PTYs on the host.
</p>

A small server you run on a machine you keep around (a laptop dock, a home box, a Raspberry Pi). Each browser tab becomes a workspace with split panes. PTYs run server-side and outlive any individual tab, so you can close the browser, switch devices, come back tomorrow, and your shells, your Claude Code session, your dev servers and log tails are all still there.

"Unopinionated" means muxpad has no built-in concept of agents, worktrees, projects, or tasks. A pane is a shell. You decide what runs in it. If you want to park a Claude Code session in one pane, `aider` in another, and a `tail -f` in a third, that works. If you want to use it as a regular browser-based terminal with no agents at all, that also works. There is nothing in the code that knows or cares.

<p align="center">
  <img src="docs/screenshot.webp" alt="muxpad screenshot" width="900" />
</p>

## Features

- One browser tab per workspace at a stable URL (`/w/:slug`).
- Split panes you can drag to resize and drag to rearrange (react-mosaic).
- One PTY per pane via `node-pty`. Multiple tabs or devices can attach to the same pane and see the same output.
- Image paste: a clipboard image becomes a file path typed into the PTY, so Claude Code (and similar) read it as a file.
- Cmd+C copy on selection. OSC 52 clipboard writes from TUIs.
- Persists across daemon restarts. Workspaces, layouts, and pane specs live in SQLite. Shells respawn at the cwd you were last in (polled every 30s).
- Pop a pane out into its own URL at `/p/:paneId`.
- Five themes (Tokyo Night, Dracula, Solarized Dark, GitHub Light, Latte) and a curated monospace font picker.

## Requirements

- macOS or Linux
- Node 22+
- pnpm 10+ (`brew install pnpm` or via corepack)

## Quick start

```bash
pnpm install
pnpm --parallel dev
```

The web dev server runs on `:5173` and proxies API + WebSocket to the server on `:7777`. Open <http://localhost:5173>.

## Production install

For a personal install that runs in the background and survives terminal close, use the bundled `muxpad` script:

```bash
pnpm serve            # build if needed, start in background, print URL
pnpm serve:status     # show state, URL, log path
pnpm serve:logs       # tail the log
pnpm serve:stop       # SIGTERM the daemon
pnpm serve:restart    # stop + start (e.g. after pulling)
```

Logs go to `~/.muxpad/server.log`. The daemon does **not** auto-start on reboot. To set that up on macOS via launchd, see [docs/launchd.md](docs/launchd.md).

## Configuration

There is **no auth in v1**. Bind to an interface you actually trust, typically your Tailscale IPv4.

| Var | Default | Notes |
|---|---|---|
| `MUXPAD_HOST` | `127.0.0.1` | Bind address. The `pnpm serve` script picks up `tailscale ip -4` automatically when it's available. Don't use `0.0.0.0`. |
| `MUXPAD_PORT` | `7777` | TCP port. |
| `MUXPAD_DATA_DIR` | `~/.muxpad` | SQLite DB and pasted-image attachments. |

### Optional: nicer URL via Tailscale Serve

If you'd rather reach muxpad at `https://<your-machine>.<tailnet>.ts.net/` (no port, with a Tailscale-issued cert) than `http://<tailscale-ip>:7777/`, use:

```bash
pnpm serve:public         # start + map via tailscale serve in one step
pnpm serve:stop           # also tears down the tailscale serve mapping
```

Under the hood this sets `MUXPAD_TAILSCALE_SERVE=1`, which makes the start script bind to `127.0.0.1` (so the daemon's only public face is via the Tailscale Serve cert) and then runs `tailscale serve --bg https://localhost:7777`.

Status / manual control: `tailscale serve status` and `tailscale serve reset`.

For dev (`pnpm --parallel dev`), the vite config already permits `*.ts.net` hostnames, so `http://your-machine.your-tailnet.ts.net:5173/` works directly without Tailscale Serve.

## Project layout

```
shared/   zod-validated domain types, WS binary protocol codecs
server/   Hono HTTP, WebSocket bridge, PTY runtime, SQLite
web/      React SPA: dashboard, workspace, popout, XtermPane
```

## Stack

Node 22 + TypeScript monorepo on pnpm. Server is Hono + ws + node-pty + better-sqlite3. Web is React + Vite + TanStack Router + xterm.js + react-mosaic-component.

## Status

v1 ships the core flow. Open follow-ups: [docs/punch-list.md](docs/punch-list.md). Things deliberately not in v1:

- Auth. The Tailscale boundary is the v1 access boundary.
- Moving panes between workspaces.
- A custom Claude-block pane type that renders `claude --output-format=stream-json` as native HTML (text and image paste already work fine via the PTY path).
- Right-click context menu, keyboard shortcuts.
- Playwright e2e suite, 24h soak harness.

## License

MIT. See [LICENSE](LICENSE).
