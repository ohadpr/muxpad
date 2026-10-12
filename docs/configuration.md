# Configuration

Every environment variable muxpad reads.

| Var | Default | Notes |
|---|---|---|
| `MUXPAD_HOST` | `127.0.0.1` direct, **`0.0.0.0`** via `pnpm serve` | Bind address. `pnpm serve` prefers `tailscale ip -4` and falls back to `0.0.0.0`; the server binary's own default is loopback. Set it. |
| `MUXPAD_PORT` | `7777` | TCP port for the UI and API. |
| `MUXPAD_DATA_DIR` | `~/.muxpad` | SQLite DBs, archive, published artifacts, attachments, sockets. |
| `MUXPAD_PTYD_SOCKET` | `<dataDir>/ptyd.sock` | Where ptyd listens. Both processes must agree. |
| `MUXPAD_PUBLIC_PORT` | `7778` | The artifact-only listener. |
| `MUXPAD_PUBLIC_HOST` | `127.0.0.1` | Bind address for that listener. Loopback by default because the funnel proxies to it; nothing else needs to reach it. |
| `MUXPAD_PUBLIC_BASE_URL` | (unset) | Origin published links are built from. Set this once you have a permanent domain; it outranks every discovered value. |
| `MUXPAD_NO_FUNNEL` | (unset) | `1` stops the **server** exec'ing `tailscale`. The `muxpad publish` CLI does not read it and still tries to bring a funnel up itself, so an isolated instance wants the CLI kept away from publishing too. |
| `MUXPAD_TAILSCALE_SERVE` | (unset) | `1` binds to `127.0.0.1` and fronts the daemon via `tailscale serve` (see below). |
| `MUXPAD_ALLOWED_ORIGINS` | (unset) | Comma-separated extra **hostnames** allowed to make **writes** and open **WebSockets** (scheme and port are ignored, so one entry covers every port on that host). Every state-changing request and every `/ws/*` upgrade must come from an `Origin` that is loopback, matches the request's `Host`, or is listed here — a foreign page must not be able to POST an autostarting app into your muxpad or open a socket into a live terminal. The CLI and the agent runner send no `Origin` and are unaffected. Set this only if a reverse proxy rewrites `Host`; the 403 names the variable. See `server/src/same-origin.ts`. |
| `MUXPAD_OPENAI_API_KEY` | (unset) | Project API key for **voice mode**, falling back to `OPENAI_API_KEY`. Unset means voice is off: `/api/voice/status` says `configured: false` and starting a session is a 503. The key never leaves the server — the browser cannot hold it, because this API has no ephemeral tokens. Prefer a separate, spend-capped project key: read the next three rows first. |
| `MUXPAD_VOICE_DAILY_MINUTES` | `60` | **Daily ceiling on voice minutes.** Voice bills ~$0.05/min by wall clock — silence costs what speech costs — so this is the only setting that bounds the worst case. Persisted in the database, so a restart does not hand out a fresh allowance. Junk or `0` is ignored and the default stands. |
| `MUXPAD_VOICE_SESSION_MINUTES` | `10` | Hard limit on one call. The server closes the session at the deadline whatever the browser does, and shortens it further if less than that is left in the day's budget. |
| `MUXPAD_VOICE_NAME` | `marin` | Which OpenAI voice speaks. |

**Voice mode spends money, and muxpad still has no auth.** Anyone who can reach the port can start a call on your card, so the three caps above are enforced server-side and cannot be raised by the client: one live session at a time, a per-session deadline, and a persisted daily ceiling. The audio itself goes browser↔OpenAI directly; muxpad only relays the initial SDP handshake. Because muxpad is not in the media path it cannot force a stream to stop — it can free the slot, stop counting, and ask OpenAI to close. See `server/src/voice/`.

