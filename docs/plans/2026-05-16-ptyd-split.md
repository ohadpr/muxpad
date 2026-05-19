# Split muxpad daemon: extract `ptyd` so terminals survive server restarts

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move PTY ownership out of the main muxpad server into a separate, tiny, rarely-changing daemon (`ptyd`) so that restarting the main server — for HMR, package upgrade, or crash — no longer kills the user's terminals.

**Architecture:**
- **`ptyd`** owns every `node-pty` PTY, ring buffer, scanner, and the in-memory pane decoration state. Lives at a unix socket under `~/.muxpad/ptyd.sock`. Knows nothing about HTTP, the web bundle, or SQLite. Started by its own launchd job (or by `scripts/muxpad start` in dev). Restarts are rare and always destructive (terminals die) — by design.
- **`muxpad` (main server)** keeps HTTP, the web bundle, SQLite for structure, `/ws/events`, and `/ws/pane/:id`. PTY I/O is **proxied byte-for-byte** to ptyd's per-pane WebSocket; control (create/kill/lookup) goes through a long-lived JSON-RPC WebSocket on the same unix socket. Main server is HMR'd and updated freely.
- **Wire:** Existing `shared/ws-protocol.ts` binary frames stay the same end-to-end (browser ↔ main server ↔ ptyd). A new tiny JSON-line control protocol over a separate WS handles RPCs and pushed events. Both share the same `ws` library, same unix socket, different paths (`/pty/:id`, `/control`).
- **Persistence:** Ptyd holds no disk state. Cwd snapshots are pushed as events to the main server, which still owns the SQLite DB (`PaneStore`). On daemon restart, ptyd is untouched. On ptyd restart, all PTYs die; main server reconnects to the empty ptyd and panes respawn lazily on next attach (existing behavior).

**Tech stack:** TypeScript, Node 22, `ws` over unix domain socket, `node-pty`, existing `shared/ws-protocol`, vitest, pnpm workspaces.

**Scope decisions / non-goals:**
- No disk-persisted scrollback. (Out of scope; survives daemon restart already via ptyd staying up.)
- No survival across reboot or ptyd restart. (Would require either resurrecting from disk or running PTYs under a different supervisor — both too much new code, too many bugs.)
- No protocol version negotiation. Main server and ptyd ship from the same git tree and pin together. If they mismatch, refuse to start.
- No remote ptyd. Unix socket only, same host. Auth = filesystem permissions on the socket.
- No backward-compat shim for "old single-process mode." After cutover, the main server requires ptyd.

---

## Phase 0 — Scaffolding

### Task 0.1: Decide module layout and create empty ptyd entry

**Files:**
- Create: `server/src/ptyd/index.ts` (empty stub)
- Create: `server/src/ptyd/protocol.ts` (empty)
- Modify: `server/package.json` (add `build:ptyd`, `start:ptyd` scripts)

**Rationale:** Ptyd lives inside `@muxpad/server` rather than as a separate workspace package, so it can directly `import { PaneManager } from '../runtime/PaneManager.js'` without dance. Build produces two binaries: `dist/index.js` (main) and `dist/ptyd/index.js` (ptyd).

**Step 1: Create skeleton files**

```ts
// server/src/ptyd/index.ts
console.log('ptyd starting…');
```

```ts
// server/src/ptyd/protocol.ts
export {};
```

**Step 2: Update server/package.json scripts**

```json
"scripts": {
  "build": "tsc -b",
  "dev": "MUXPAD_HOST=0.0.0.0 tsx watch --include='../shared/dist' src/index.ts",
  "dev:ptyd": "tsx src/ptyd/index.ts",
  "start": "node dist/index.js",
  "start:ptyd": "node dist/ptyd/index.js",
  ...
}
```

**Step 3: Verify the ptyd entry compiles and runs**

```bash
pnpm -C server build && node server/dist/ptyd/index.js
# Expect: prints "ptyd starting…", exits 0
```

**Step 4: Commit**

```bash
git add server/src/ptyd server/package.json
git commit -m "scaffold: empty ptyd entry point"
```

---

## Phase 1 — Define the control protocol

The control channel is a long-lived JSON-line WebSocket. Each message is one JSON object per WS frame. Requests have `{id, method, params}`; responses `{id, ok: true, result}` or `{id, ok: false, error}`. Server-pushed events have `{event, ...}` with no `id`.

### Task 1.1: Write the control-protocol types and codec tests

**Files:**
- Create: `server/src/ptyd/protocol.ts`
- Create: `server/src/ptyd/protocol.test.ts`

**Step 1: Write failing tests**

```ts
// server/src/ptyd/protocol.test.ts
import { describe, it, expect } from 'vitest';
import {
  encodeRequest, decodeMessage,
  encodeResponse, encodeErrorResponse, encodeEvent,
  type CtrlMessage,
} from './protocol.js';

describe('ptyd control protocol', () => {
  it('round-trips a request', () => {
    const wire = encodeRequest({ id: 1, method: 'killPane', params: { id: 'p1' } });
    const msg = decodeMessage(wire);
    expect(msg).toEqual({ kind: 'request', id: 1, method: 'killPane', params: { id: 'p1' } });
  });

  it('round-trips a successful response', () => {
    const wire = encodeResponse(1, { ok: true });
    const msg = decodeMessage(wire);
    expect(msg).toEqual({ kind: 'response', id: 1, ok: true, result: { ok: true } });
  });

  it('round-trips an error response', () => {
    const wire = encodeErrorResponse(1, 'pane not found');
    const msg = decodeMessage(wire);
    expect(msg).toEqual({ kind: 'response', id: 1, ok: false, error: 'pane not found' });
  });

  it('round-trips a pushed event', () => {
    const wire = encodeEvent({ event: 'paneExit', id: 'p1', code: 0, cause: 'natural' });
    const msg = decodeMessage(wire);
    expect(msg).toEqual({
      kind: 'event',
      event: 'paneExit',
      id: 'p1',
      code: 0,
      cause: 'natural',
    });
  });

  it('rejects malformed input', () => {
    expect(() => decodeMessage('not json')).toThrow();
    expect(() => decodeMessage(JSON.stringify({ nope: 1 }))).toThrow();
  });
});
```

Run: `pnpm -C server test src/ptyd/protocol.test.ts` → expect FAIL.

**Step 2: Implement the codec**

```ts
// server/src/ptyd/protocol.ts
export type CtrlRequest = { kind: 'request'; id: number; method: string; params: unknown };
export type CtrlResponse =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string };
export type CtrlEvent = { kind: 'event'; event: string } & Record<string, unknown>;
export type CtrlMessage = CtrlRequest | CtrlResponse | CtrlEvent;

export function encodeRequest(r: Omit<CtrlRequest, 'kind'>): string {
  return JSON.stringify({ t: 'req', ...r });
}
export function encodeResponse(id: number, result: unknown): string {
  return JSON.stringify({ t: 'res', id, ok: true, result });
}
export function encodeErrorResponse(id: number, error: string): string {
  return JSON.stringify({ t: 'res', id, ok: false, error });
}
export function encodeEvent(e: Omit<CtrlEvent, 'kind'>): string {
  return JSON.stringify({ t: 'evt', ...e });
}
export function decodeMessage(s: string): CtrlMessage {
  const v = JSON.parse(s);
  if (v?.t === 'req' && typeof v.id === 'number' && typeof v.method === 'string')
    return { kind: 'request', id: v.id, method: v.method, params: v.params };
  if (v?.t === 'res' && typeof v.id === 'number') {
    if (v.ok === true) return { kind: 'response', id: v.id, ok: true, result: v.result };
    if (v.ok === false) return { kind: 'response', id: v.id, ok: false, error: String(v.error) };
  }
  if (v?.t === 'evt' && typeof v.event === 'string') {
    const { t, ...rest } = v;
    return { kind: 'event', ...rest };
  }
  throw new Error('malformed control message');
}
```

**Step 3: Run tests → expect PASS**

**Step 4: Commit**

```bash
git add server/src/ptyd/protocol.ts server/src/ptyd/protocol.test.ts
git commit -m "ptyd: control-protocol codec (JSON-line over WS)"
```

### Task 1.2: Document the RPC surface as a TS type union

**Files:** Modify: `server/src/ptyd/protocol.ts`

Add typed `Method` definitions so the client/server share a single source of truth.

```ts
// Add to protocol.ts
import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';

export type CreatePaneParams = { spec: PaneRuntimeSpec };
export type IdParams = { id: string };

export interface CtrlMethods {
  ensurePane: { params: CreatePaneParams; result: { ok: true } };
  killPane: { params: IdParams; result: { ok: true } };
  hasPane: { params: IdParams; result: { has: boolean } };
  getCurrentCwd: { params: IdParams; result: { cwd: string | null } };
  getForegroundCommand: { params: IdParams; result: { cmd: string | null } };
  markSeen: { params: IdParams; result: { ok: true } };
  flushCwds: { params: {}; result: { entries: Array<{ id: string; cwd: string }> } };
}

export type CtrlPushEvent =
  | { event: 'paneExit'; id: string; code: number; cause: 'natural' | 'killed' }
  | { event: 'paneCwd'; id: string; cwd: string }
  | { event: 'paneTitle'; id: string; title: string | null }
  | { event: 'paneFg'; id: string; cmd: string | null }
  | { event: 'paneAttention'; id: string; attention: boolean };
```

Commit:

```bash
git commit -am "ptyd: type the control RPC surface"
```

---

## Phase 2 — ptyd standalone daemon (no client integration yet)

### Task 2.1: Pick the socket path, write a tiny "ptyd is up" test

**Files:**
- Modify: `server/src/ptyd/index.ts`
- Create: `server/src/ptyd/index.test.ts`

**Step 1: Failing test — boot ptyd and connect a control WS**

```ts
// server/src/ptyd/index.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { startPtyd, type PtydHandle } from './index.js';
import WebSocket from 'ws';
import { encodeRequest, decodeMessage } from './protocol.js';

let handle: PtydHandle | null = null;
let dir = '';

afterEach(async () => {
  if (handle) await handle.stop();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('ptyd boot', () => {
  it('listens on the configured unix socket and accepts a control connection', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ptyd-'));
    const socketPath = join(dir, 'ptyd.sock');
    handle = await startPtyd({ socketPath });
    const ws = new WebSocket(`ws+unix://${socketPath}:/control`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    // ping → pong via a no-op method
    ws.send(encodeRequest({ id: 1, method: 'hasPane', params: { id: 'nope' } }));
    const reply = await new Promise<any>((resolve) => ws.once('message', (b) => resolve(decodeMessage(b.toString()))));
    expect(reply).toEqual({ kind: 'response', id: 1, ok: true, result: { has: false } });
    ws.close();
  });
});
```

Run: `pnpm -C server test src/ptyd/index.test.ts` → expect FAIL (`startPtyd` doesn't exist).

**Step 2: Implement minimal ptyd boot + `hasPane` only**

```ts
// server/src/ptyd/index.ts
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PaneManager } from '../runtime/PaneManager.js';
import {
  decodeMessage, encodeResponse, encodeErrorResponse,
  type CtrlMessage,
} from './protocol.js';

export interface PtydOptions { socketPath: string; }
export interface PtydHandle { stop(): Promise<void>; }

export async function startPtyd(opts: PtydOptions): Promise<PtydHandle> {
  if (existsSync(opts.socketPath)) await unlink(opts.socketPath);
  const paneManager = new PaneManager();
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/control') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => attachControl(ws, paneManager));
  });
  await new Promise<void>((r) => http.listen(opts.socketPath, r));
  return {
    async stop() {
      await paneManager.killAll();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => http.close(() => r()));
      if (existsSync(opts.socketPath)) await unlink(opts.socketPath).catch(() => {});
    },
  };
}

function attachControl(ws: WebSocket, pm: PaneManager): void {
  ws.on('message', (data: Buffer) => {
    let msg: CtrlMessage;
    try { msg = decodeMessage(data.toString()); }
    catch (e) { ws.send(encodeErrorResponse(0, String(e))); return; }
    if (msg.kind !== 'request') return;
    try {
      if (msg.method === 'hasPane') {
        const { id } = msg.params as { id: string };
        ws.send(encodeResponse(msg.id, { has: pm.has(id) }));
        return;
      }
      ws.send(encodeErrorResponse(msg.id, `unknown method: ${msg.method}`));
    } catch (e) {
      ws.send(encodeErrorResponse(msg.id, String(e)));
    }
  });
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const socketPath = process.env.MUXPAD_PTYD_SOCKET
    ?? `${process.env.HOME}/.muxpad/ptyd.sock`;
  startPtyd({ socketPath }).then(() => {
    console.log(`ptyd listening on ${socketPath}`);
  });
  process.on('SIGTERM', () => process.exit(0));
}
```

Run tests → PASS.

**Step 3: Commit**

```bash
git commit -am "ptyd: boot on unix socket, implement hasPane"
```

### Task 2.2: Implement the rest of the control RPCs (TDD per method)

For each of `ensurePane`, `killPane`, `getCurrentCwd`, `getForegroundCommand`, `markSeen`, `flushCwds`:

**Pattern (one micro-task per method):**

1. Add a failing integration test in `server/src/ptyd/index.test.ts` that boots ptyd, opens a control WS, calls the RPC, asserts behavior.
2. Implement the handler in `attachControl()`.
3. Run tests → PASS.
4. Commit `"ptyd: implement <method>"`.

**Notes:**
- `ensurePane` calls `pm.getOrCreate(spec)` and discards the runtime — fire-and-forget. Result is `{ ok: true }`.
- `markSeen` calls `pm.get(id)?.markSeen()` if present; result `{ ok: true }` always (idempotent).
- `flushCwds` is the only RPC that returns data harvested by an internal poll — implement by capturing `pm.flushCwds()` output. The current `flushCwds()` doesn't return anything; modify PaneManager to expose a `snapshotCwds(): Array<{id, cwd}>` helper used internally by `flushCwds()` and exposed to ptyd. Add a unit test on PaneManager first.

### Task 2.3: Wire `PaneManager` events through to ptyd control pushes

Ptyd needs to emit `paneExit`, `paneCwd`, `paneTitle`, `paneFg`, `paneAttention` as control events. Today, `PaneManager.emitDecorations()` pushes structured `pane.updated` events to an `EventBus` — but it depends on `PaneStore` for full row hydration, which ptyd will not have.

**Refactor PaneManager (TDD):**
1. Add failing test asserting PaneManager emits "raw" change events (just `{id, value}`) via a new `onChange` callback or a new EventEmitter mixin, without needing PaneStore.
2. Implement: extract title/fg/attention diffing into a new optional callback option `onPaneChange?: (id, change) => void` that fires regardless of `events`/`panes` being set. Keep the existing `events`+`panes` decoration path for the main-server in-process case (will be removed in Phase 4).
3. Run all PaneManager tests → PASS.
4. Commit `"PaneManager: expose raw change callback for ptyd"`.

**Then in ptyd:**
1. Failing test: boot ptyd, ensure a pane, capture pushed `paneCwd` / `paneTitle` events on the control WS.
2. Implement: in `startPtyd`, construct PaneManager with `onCwdChange` (push `paneCwd`) and `onPaneChange` (push title/fg/attention). Subscribe each new runtime's `exit` event for `paneExit`.
3. Tests → PASS.
4. Commit `"ptyd: push lifecycle/decoration events on control channel"`.

### Task 2.4: Implement `/pty/:id` endpoint in ptyd

Ptyd accepts a per-attach WS at `/pty/:id`. The protocol on this stream is identical to today's `/ws/pane/:id` (binary frames from `shared/ws-protocol.ts`). Ptyd does the same things ws.ts does today: snapshot replay, output stream, input forwarding, resize, etc. The pane must already exist (caller must have sent `ensurePane` first); if not present, ptyd closes with a 4404 code.

**Step 1: Failing test**

```ts
it('attaches to a pane and echoes input', async () => {
  // boot ptyd, ensurePane({spec with /bin/cat-like shell}), open /pty/:id WS,
  // send encodeInput('hi\n'), expect encodeOutput frames back.
});
```

**Step 2: Implement**

Lift the upgrade-handler body of today's `server/src/ws.ts` (only the `/ws/pane/:id` arm — not `/ws/events`) into a new `server/src/ptyd/pty-bridge.ts`. Remove the DB lookups (kind / workspace_id) — caller is responsible. Remove the `paneSockets` tracking (ptyd doesn't do kind-flip force-close; the main server still does, via a new `closePtyClients` RPC).

**Step 3: Pass tests → commit `"ptyd: per-attach /pty/:id WS endpoint"`**

### Task 2.5: Add `closePtyClients` RPC for kind-flip force-close

Main server uses this when a pane's kind flips. Ptyd closes attached WS clients with code 4001, same semantics as today.

TDD as above. Commit `"ptyd: closePtyClients RPC"`.

---

## Phase 3 — Main server client library

### Task 3.1: Build `PtydClient` with reconnect and method-call plumbing

**Files:**
- Create: `server/src/ptyd-client/PtydClient.ts`
- Create: `server/src/ptyd-client/PtydClient.test.ts`

`PtydClient` is what the main server uses in place of `PaneManager`. Surface:

```ts
export class PtydClient extends EventEmitter {
  constructor(opts: { socketPath: string; });
  // mirrors PaneManager methods we still need, but async + remote:
  ensurePane(spec: PaneRuntimeSpec): Promise<void>;
  killPane(id: string): Promise<void>;
  hasPane(id: string): Promise<boolean>;
  getCurrentCwd(id: string): Promise<string | null>;
  getForegroundCommand(id: string): Promise<string | null>;
  markSeen(id: string): Promise<void>;
  flushCwds(): Promise<Array<{ id: string; cwd: string }>>;
  closePtyClients(id: string): Promise<void>;
  // events emitted from pushed control events:
  //   'paneExit', 'paneCwd', 'paneTitle', 'paneFg', 'paneAttention'
  // Also internal:
  //   'connected', 'disconnected'
  close(): Promise<void>;
}
```

**TDD plan:**

1. Failing test: spawn an in-process ptyd (using `startPtyd` from Phase 2), construct a `PtydClient` against it, call `hasPane('nope')`, expect `false`.
2. Implement minimal request/response (id counter, pending-map of `{resolve, reject}`).
3. Add test for an event push (boot ptyd, ensurePane, kill it, expect `paneExit` event on client).
4. Implement event re-emit.
5. Add test for **reconnect**: stop ptyd, restart it, ensure client reconnects within ~500ms and a queued call eventually succeeds.
6. Implement: WS reconnect with exponential backoff (200ms → 2s cap), fail-fast pending RPCs with a clear error on disconnect (caller retries; we don't queue across disconnects to avoid replay hazards).
7. Add test for missing socket: connecting to a nonexistent socket path → emits `disconnected`, retries.
8. Implement.
9. Commit incrementally per test: `"PtydClient: basic RPC"`, `"PtydClient: event re-emit"`, `"PtydClient: reconnect on disconnect"`.

### Task 3.2: Proxy stream helper

The main server's `/ws/pane/:id` handler doesn't decode PTY frames — it just bridges. Build a single helper:

```ts
// server/src/ptyd-client/proxyAttach.ts
export function proxyAttach(opts: {
  client: PtydClient;
  paneId: string;
  browser: WebSocket;
}): { close(): void };
```

Inside: opens a new WS to `ws+unix://<socket>:/pty/<id>`, pipes bytes both ways, closes the browser WS when the proxy WS closes (mirroring today's "pty exited" behavior). Reuses the per-attach lifetime.

**TDD:** spin up ptyd + a `WebSocketServer` representing the browser; pump bytes both ways; assert echo. Commit.

---

## Phase 4 — Cut the main server over

### Task 4.1: Replace `PaneManager` construction with `PtydClient` in `server/src/index.ts`

**Step 1:** Remove the in-process `PaneManager` import. Construct `PtydClient` instead.

**Step 2:** Wire the cwd-changed event: `client.on('paneCwd', ({id, cwd}) => paneStore.updateCwd(id, cwd))`. Also wire title/fg/attention events through a small new helper that does the same diff-decoration logic that lived inside `PaneManager.emitDecorations()`, but on the main-server side using `PaneStore.getById`.

**Step 3:** Remove the `events`+`panes` constructor opts on `PaneManager` (no longer used by main server; ptyd uses the new raw-change callback).

**Step 4:** Update `shutdown()` to disconnect the client but **not** call `killAll`. The main server shutdown must no longer kill PTYs — that is precisely the point of the split.

```ts
// server/src/index.ts (key delta)
const ptyd = new PtydClient({ socketPath: config.ptydSocketPath });
ptyd.on('paneCwd', ({ id, cwd }) => paneStore.updateCwd(id, cwd));
ptyd.on('paneTitle', (e) => emitPaneUpdated(e.id, { title: e.title }));
ptyd.on('paneFg',    (e) => emitPaneUpdated(e.id, { fg: e.cmd }));
ptyd.on('paneAttention', (e) => emitPaneUpdated(e.id, { attention: e.attention }));
// ...
const shutdown = async () => {
  await wsServer.close();
  await ptyd.close();    // disconnect, do NOT killAll
  httpServer.closeAllConnections();
  httpServer.close(() => process.exit(0));
};
```

**Step 5:** Update all route consumers in `server/src/routes/panes.ts`:
- `paneManager.kill(id)` → `ptyd.killPane(id)`
- `paneManager.getOrCreate(spec)` → `ptyd.ensurePane(spec)`
- `paneManager.get(id)?.getCurrentCwd()` → `await ptyd.getCurrentCwd(id)` (or use last cached value pushed via `paneCwd`)
- `paneManager.has(id)` → `await ptyd.hasPane(id)` (consider whether the route really needs this; if it's only for a presence flag, cache via `paneCwd`/`paneExit` events).

For `workspaces.ts` (which reads `paneManager.getForegroundCommand(id)`): maintain a `Map<paneId, string|null>` on the main server, updated from `paneFg` events. The HTTP handler reads the cache. This avoids an RPC round-trip per pane on every workspace list.

**Step 6:** Update `server/src/ws.ts`: the `/ws/pane/:id` upgrade arm now does the existing validation (pane exists, kind != url, workspace_id lookup), then calls `ptyd.ensurePane(spec)`, then `proxyAttach({ client: ptyd, paneId, browser: ws })`. The per-pane `paneSockets` tracking moves into… **wait, kind-flip force-close** — the route handler needs to close clients that are attached to *ptyd*, not to the main server. Use `ptyd.closePtyClients(id)`. Drop the local `paneSockets` map entirely.

**Step 7:** Update `server/src/runtime/PaneManager.ts` to be ptyd-only — drop `events`/`panes` options (in-process diff-emit no longer used by main server). Update all PaneManager tests accordingly. Tests for the raw-change callback added in Task 2.3 stay.

**Step 8:** Update `server/src/config.ts` to include `ptydSocketPath`.

Run all tests:

```bash
pnpm -C server test
```

**Some existing tests will break.** Expect breakage in:
- `server/src/ws.test.ts` — boots an HTTP+WS server and a `PaneManager` directly. Refactor: tests need to also boot a ptyd-in-process (use `startPtyd` from Phase 2) and pass its socket path. Or: introduce a `--inline` mode for tests that runs ptyd in the same process behind a localhost TCP for ease. Recommended: keep the unix socket; in tests, boot ptyd with a tmpdir socket path. Helper: `test-helpers/spawnPtyd.ts`.
- `server/src/runtime/PaneManager.test.ts` — drop or move the diff-emit tests that depend on `events`+`panes` options; covered now by ptyd integration tests.
- `server/src/routes/panes.test.ts` — needs ptyd-in-process too.

Triage each test file, fix per file, commit per file. Suggested commit cadence:

```bash
git commit -m "tests: switch ws.test.ts to in-process ptyd"
git commit -m "tests: switch panes routes to in-process ptyd"
# etc.
```

**Step 9 (cutover commit):**

```bash
git add -A
git commit -m "muxpad: switch to remote ptyd via PtydClient"
```

### Task 4.2: End-to-end smoke (manual)

**Files:** none.

1. Build: `pnpm -r build`.
2. Terminal A: `MUXPAD_PTYD_SOCKET=/tmp/ptyd.sock node server/dist/ptyd/index.js`
3. Terminal B: `MUXPAD_PTYD_SOCKET=/tmp/ptyd.sock node server/dist/index.js`
4. Open `http://localhost:7777`, create a pane, type `top` to give it state.
5. Kill terminal B, restart it. Expect: pane reconnects within ~1s, `top` still running, scrollback intact.
6. Kill terminal A. Expect: pane shows "process exited" / "connection lost" — that's correct; ptyd is down.
7. Restart terminal A. Expect: client auto-reconnect; pane respawns on attach at the persisted cwd.

If any step misbehaves: triage, fix, no additional commits required for the smoke itself.

---

## Phase 5 — Orchestration and packaging

### Task 5.1: Update `pnpm dev` to run both processes

**File:** root `package.json`

`pnpm -r --parallel dev` currently launches `web` and `server` `dev` scripts. Add ptyd to the orchestration:

Option A (recommended): edit `server/package.json` `dev` to launch ptyd alongside under a process supervisor like `npm-run-all`. Lighter alternative: a tiny `server/scripts/dev.sh` that:

```sh
#!/usr/bin/env sh
set -e
SOCKET="${MUXPAD_PTYD_SOCKET:-$HOME/.muxpad/ptyd.sock}"
mkdir -p "$(dirname "$SOCKET")"
# ptyd: NO watch — must survive main-server restarts
node --enable-source-maps -r tsx/cjs src/ptyd/index.ts &
PTYD=$!
trap 'kill $PTYD 2>/dev/null' EXIT
# main: tsx watch as today
MUXPAD_PTYD_SOCKET="$SOCKET" exec tsx watch --include='../shared/dist' src/index.ts
```

Set `server.dev` to invoke that script. Commit.

This keeps ptyd alive across main-server HMR restarts in dev — proving the design's value to the developer running `pnpm dev`.

### Task 5.2: Update `scripts/muxpad start` / `stop` / `restart` to manage both processes

**File:** `scripts/muxpad`

Read the script first. Adjust so:
- `start`: spawns ptyd in background (via `nohup` or similar), waits for socket to appear, then spawns main server.
- `stop`: stops main server only by default. `--all` also stops ptyd.
- `restart`: stops/starts main server only. Add `restart --all` for full restart.

Commit.

### Task 5.3: launchd plists

**File:** `docs/launchd.md`

Replace the single plist with two plists: `dev.muxpad.ptyd` (KeepAlive, runs `node .../dist/ptyd/index.js`) and `dev.muxpad` (KeepAlive, runs `node .../dist/index.js` with `MUXPAD_PTYD_SOCKET` env). Show how to install both. Note explicitly: "Upgrading muxpad: `launchctl kickstart -k gui/$UID/dev.muxpad` restarts the main server without touching ptyd. Your terminals survive."

Commit.

---

## Phase 6 — Verification

### Task 6.1: Run the full suite one more time

```bash
pnpm -r build && pnpm -r test
```

All passing. Commit (if anything was tweaked).

### Task 6.2: Re-run the manual smoke against the dev orchestration

`pnpm dev`. Touch `server/src/server.ts`. Confirm: tsx watch restarts the main server; the browser pane WS briefly disconnects + reconnects; the running `top` / `claude` / whatever inside the pane is *still running* with intact scrollback.

This is the success criterion.

### Task 6.3: Update top-level docs

**File:** `docs/punch-list.md` or wherever architecture summaries live.

Add a paragraph: "muxpad runs as two processes: `ptyd` owns terminals and stays up across restarts; the main `muxpad` server owns HTTP, the web bundle, structural state, and the event stream, and proxies PTY I/O to ptyd over a unix socket. Restarting the main server (HMR, upgrade) does not affect your running terminals; restarting ptyd does."

Commit.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Protocol mismatch when only one of the two is upgraded | Ship both from same git tree; embed version constant in `protocol.ts`; refuse to start if main server's expected protocol version != ptyd's. Add a `getVersion` RPC. |
| Main server stuck in reconnect loop if ptyd dies during shutdown ordering bug | `PtydClient` fails RPCs fast on disconnect; routes/handlers must propagate errors to the HTTP response (return 503). |
| Tests that previously constructed `PaneManager` directly become harder to read | Provide a single test helper `spawnInProcessPtyd()` that returns `{ client, stop }`; use everywhere. |
| `node-pty` + unix socket + workspace TS layout: Linux/macOS path-length limit on socket (~104 chars) bites a deep `~/.muxpad/.../ptyd.sock` | Default to `~/.muxpad/ptyd.sock` (short); allow override via env. Document. |
| Race between `ensurePane` and `proxyAttach` opening the per-attach WS before ptyd registers the pane | `ensurePane` resolves only after `PaneManager.getOrCreate` returns. WS attach happens after the `await`. |
| Per-attach WS proxy doubles socket count, hits default `ulimit -n` on macOS (256) | Each pane attach uses 2 sockets (browser + ptyd). 100 panes = 200 sockets — fine on default limits. Document that heavy users may want `ulimit -n 1024`. |
| `tsx watch` in `server.dev` not restarting ptyd is the whole point — but a developer might `pnpm dev` and not realize ptyd is a separate process if they ctrl-C | The shell script in Task 5.1 traps EXIT and kills ptyd on `pnpm dev` shutdown, so it doesn't get orphaned. |

---

## Out of scope (intentionally)

- Scrollback persistence to disk
- Resurrection of PTYs after reboot or ptyd restart
- Multi-host / network-transport ptyd
- A migration path for existing installs (none yet outside of you)
- Protocol versioning beyond a refuse-to-start check
