# Roadmap

Upcoming work we want to build, roughly ordered (top = next). Detailed plans
live in `docs/plans/`. This is feature direction; `punch-list.md` is the
separate list of v1 review debt.

## Next up

1. **Static artifact preview** — `muxpad view <path>` serves a static artifact
   on a tailnet-reachable URL and opens it in a pane. No proxy (muxpad serves
   it on its own `0.0.0.0:7777`). Plan:
   `docs/plans/2026-06-24-artifact-preview.md`.

2. **Service primitive** — a server-owned, persistent process decoupled from
   any pane (survives pane/tab close), with a URL captured from stdout, an
   attachable terminal (disconnect ≠ kill), and start/stop/restart/logs.
   Fixes "who's running the notes server?". Also the reliable home for dynamic
   artifact previews. _Discussion in progress._

3. **`muxpad cron`** — a server-owned scheduler that fires prompts into the
   existing agent send queue, replacing the SDK's session-scoped `CronCreate`
   (which drifts context, can't catch up after downtime, expires at 7 days, is
   invisible, and is Claude-only). The injection half is already built; this is
   one table + one tick loop. Plan:
   `docs/plans/2026-08-14-muxpad-cron.md`.

4. **Web chat pane** — a ChatGPT-style chat served as an iframe pane,
   Claude-powered. Leading option: a small assistant-ui + Vercel AI SDK page
   (iframe-clean, no DB/auth); `claude-code-webui` for the agentic flavor.
   Independent of 1–2; cheap as a standalone spike.

## Undeveloped ideas

- **Tabs within tabs (horizontal sub-tabs).** Today the hierarchy is
  workspace → tab → pane, with workspaces and tabs in the sidebar. Want: open
  multiple *horizontal* tabs under what we currently call a tab — a second tab
  strip local to a tab, so one tab can hold several horizontally-switched
  sub-views. Open: does this make it workspace → tab → subtab → pane (a 4th
  level), or are sub-tabs just a horizontal bar inside a tab? Resolve the
  naming collision with today's "tab." _Undeveloped._
