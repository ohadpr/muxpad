# muxpad publish — public artifact hosting

**Date:** 2026-08-28
**Status:** Implemented.
**Goal:** `muxpad publish <file-or-dir>` → the content is hosted and a
universal PUBLIC URL (whole internet, no tailnet needed) is printed.

## Why a dedicated public port

The main :7777 app is tailnet-served and **unauthenticated** — it must never
be funneled. So publishing gets its own listener (default :7778, loopback)
that serves ONLY static files from `<dataDir>/public/`, and Tailscale Funnel
exposes exactly that port as `https://<machine-dnsname>:8443/`. Funnel via
`Tailscale funnel --bg --https=8443 http://127.0.0.1:7778` was verified
working on this machine before this design.

## Design

Four pieces, all in the main server + CLI.

### 1. Public static server (`server/src/public-server.ts`)

A second `serve()` in index.ts on `MUXPAD_PUBLIC_PORT` (default 7778),
bound to `MUXPAD_PUBLIC_HOST` (default 127.0.0.1 — the funnel proxies to
loopback; nothing else needs it). GET/HEAD only, no API routes, no WS, no
SPA fallback. URL shape: `https://<dnsname>:8443/<slug>/`.

- Root `/` is always a 404 (no index, no listing — the hostname alone
  reveals nothing). Inside a slug, a directory serves its `index.html`
  (with a `/slug` → `/slug/` 301 so relative links work) or 404s; no
  directory listings anywhere, by design.
- Traversal: each path segment is percent-decoded individually; anything
  decoding to `.`/`..` or containing `/`, `\`, or NUL → 404. Literal `../`
  never even arrives (WHATWG URL parsing collapses dot-segments at root).
- **Symlink policy:** the realpath of every served file must stay inside
  the (realpathed) public dir, else 404. Publish copies content with full
  dereferencing (hand-rolled — node's `cpSync {dereference}` skips nested
  links), so legitimate artifacts are always regular files; any symlink
  that escapes the tree is hostile and refused.
- Headers: Content-Type from a fixed extension map (request/filename bytes
  never reach a header — no injection surface), `nosniff` on everything.
  Caching: HTML `max-age=60, must-revalidate` (so republishing a named slug
  propagates), other assets `max-age=86400`. Random slugs are effectively
  immutable, but named slugs can be overwritten in place, hence no
  `immutable` on HTML.

### 2. Publish API (`server/src/routes/publish.ts`, MAIN port)

- `POST /api/publish {path, name?}` → `{slug, url, files, bytes, warning?}`.
  Copies the file (a lone `.html` → `<slug>/index.html`, else keeps its
  name) or directory (recursive, dereferencing) into
  `<dataDir>/public/<slug>/`. `path` must be absolute; any path the server
  can read is fair game (personal tool) except the public dir itself /
  its ancestors (self-recursive copy). Slug = provided name (validated
  `[a-z0-9-]{1,64}`; republish overwrites) or 8 crypto-random hex chars.
- `GET /api/publish` → `{publishes: [{slug, files, bytes, created}]}`.
- `DELETE /api/publish/:slug` → 204.
- **No DB rows** (fs-derived, deliberately): a publish is fully described by
  its slug directory — `created` is the dir birthtime, files/bytes are a
  walk. Nothing to migrate, nothing to drift when a dir is removed by hand.

### 3. Funnel management + URL resolution (`server/src/funnel.ts`)

**launchd reality (found at deploy):** the live daemon runs under launchd,
where the macOS Tailscale app CLI refuses to run at all ("The Tailscale GUI
failed to start", CLIError 3) — it only works from user shells (e.g. inside
panes). `env -i` reproduces it; no single env var fixes it. So server-side
discovery is best-effort, and the publish URL resolves through a tiered
chain (routes/publish.ts):

1. **CLI hint** — `muxpad publish` runs, in the PANE shell where tailscale
   does work: `tailscale funnel --bg --https=8443 http://127.0.0.1:<public
   port>` (idempotent; PATH → app-bundle fallback → `MUXPAD_TAILSCALE_BIN`
   override for tests) and reads `status --json` → `Self.DNSName`, then
   passes `public_base_url: "https://<dnsname>:8443"` in the POST. Every
   CLI-side failure is silent. The server validates the hint (well-formed
   https origin only — else 400) and persists it.
2. **Server-side discovery** — `funnel.ensure()`: same commands, works in
   dev/non-launchd runs. Persisted on success; in-process cached.
3. **Persisted `public_base_url`** in the globals KV (migration 19 table,
   no new migration) — seeded by 1 or 2, this is what keeps headless/cron
   publishes on the public URL. Used without a warning: it's a known-public
   base.
4. **Local URL + `warning`** — nothing else worked; publish still succeeds.

- **Teardown is manual by design:** deleting the last publish does NOT turn
  the funnel off. `tailscale funnel --https=8443 off` closes it; while up
  it only ever exposes the static public dir. (The production funnel was
  seeded by hand; the first pane-side publish persists the base URL and the
  server is self-sufficient thereafter.)
- `MUXPAD_NO_FUNNEL=1` swaps in an exec-free local funnel (isolated/test
  instances can never expose anything); `createApp` without publish deps
  defaults the same way, so no test path can run a tailscale command. CLI
  tests stub the binary via `MUXPAD_TAILSCALE_BIN`.

### 4. CLI + playbook

- `muxpad publish <path> [--name=slug]` — prints the public URL on stdout
  (the one thing on stdout; warnings on stderr), `--list`, `--rm <slug>`.
- CEO playbook template (server/src/ceo.ts) gains a Publishing section and
  a `muxpad search` pointer — new CEO homes only; the live
  `~/.muxpad/ceo/CLAUDE.md` is user-owned and untouched.

## Non-goals

- Auth/expiry/quotas on published artifacts — slugs are unguessable when
  random, and it's a personal tool. Delete when done.
- Funnel lifecycle tied to publish count (see teardown note above).
- A web UI — CLI/API first, same as the archive.

## Rollout

Main-server restart only. The funnel comes up lazily on the first publish,
never at boot.
