# Artifact preview (static) — plan

Date: 2026-06-24

## Goal

An agent generates a static artifact (HTML/JS/CSS) in a CLI pane → it's
instantly viewable in a muxpad pane, on a tailnet-reachable URL, with **no**
manual Tailscale-URL wrangling, no clicking, and without opening the host
browser.

## Scope

- **In:** static, self-contained or relative-asset artifacts — a single file
  or a directory.
- **Out:** dynamic apps that run their own server → that's the service
  primitive. Absolute-path static sites are a known caveat (see below).

## Mechanism

- New CLI verb **`muxpad view <path>`**, run from inside a pane. It inherits
  `MUXPAD_PANE_ID / TAB_ID / WORKSPACE_ID / API_URL` from the pane env, so
  muxpad knows where to place the preview without being told.
- Server registers `id → absolute dir` (a small `artifacts` table, or an
  in-memory map). **Serve-from-original-path (zero copy)** so regenerating the
  file + refreshing the pane shows the new version.
- A static route serves that dir at `/artifacts/<id>/`, entry file as index,
  with a `..` traversal guard rooted in the dir.
- Reachable URL via the existing `toReachableUrl` (localhost → tailnet host).
  **No proxy needed** — muxpad already binds `0.0.0.0:7777`, so the tailnet IP
  reaches it directly.
- Open in a pane via the existing url-pane machinery — ideally a **reused
  "preview" pane** in the calling tab, not a fresh pane each time.

## Skill / CLAUDE.md (the agent-facing half)

> To show me something static, run `muxpad view <path>`. It serves it and opens
> it in a pane with a reachable URL. Never emit Tailscale URLs yourself; never
> use `open`/`xdg-open` (that's the host browser). If it should keep running or
> has its own server, that's `muxpad service`, not `view`.

## Open questions

- **File vs dir:** infer — a file serves its parent dir with that file as
  index; a dir serves the dir (index.html or named entry).
- **Reused preview pane:** how to track/replace it (a per-tab preview pane id?
  a `--pane` flag? a dedicated pane face?).
- **Registry lifetime:** in-memory (lost on server restart) vs SQLite (stable
  URL across restarts). Lean SQLite.
- **Absolute-path assets:** a page using `/style.css` breaks under the
  `/artifacts/<id>/` subpath. Detect + warn, or just document.
