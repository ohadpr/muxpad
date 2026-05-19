# URL Panes + muxpad CLI Implementation Plan

> **⚠️ HISTORICAL — KEPT FOR DESIGN CONTEXT, NOT CURRENT ARCHITECTURE.**
>
> What actually shipped diverged from this plan in two important places:
>
> 1. **The OSC-based CLI (Tasks 10-13)** was implemented, then *replaced
>    entirely* in Task 16 by an HTTP-based wrapper that returns IDs (so
>    coding agents can chain `workspace new → tab new → pane new`).
>    The PtyScanner muxpad-arm, dispatcher, and `onMuxpadCmd` plumbing
>    were all deleted in commit `6c083d0`. The wire protocol described
>    in Architecture bullet 2 below is gone.
>
> 2. **The empty-workspace UX** evolved through iteration: workspaces
>    used to auto-delete when drained; they now never auto-delete and
>    always show an explicit "+ New tab / Close workspace" affordance.
>
> The commit log on `feat/url-panes-cli` is the authoritative history.
> This file is kept as a record of the design process — read it for
> *why* we picked the approaches we did, not as a guide to the code.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship two composing features — iframe-backed URL panes that live alongside terminal panes, and an in-pane `muxpad` CLI (delivered via OSC escape sequences on the PTY) that can create panes/tabs/URL panes from inside any shell. URL panes can be created, navigated, and removed from both UI and CLI.

**Architecture:**
- URL panes are a new `kind` on the existing `panes` table (`'shell' | 'url'`), with a nullable `url` column. They share the same `POST /tabs/:id/panes` endpoint, the same react-mosaic layout, and the same pane chrome as shell panes — the only divergence is `PaneManager` skips spawning a PTY for them, and the renderer shows an `<iframe>` instead of `<XtermPane>`.
- The CLI's "wire protocol" is a custom OSC sequence (`ESC ] muxpad ; <verb> ; <k=v>… BEL`). It's emitted by a tiny POSIX-sh wrapper into the PTY's stdin/stdout stream; the server's `PtyScanner` extracts and strips it, and `PaneRuntime` dispatches the verb against the store/manager. No HTTP, no auth dance, no separate binary — the CLI is per-pane by construction because the OSC arrives at exactly the runtime whose PTY emitted it.
- **Phase 1 (Tasks 1-13) ships URL panes + CLI against the existing 5s `getTab` poll.** UI- and CLI-spawned panes show up within 5s, same as today's pane-title/foreground updates.
- **Phase 2 (Task 14) converts polling to an app-level WebSocket (`/ws/events`).** One socket per browser tab; server broadcasts typed events from every mutating route + the muxpad dispatcher; clients merge events into their existing caches. Per-pane PTY data still flows on the existing per-pane WS — that's the data plane; the events socket is the control plane. Lands as a separate, isolated refactor so Phase 1 is testable and shippable on its own.

**Tech Stack:** TypeScript / Hono / better-sqlite3 / node-pty (server). React 18 + react-mosaic + xterm.js (web). Vitest. Zod. POSIX `sh` for the wrapper script.

**Worktree:** Run in a worktree off `main`. Server changes will restart `tsx watch` and kill PTY sessions — expected, don't fight it.

---

## Pre-flight: read these first

- `server/src/store/migrations.ts` — current schema baseline (v1); see panes table at lines 62-70.
- `server/src/store/PaneStore.ts` — `create()` shape and `PaneRow` mapping.
- `server/src/routes/panes.ts` — request validation, cwd inheritance, lazy spawn pattern.
- `server/src/routes/tabs.ts` — folding live state (`title`, `foreground_cmd`, `attention`) into pane list responses.
- `server/src/routes/workspaces.ts` — workspace mutation surface (Task 14 instruments this for events).
- `server/src/runtime/pty-scanner.ts` + `.test.ts` — the state machine you're extending.
- `server/src/runtime/PaneRuntime.ts` — `start()` env construction, scanner output callback, where dispatch handlers go.
- `server/src/runtime/PaneManager.ts:107` — `getOrCreate` (only `kind === 'shell'` should reach here). Task 14 adds diff-emit for title/foreground_cmd.
- `server/src/ws.ts:56-76` — `/ws/pane/:id` upgrade — must 404/destroy for URL panes. Task 14 also adds `/ws/events` here.
- `web/src/pages/TabView.tsx` — renderer + layout state; this is where the kind dispatch goes (Task 8) and where the 5s `getTab` poll gets ripped out in Task 14.
- `web/src/components/XtermPane.tsx` — interface to mirror in `UrlPane.tsx`.
- `web/src/api.ts:86-101` — client surface to extend.
- `web/src/tabs.ts` / `web/src/workspaces.ts` — shared caches (`refreshTabs`, `refreshWorkspaces`); Task 14 drives them from events instead of polling.
- `shared/src/types.ts` — `PaneSpecSchema` to extend; Task 14 adds a `MuxpadEvent` union.
- `scripts/muxpad` — existing daemon-control script; we're **extending** it with `pane`/`tab`/`workspace`/`open` subcommands, not replacing.

---

## Task 1: Schema migration — add `kind` and `url`, relax NOT NULL

**Files:**
- Modify: `server/src/store/migrations.ts`

**Step 1: Write the failing test**

Append to `server/src/store/migrations.test.ts` (create if missing — check first):

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

describe('migrations v2 — url panes', () => {
  it('adds kind defaulting to shell and a nullable url column', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Insert a row using the legacy shape (no kind/url). The default
    // should fill kind=shell.
    db.prepare(
      `INSERT INTO panes (id, tab_id, shell, startup_cmd, cwd, env, created_at)
       VALUES ('p1', 't1', '/bin/zsh', null, '/tmp', null, 0)`,
    ).run();
    const row = db
      .prepare('SELECT kind, url FROM panes WHERE id = ?')
      .get('p1') as { kind: string; url: string | null };
    expect(row.kind).toBe('shell');
    expect(row.url).toBeNull();
  });

  it('allows kind=url with a url and null shell/cwd', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Required: tabs row first because of FK; same for workspace.
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'w', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't', 't', '', 'w1', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO panes (id, tab_id, kind, url, shell, cwd, created_at)
       VALUES ('p2', 't1', 'url', 'https://example.com', null, null, 0)`,
    ).run();
    const row = db
      .prepare('SELECT kind, url, shell, cwd FROM panes WHERE id = ?')
      .get('p2') as { kind: string; url: string; shell: string | null; cwd: string | null };
    expect(row).toEqual({
      kind: 'url',
      url: 'https://example.com',
      shell: null,
      cwd: null,
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @muxpad/server test -- migrations
```
Expected: tests fail (`no such column: kind`).

**Step 3: Implement**

Append a v2 migration in `server/src/store/migrations.ts` after the v1 entry. SQLite doesn't support `ALTER COLUMN`; to relax `NOT NULL` on `shell` and `cwd` we recreate the table:

```ts
{
  version: 2,
  sql: `
    ALTER TABLE panes RENAME TO panes_v1;
    CREATE TABLE panes (
      id           TEXT PRIMARY KEY,
      tab_id       TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL DEFAULT 'shell',
      url          TEXT,
      shell        TEXT,
      startup_cmd  TEXT,
      cwd          TEXT,
      env          TEXT,
      created_at   INTEGER NOT NULL
    );
    INSERT INTO panes (id, tab_id, kind, shell, startup_cmd, cwd, env, created_at)
      SELECT id, tab_id, 'shell', shell, startup_cmd, cwd, env, created_at
      FROM panes_v1;
    DROP TABLE panes_v1;
    CREATE INDEX panes_tab_id ON panes(tab_id);
  `,
},
```

**Step 4: Verify**

```bash
pnpm --filter @muxpad/server test -- migrations
```
Expected: PASS. Also run the full server suite to catch regressions:
```bash
pnpm --filter @muxpad/server test
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/store/migrations.ts server/src/store/migrations.test.ts
git commit -m "feat(server): add panes.kind + panes.url for URL panes"
```

---

## Task 2: Shared types — `kind` and `url` on `PaneSpec`

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `shared/src/types.test.ts` (if it exercises `PaneSpecSchema` — check first)

**Step 1: Update `PaneSpecSchema`**

Replace the `PaneSpecSchema` block in `shared/src/types.ts`:

```ts
export const PaneSpecSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  kind: z.enum(['shell', 'url']).default('shell'),
  url: z.string().nullable().default(null),
  // shell/cwd are required for kind='shell', null for kind='url'.
  shell: z.string().nullable().default(null),
  startup_cmd: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  env: z.record(z.string()).nullable().default(null),
  created_at: z.number(),
  // Runtime-only fields decorated by the route layer.
  title: z.string().nullable().optional(),
  foreground_cmd: z.string().nullable().optional(),
});
```

**Step 2: Build shared package**

```bash
pnpm --filter @muxpad/shared build
```
Expected: no type errors.

**Step 3: Run shared tests**

```bash
pnpm --filter @muxpad/shared test
```
Expected: PASS. If `types.test.ts` exercises `PaneSpec` with non-null `shell`/`cwd` defaults, update those expectations to match the new nullable shape.

**Step 4: Commit**

```bash
git add shared/src/types.ts shared/src/types.test.ts shared/dist
git commit -m "feat(shared): widen PaneSpec for kind=url"
```

---

## Task 3: PaneStore — accept `kind` + `url`, persist null shell/cwd for URL panes

**Files:**
- Modify: `server/src/store/PaneStore.ts`

**Step 1: Write the failing test**

Append to `server/src/store/PaneStore.test.ts` (check existence; create scaffolding if missing — model after sibling `*.test.ts`):

```ts
it('creates a kind=url pane with null shell/cwd', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  // FK rows
  db.prepare(`INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES ('w', 'w', 'w', 0, 0, 0)`).run();
  db.prepare(`INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES ('t', 't', 't', '', 'w', 0, 0, 0)`).run();

  const store = new PaneStore(db);
  const pane = store.create({
    tab_id: 't',
    kind: 'url',
    url: 'https://example.com',
  });
  expect(pane.kind).toBe('url');
  expect(pane.url).toBe('https://example.com');
  expect(pane.shell).toBeNull();
  expect(pane.cwd).toBeNull();

  const read = store.getById(pane.id)!;
  expect(read.kind).toBe('url');
  expect(read.url).toBe('https://example.com');
});

it('updates a pane url via updateUrl', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES ('w', 'w', 'w', 0, 0, 0)`).run();
  db.prepare(`INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES ('t', 't', 't', '', 'w', 0, 0, 0)`).run();
  const store = new PaneStore(db);
  const p = store.create({ tab_id: 't', kind: 'url', url: 'https://a' });
  store.updateUrl(p.id, 'https://b');
  expect(store.getById(p.id)!.url).toBe('https://b');
});
```

**Step 2: Run, watch fail**

```bash
pnpm --filter @muxpad/server test -- PaneStore
```
Expected: FAIL (`kind` not accepted by create signature; `updateUrl` undefined).

**Step 3: Implement**

Replace `PaneStore` body (the row type, `create()`, and `row()` mapper) to support `kind`/`url` and a new `updateUrl()`:

```ts
interface PaneRow {
  id: string;
  tab_id: string;
  kind: 'shell' | 'url';
  url: string | null;
  shell: string | null;
  startup_cmd: string | null;
  cwd: string | null;
  env: string | null;
  created_at: number;
}

create(input: {
  tab_id: string;
  kind?: 'shell' | 'url';
  url?: string | null;
  shell?: string | null;
  cwd?: string | null;
  startup_cmd?: string | null;
  env?: Record<string, string> | null;
}): PaneSpec {
  const id = ulid();
  const now = Date.now();
  const kind = input.kind ?? 'shell';
  const url = input.url ?? null;
  const shell = input.shell ?? null;
  const cwd = input.cwd ?? null;
  const startup_cmd = input.startup_cmd ?? null;
  const env = input.env ?? null;
  this.db
    .prepare(
      'INSERT INTO panes (id, tab_id, kind, url, shell, startup_cmd, cwd, env, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, input.tab_id, kind, url, shell, startup_cmd, cwd, env ? JSON.stringify(env) : null, now);
  return { id, tab_id: input.tab_id, kind, url, shell, startup_cmd, cwd, env, created_at: now };
}

updateUrl(id: string, url: string): void {
  this.db.prepare('UPDATE panes SET url = ? WHERE id = ? AND kind = ?').run(url, id, 'url');
}

private row(r: unknown): PaneSpec | null {
  if (!r) return null;
  const x = r as PaneRow;
  return {
    id: x.id,
    tab_id: x.tab_id,
    kind: x.kind,
    url: x.url,
    shell: x.shell,
    startup_cmd: x.startup_cmd,
    cwd: x.cwd,
    env: x.env ? (JSON.parse(x.env) as Record<string, string>) : null,
    created_at: x.created_at,
  };
}
```

Existing `updateCwd` stays. `listByTab`/`getById`/`delete` are unchanged signature-wise.

**Step 4: Verify**

```bash
pnpm --filter @muxpad/server test -- PaneStore
```
Expected: PASS, including the existing shell-pane tests (`shell`/`cwd` still set when passed).

**Step 5: Commit**

```bash
git add server/src/store/PaneStore.ts server/src/store/PaneStore.test.ts
git commit -m "feat(server): PaneStore supports kind=url + updateUrl"
```

---

## Task 4: Skip URL panes in PaneManager and WS upgrade

**Files:**
- Modify: `server/src/routes/panes.ts` (the lazy-spawn pattern is only reachable through routes; URL panes simply never call manager.getOrCreate)
- Modify: `server/src/ws.ts` (reject `/ws/pane/:id` upgrades for URL panes)

**Step 1: WS upgrade test**

Add to `server/src/ws.test.ts`:

```ts
it('rejects ws upgrade for a kind=url pane', async () => {
  // Use whatever existing harness creates a tab + pane; create with
  // kind='url' (call panes.create({ tab_id, kind: 'url', url: '…' })
  // through the test helper or directly via the store).
  // Then attempt a WebSocket connection to /ws/pane/<id> and assert
  // the server closes the socket without 101.
  // Mirror the structure of any existing "rejects unknown pane" test.
});
```

(If the test harness doesn't already cover the negative path, model the new test on the existing "unknown pane" rejection — keep it short.)

**Step 2: Run, watch fail**

```bash
pnpm --filter @muxpad/server test -- ws
```
Expected: FAIL (URL pane upgrade currently calls getOrCreate with `shell: null`, which would crash node-pty).

**Step 3: Implement**

In `server/src/ws.ts`, after the `panes.getById` lookup (~line 64):

```ts
if (pane.kind === 'url') {
  socket.destroy();
  return;
}
```

In `server/src/routes/panes.ts`, the `POST /:id/respawn` handler must also guard:

```ts
if (p.kind === 'url') {
  return c.json({ error: { code: 'bad_request', message: 'cannot respawn a url pane' } }, 400);
}
```

`PaneManager.getOrCreate` doesn't need changes — nothing should reach it with a URL pane spec once the two callers above guard.

**Step 4: Verify**

```bash
pnpm --filter @muxpad/server test
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/ws.ts server/src/ws.test.ts server/src/routes/panes.ts
git commit -m "feat(server): reject ws/respawn on url panes"
```

---

## Task 5: `POST /tabs/:id/panes` accepts `kind`/`url`; add `PATCH /panes/:id` for URL edits

**Files:**
- Modify: `server/src/routes/panes.ts`
- Modify: `server/src/routes/panes.test.ts`

**Step 1: Write the failing tests**

Add to `server/src/routes/panes.test.ts`:

```ts
it('creates a url pane with kind=url and url', async () => {
  const tab = await createTab(); // existing helper
  const res = await app.request(`/api/tabs/${tab.id}/panes`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'url', url: 'https://example.com' }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.kind).toBe('url');
  expect(body.url).toBe('https://example.com');
  expect(body.shell).toBeNull();
});

it('rejects kind=url without url', async () => {
  const tab = await createTab();
  const res = await app.request(`/api/tabs/${tab.id}/panes`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'url' }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(400);
});

it('rejects shell/cwd/startup_cmd combined with kind=url', async () => {
  const tab = await createTab();
  const res = await app.request(`/api/tabs/${tab.id}/panes`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'url', url: 'https://x', startup_cmd: 'vim' }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(400);
});

it('PATCH /panes/:id updates url for a url pane', async () => {
  const tab = await createTab();
  const created = await app.request(`/api/tabs/${tab.id}/panes`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'url', url: 'https://a' }),
    headers: { 'content-type': 'application/json' },
  }).then((r) => r.json());
  const res = await app.request(`/api/panes/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ url: 'https://b' }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.url).toBe('https://b');
});

it('PATCH rejects url update on shell panes', async () => {
  const tab = await createTab();
  const created = await app.request(`/api/tabs/${tab.id}/panes`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  }).then((r) => r.json());
  const res = await app.request(`/api/panes/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ url: 'https://x' }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(400);
});
```

**Step 2: Run, watch fail**

```bash
pnpm --filter @muxpad/server test -- routes/panes
```
Expected: FAIL.

**Step 3: Implement**

In `server/src/routes/panes.ts`, replace the POST body schema and handler:

```ts
const createBody = z.object({
  kind: z.enum(['shell', 'url']).optional(),
  url: z.string().url().nullable().optional(),
  shell: z.string().optional(),
  startup_cmd: z.string().nullable().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).nullable().optional(),
  inherit_cwd_from: z.string().optional(),
});

// Inside the handler, after parsing:
const kind = body.kind ?? 'shell';
if (kind === 'url') {
  if (!body.url) {
    return c.json({ error: { code: 'bad_request', message: 'url required for kind=url' } }, 400);
  }
  if (body.shell || body.startup_cmd || body.cwd || body.env || body.inherit_cwd_from) {
    return c.json({ error: { code: 'bad_request', message: 'shell/cwd/startup_cmd/env/inherit_cwd_from not allowed for kind=url' } }, 400);
  }
  const pane = panes.create({ tab_id: tabId, kind: 'url', url: body.url });
  return c.json(pane, 201);
}
// existing shell-pane path follows, unchanged
```

Add a new `PATCH /:id` handler in `panesScopedRoutes`:

```ts
app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const p = panes.getById(id);
  if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
  const body = z.object({ url: z.string().url().optional() }).parse(await c.req.json().catch(() => ({})));
  if (body.url !== undefined) {
    if (p.kind !== 'url') {
      return c.json({ error: { code: 'bad_request', message: 'url can only be set on kind=url panes' } }, 400);
    }
    panes.updateUrl(id, body.url);
  }
  return c.json(panes.getById(id));
});
```

(Task 14 instruments this handler with an event emission; for Phase 1 the 5s poll in `TabView` picks up the change.)

**Step 4: Verify**

```bash
pnpm --filter @muxpad/server test -- routes/panes
```
Expected: PASS. Also run the full server suite.

**Step 5: Commit**

```bash
git add server/src/routes/panes.ts server/src/routes/panes.test.ts
git commit -m "feat(server): POST /panes accepts kind=url; PATCH /panes/:id sets url"
```

---

## Task 6: Web API client — `kind`/`url` on createPane + `patchPane`

**Files:**
- Modify: `web/src/api.ts`

**Step 1: Update**

Extend the `createPane` body type and add `patchPane`:

```ts
createPane: (
  tabId: string,
  body: {
    kind?: 'shell' | 'url';
    url?: string;
    shell?: string;
    startup_cmd?: string | null;
    cwd?: string;
    env?: Record<string, string> | null;
    inherit_cwd_from?: string;
  } = {},
) =>
  req<PaneSpec>(`/api/tabs/${tabId}/panes`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),

patchPane: (id: string, patch: { url?: string }) =>
  req<PaneSpec>(`/api/panes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),
```

**Step 2: Typecheck**

```bash
pnpm --filter @muxpad/web build
```
Expected: PASS (or at most fail on downstream callers, which the next tasks will fix).

**Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): api client supports url panes"
```

---

## Task 7: `UrlPane` component

**Files:**
- Create: `web/src/components/UrlPane.tsx`
- Create: `web/src/components/UrlPane.css`

**Step 1: Implement**

`web/src/components/UrlPane.tsx`:

```tsx
import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import './UrlPane.css';

interface UrlPaneProps {
  paneId: string;
  url: string;
  /** Called when the user submits a new URL in the address bar. */
  onUrlChange?: (url: string) => void;
}

export function UrlPane({ paneId, url, onUrlChange }: UrlPaneProps) {
  const [draft, setDraft] = useState(url);
  const [committed, setCommitted] = useState(url);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Track external url changes (CLI muxpad open --target, or another tab).
  useEffect(() => {
    setDraft(url);
    setCommitted(url);
  }, [url]);

  const submit = async (raw: string) => {
    const next = normalizeUrl(raw);
    if (!next || next === committed) return;
    setCommitted(next);
    try {
      await api.patchPane(paneId, { url: next });
      onUrlChange?.(next);
    } catch (e) {
      console.error('patchPane failed', e);
    }
  };

  return (
    <div className="url-pane">
      <form
        className="url-pane-addressbar"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft);
        }}
      >
        <input
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          aria-label="URL"
        />
        <button
          type="button"
          className="url-pane-reload"
          aria-label="Reload"
          title="Reload"
          onClick={() => {
            if (iframeRef.current) iframeRef.current.src = committed;
          }}
        >
          ↻
        </button>
      </form>
      <iframe
        ref={iframeRef}
        src={committed}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        title={committed}
      />
    </div>
  );
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bare hostname/path → assume https.
  return `https://${trimmed}`;
}
```

`web/src/components/UrlPane.css`:

```css
.url-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--pane-bg, #111);
}

.url-pane-addressbar {
  display: flex;
  gap: 4px;
  padding: 4px 6px;
  background: var(--pane-chrome-bg, #1a1a1a);
  border-bottom: 1px solid var(--pane-chrome-border, #222);
}

.url-pane-addressbar input {
  flex: 1;
  background: var(--pane-bg, #0a0a0a);
  border: 1px solid var(--pane-chrome-border, #222);
  color: var(--pane-fg, #d4d4d4);
  padding: 3px 8px;
  border-radius: 3px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  outline: none;
}

.url-pane-addressbar input:focus {
  border-color: var(--accent, #4a9eff);
}

.url-pane-reload {
  background: transparent;
  color: var(--pane-fg, #d4d4d4);
  border: 1px solid var(--pane-chrome-border, #222);
  border-radius: 3px;
  cursor: pointer;
  padding: 0 8px;
  font-size: 14px;
}

.url-pane iframe {
  flex: 1;
  border: 0;
  width: 100%;
}
```

**Step 2: Sanity check imports**

```bash
pnpm --filter @muxpad/web build
```
Expected: PASS — no callers yet, just the new component compiling.

**Step 3: Commit**

```bash
git add web/src/components/UrlPane.tsx web/src/components/UrlPane.css
git commit -m "feat(web): UrlPane component with inline address bar"
```

---

## Task 8: Wire `UrlPane` into `TabView` (dispatch on `pane.kind`)

**Files:**
- Modify: `web/src/pages/TabView.tsx`

**Step 1: Implement**

In the mosaic `renderTile`, replace the body (the `<XtermPane …/>` line, ~548):

```tsx
{(() => {
  const pane = tab.panes.find((p) => p.id === paneId);
  if (pane?.kind === 'url' && pane.url) {
    return <UrlPane paneId={paneId} url={pane.url} />;
  }
  return <XtermPane paneId={paneId} onExit={() => onPaneExited(paneId)} />;
})()}
```

Same dispatch in the mobile branch (~459). Import:

```tsx
import { UrlPane } from '../components/UrlPane';
```

`paneLabel` (line 386) should prefer the iframe's hostname for URL panes when no OSC title is set:

```tsx
const paneLabel = (paneId: string): string => {
  const p = tab.panes.find((x) => x.id === paneId);
  if (p?.kind === 'url' && p.url) {
    try { return new URL(p.url).hostname; } catch { return p.url; }
  }
  const title = p?.title?.trim();
  if (title) return title;
  const cmd = p?.foreground_cmd?.trim();
  if (cmd) return cmd;
  return `Pane ${paneNumber(paneId)}`;
};
```

**Step 2: Manual verify with curl**

Start the dev server, then in a tab that already has a shell pane, find the tab id and POST a URL pane via curl:

```bash
# In a separate shell, with the dev server running:
TAB_ID=<paste the tab id from the URL bar or from listTabs response>
curl -X POST "http://localhost:7777/api/tabs/$TAB_ID/panes" \
  -H 'content-type: application/json' \
  -d '{"kind":"url","url":"https://example.com"}'
```

The URL pane should appear in the mosaic within ~5s (TabView's existing poll interval). Verify in the browser:
- iframe renders `example.com`
- address bar is editable
- submitting a new URL updates the iframe and persists (refresh → still there)
- close (X) removes the pane and updates the layout

(Task 14 converts this to instant push via `/ws/events`; for Phase 1 the 5s poll is enough.)

**Step 3: Commit**

```bash
git add web/src/pages/TabView.tsx
git commit -m "feat(web): TabView renders UrlPane for kind=url panes"
```

---

## Task 9: Type-switch toggle — convert a pane between Shell and Web

A small button at the **left** of each pane's chrome row toggles the pane's `kind`. Click on a shell pane → server kills its PTY, flips the row to `kind=url` with `url=null`, client re-renders as a `UrlPane` with the address bar focused. Click on a URL pane → server flips to `kind=shell` with defaults (`shell=$SHELL`, `cwd=homedir`), client re-renders as `XtermPane`, lazy-spawn kicks in on WS attach. Lossy (no confirm); cheap to reverse.

**Files:**
- Modify: `server/src/store/PaneStore.ts` (add `updateKind`)
- Modify: `server/src/routes/panes.ts` (PATCH accepts `kind`; close attached WSes on flip)
- Modify: `server/src/ws.ts` (expose `closePaneClients(id)` helper to the routes layer)
- Modify: `web/src/api.ts` (`patchPane` accepts `kind?`)
- Modify: `web/src/components/UrlPane.tsx` (handle empty/null URL — show focused address bar)
- Modify: `web/src/pages/TabView.tsx` (chrome button + composite remount key)
- Test: `server/src/routes/panes.test.ts` (kind-flip cases)
- Test: `server/src/ws.test.ts` (WS closure on flip)

### Step 1: `PaneStore.updateKind`

In `PaneStore.ts`:

```ts
updateKind(id: string, next: {
  kind: 'shell' | 'url';
  url?: string | null;
  shell?: string | null;
  cwd?: string | null;
  startup_cmd?: string | null;
}): void {
  this.db.prepare(
    `UPDATE panes SET kind = ?, url = ?, shell = ?, cwd = ?, startup_cmd = ? WHERE id = ?`,
  ).run(
    next.kind,
    next.url ?? null,
    next.shell ?? null,
    next.cwd ?? null,
    next.startup_cmd ?? null,
    id,
  );
}
```

Append a unit test asserting both directions (`shell → url`, `url → shell`) clear/set the right columns.

### Step 2: WS close helper — `server/src/ws.ts`

The WS layer already tracks attached clients per pane (`PaneRuntime.connectedClients` + `clientCount()`). Expose a function the routes can call to slam-close every WS attached to a given pane id:

```ts
// At the top of setupWs, after wss is created:
const paneSockets = new Map<string, Set<WebSocket>>();

// In the per-pane upgrade handler, after handleUpgrade succeeds:
let bucket = paneSockets.get(paneId);
if (!bucket) { bucket = new Set(); paneSockets.set(paneId, bucket); }
bucket.add(ws);
ws.on('close', () => bucket?.delete(ws));

// Expose on deps:
return { closePaneClients(paneId: string) {
  const bucket = paneSockets.get(paneId);
  if (!bucket) return;
  for (const ws of bucket) {
    try { ws.close(4001, 'pane kind changed'); } catch {}
  }
  bucket.clear();
} };
```

Pass the returned object back to whoever wires `panesScopedRoutes` so the PATCH handler can call it.

### Step 3: PATCH /panes/:id accepts `kind`

In `server/src/routes/panes.ts`, widen the PATCH schema:

```ts
const patchBody = z.object({
  kind: z.enum(['shell', 'url']).optional(),
  url: z.string().url().nullable().optional(),
});

app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const p = panes.getById(id);
  if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
  const body = patchBody.parse(await c.req.json().catch(() => ({})));

  if (body.kind && body.kind !== p.kind) {
    // Kind flip: close any attached WSes first, then mutate.
    await deps.paneManager.kill(id);            // no-op if URL pane / never started
    deps.closePaneClients(id);
    if (body.kind === 'url') {
      panes.updateKind(id, { kind: 'url', url: body.url ?? null });
    } else {
      panes.updateKind(id, {
        kind: 'shell',
        shell: process.env.SHELL ?? '/bin/zsh',
        cwd: process.env.HOME ?? '/',
      });
    }
  } else if (body.url !== undefined) {
    if (p.kind !== 'url') {
      return c.json({ error: { code: 'bad_request', message: 'url can only be set on kind=url panes' } }, 400);
    }
    panes.updateUrl(id, body.url ?? '');
  }
  return c.json(panes.getById(id));
});
```

The handler is the **single** edit path for both URL changes (from the address bar inside a URL pane) and kind flips (from the chrome toggle). Same endpoint, same eventual emission point (Task 14 wires `pane.updated`).

### Step 4: Route + WS tests

Add to `server/src/routes/panes.test.ts`:

```ts
it('PATCH flips shell → url, killing the PTY and updating the row', async () => {
  const tab = await createTab();
  const shellPane = await app.request(`/api/tabs/${tab.id}/panes`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  }).then((r) => r.json());

  // Pre-flip: open a WS so we can assert it gets closed
  // (use whatever WS test helper is conventional in the suite).

  const res = await app.request(`/api/panes/${shellPane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ kind: 'url' }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.kind).toBe('url');
  expect(updated.url).toBeNull();
  expect(updated.shell).toBeNull();
});

it('PATCH flips url → shell with default shell + cwd', async () => {
  const tab = await createTab();
  const urlPane = await app.request(`/api/tabs/${tab.id}/panes`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'url', url: 'https://example.com' }),
    headers: { 'content-type': 'application/json' },
  }).then((r) => r.json());
  const res = await app.request(`/api/panes/${urlPane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ kind: 'shell' }),
    headers: { 'content-type': 'application/json' },
  });
  const updated = await res.json();
  expect(updated.kind).toBe('shell');
  expect(updated.url).toBeNull();
  expect(updated.shell).toBeTruthy();
});

it('PATCH with same kind ignores the kind field', async () => {
  // Flip a url pane "to url again" — should be a no-op on kind, but
  // still honors url field if present.
});
```

In `server/src/ws.test.ts`:

```ts
it('closes attached WSes when a shell pane is flipped to kind=url', async () => {
  // Create shell pane → open WS → PATCH kind=url → assert WS close
  // event with code 4001. Use existing WS test harness.
});
```

### Step 5: UrlPane — handle null/empty URL

In `UrlPane.tsx`, accept `url: string | null` and treat empty/null as "address bar visible, no iframe":

```tsx
export function UrlPane({ paneId, url }: { paneId: string; url: string | null }) {
  const [draft, setDraft] = useState(url ?? '');
  const [committed, setCommitted] = useState(url ?? '');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const next = url ?? '';
    setDraft(next);
    setCommitted(next);
  }, [url]);

  // Empty URL state: autofocus the address bar so the user can type immediately.
  useEffect(() => {
    if (!committed && inputRef.current) inputRef.current.focus();
  }, [committed]);

  const submit = async (raw: string) => {
    const next = normalizeUrl(raw);
    if (!next || next === committed) return;
    setCommitted(next);
    try { await api.patchPane(paneId, { url: next }); } catch (e) { console.error(e); }
  };

  return (
    <div className="url-pane">
      <form className="url-pane-addressbar" onSubmit={(e) => { e.preventDefault(); void submit(draft); }}>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://…"
          onChange={(e) => setDraft(e.target.value)}
          aria-label="URL"
        />
        {committed && (
          <button type="button" className="url-pane-reload" aria-label="Reload" title="Reload"
            onClick={() => { if (iframeRef.current) iframeRef.current.src = committed; }}>↻</button>
        )}
      </form>
      {committed ? (
        <iframe
          ref={iframeRef}
          src={committed}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={committed}
        />
      ) : (
        <div className="url-pane-blank" aria-hidden="true" />
      )}
    </div>
  );
}
```

Add a faint `.url-pane-blank { flex: 1; background: var(--pane-bg, #0a0a0a); }` rule in `UrlPane.css`.

### Step 6: Chrome toggle button + composite key — `TabView.tsx`

Define an SVG pair:

```tsx
function SvgTerminal() {
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="1" y="2" width="12" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 5l2 2-2 2M7 9h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function SvgGlobe() {
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.6 7h10.8M7 1.6c2 1.6 2 9.2 0 10.8M7 1.6c-2 1.6-2 9.2 0 10.8"
        stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}
```

In `renderTile`, before `splitFromPane` buttons, add a toggle. Show the **current** kind's glyph; tooltip says what you'd switch *to*:

```tsx
const pane = tab.panes.find((p) => p.id === paneId);
const isUrl = pane?.kind === 'url';
// …
<button
  className="pane-chrome-btn"
  title={isUrl ? 'Switch to shell pane' : 'Switch to web pane'}
  aria-label={isUrl ? 'Switch to shell pane' : 'Switch to web pane'}
  onClick={async () => {
    await api.patchPane(paneId, { kind: isUrl ? 'shell' : 'url' });
    // Local optimistic update so the UI flips before the next poll.
    setTab((prev) => prev
      ? { ...prev, panes: prev.panes.map((p) => p.id === paneId
          ? { ...p, kind: isUrl ? 'shell' : 'url', url: null, shell: isUrl ? '/bin/zsh' : null }
          : p) }
      : prev);
  }}
>
  {isUrl ? <SvgTerminal /> : <SvgGlobe />}
</button>
```

In the body dispatch (from Task 8), key by `${paneId}-${pane.kind}` so React fully remounts on kind flip:

```tsx
{(() => {
  const p = tab.panes.find((x) => x.id === paneId);
  if (p?.kind === 'url') {
    return <UrlPane key={`${paneId}-url`} paneId={paneId} url={p.url ?? null} />;
  }
  return <XtermPane key={`${paneId}-shell`} paneId={paneId} onExit={() => onPaneExited(paneId)} />;
})()}
```

Mobile branch gets the same dispatch.

### Step 7: Manual verify (end-to-end)

- On a shell pane running `top`: click the globe icon. PTY dies (you see the exit/disconnect in the terminal area briefly), pane becomes URL pane with focused address bar. Type `example.com` + enter. Site loads.
- On the same pane: click the terminal icon. iframe disappears; XtermPane mounts and you get a fresh shell prompt.
- Open the workspace in a second browser tab. Flip kind on one tab; the other tab picks it up within 5s.
- Negative: while a WS is attached to a shell pane, flip its kind. The other browser's xterm shows the WS close (the pane re-renders to URL because of the optimistic update).

### Step 8: Commit

```bash
git add server/src/store/PaneStore.ts server/src/routes/panes.ts server/src/routes/panes.test.ts \
        server/src/ws.ts server/src/ws.test.ts \
        web/src/api.ts web/src/components/UrlPane.tsx web/src/components/UrlPane.css \
        web/src/pages/TabView.tsx
git commit -m "feat: type-switch toggle between shell and url panes"
```

---

## Task 10: `PtyScanner` extension — extract `muxpad;…` OSC events

**Files:**
- Modify: `server/src/runtime/pty-scanner.ts`
- Modify: `server/src/runtime/pty-scanner.test.ts`

**Step 1: Write the failing tests**

Append to `pty-scanner.test.ts`:

```ts
describe('muxpad OSC', () => {
  it('extracts a verb with args (BEL terminator)', () => {
    const s = new PtyScanner();
    const ev = s.feed('\x1b]muxpad;pane-new;cmd=claude;cwd=.\x07');
    expect(ev.muxpadCmd).toEqual({
      verb: 'pane-new',
      args: { cmd: 'claude', cwd: '.' },
    });
    expect(ev.title).toBeUndefined();
    expect(ev.bel).toBe(false); // BEL was consumed by the OSC, not user
  });

  it('extracts a verb with no args (ST terminator)', () => {
    const s = new PtyScanner();
    const ev = s.feed('\x1b]muxpad;tab-new\x1b\\');
    expect(ev.muxpadCmd).toEqual({ verb: 'tab-new', args: {} });
  });

  it('decodes percent-encoded values', () => {
    const s = new PtyScanner();
    const ev = s.feed('\x1b]muxpad;open;url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc\x07');
    expect(ev.muxpadCmd).toEqual({
      verb: 'open',
      args: { url: 'https://example.com/a?b=c' },
    });
  });

  it('strips the muxpad OSC from output (it never reaches the buffer)', () => {
    // The scanner doesn't return raw output, but verify that a title set
    // immediately after a muxpad OSC still parses correctly — i.e. the
    // scanner returns to 'normal' state cleanly.
    const s = new PtyScanner();
    const ev = s.feed('\x1b]muxpad;pane-new\x07\x1b]0;hello\x07');
    expect(ev.muxpadCmd?.verb).toBe('pane-new');
    expect(ev.title).toBe('hello');
  });

  it('handles split-chunk muxpad sequences', () => {
    const s = new PtyScanner();
    expect(s.feed('\x1b]muxpad;pa').muxpadCmd).toBeUndefined();
    expect(s.feed('ne-new\x07').muxpadCmd).toEqual({ verb: 'pane-new', args: {} });
  });

  it('ignores malformed muxpad payload (no verb)', () => {
    const s = new PtyScanner();
    const ev = s.feed('\x1b]muxpad;\x07');
    expect(ev.muxpadCmd).toBeUndefined();
  });
});
```

**Step 2: Run, watch fail**

```bash
pnpm --filter @muxpad/server test -- pty-scanner
```
Expected: FAIL.

**Step 3: Implement**

In `pty-scanner.ts`:

```ts
export interface MuxpadCmd {
  verb: string;
  args: Record<string, string>;
}

export interface ScanEvents {
  bel: boolean;
  title?: string;
  muxpadCmd?: MuxpadCmd;
}
```

In `feed()`, declare `let muxpadCmd: MuxpadCmd | undefined;`. In the OSC-terminated branches (where `parseOscTitle(this.oscBuf)` is called) also try `parseMuxpadCmd(this.oscBuf)`. If it parses, set `muxpadCmd` and **do not** also set `title`. Return `muxpadCmd` in the returned object when defined.

```ts
function parseMuxpadCmd(buf: string): MuxpadCmd | null {
  if (!buf.startsWith('muxpad;')) return null;
  const rest = buf.slice('muxpad;'.length);
  // rest = "<verb>" or "<verb>;k=v;k=v…"
  const parts = rest.split(';');
  const verb = parts[0];
  if (!verb) return null;
  const args: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i]!.indexOf('=');
    if (eq < 0) continue;
    const k = parts[i]!.slice(0, eq);
    const raw = parts[i]!.slice(eq + 1);
    try {
      args[k] = decodeURIComponent(raw);
    } catch {
      args[k] = raw;
    }
  }
  return { verb, args };
}
```

Update `parseOscTitle` to return `null` if buf starts with `muxpad;` so it doesn't accidentally treat it as a title.

**Step 4: Verify**

```bash
pnpm --filter @muxpad/server test -- pty-scanner
```
Expected: PASS. Full server suite still green.

**Step 5: Commit**

```bash
git add server/src/runtime/pty-scanner.ts server/src/runtime/pty-scanner.test.ts
git commit -m "feat(server): PtyScanner extracts muxpad OSC commands"
```

---

## Task 11: `PaneRuntime` dispatches muxpad commands

**Files:**
- Modify: `server/src/runtime/PaneRuntime.ts`
- Modify: `server/src/runtime/PaneManager.ts` (wire a callback through so dispatch can reach the store/manager without circular imports)

**Step 1: Design**

`PaneRuntime` does not (and should not) import the store directly. Add an optional callback to `PaneRuntimeSpec` or `PaneManager` options:

```ts
// In PaneManager opts
onMuxpadCmd?: (sourcePaneId: string, cmd: MuxpadCmd) => Promise<void> | void;
```

`PaneManager` passes `(id, cmd) => this.opts.onMuxpadCmd?.(id, cmd)` into each runtime as a constructor option, and `PaneRuntime` calls it from the scanner output callback when `ev.muxpadCmd` is set.

The actual dispatcher lives outside the runtime (in a new file `server/src/runtime/muxpad-dispatch.ts`) and is wired from `server/src/index.ts` where the manager is instantiated — that's where both `PaneStore` and `TabStore` are already in scope.

**Step 2: Implement the runtime hook**

In `PaneRuntime.ts`, in the scanner output callback (~line 132):

```ts
this.process.onData((data) => {
  const ev = this.scanner.feed(data);
  if (ev.bel && !this.needsAttention) this.needsAttention = true;
  if (ev.title !== undefined) this.currentTitle = ev.title;
  if (ev.muxpadCmd) this.emit('muxpad-cmd', ev.muxpadCmd);
  this.buffer.push(data);
  this.emit('output', data);
});
```

Add to the typed `on`/`off` overloads:

```ts
override on(event: 'muxpad-cmd', listener: Listener<[MuxpadCmd]>): this;
```

In `PaneManager.ts`, in `getOrCreate` after a runtime is created, attach a listener:

```ts
runtime.on('muxpad-cmd', (cmd) => {
  void this.opts.onMuxpadCmd?.(spec.id, cmd);
});
```

**Step 3: Implement the dispatcher**

`server/src/runtime/muxpad-dispatch.ts` (new). CLI-spawned panes always split **to the right** of the source pane — no `split` arg from the CLI surface. Task 14 will instrument this file with event emissions; Phase 1 relies on the 5s poll.

```ts
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import type { MuxpadCmd } from './pty-scanner.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import type { PaneManager } from './PaneManager.js';
import type { LayoutNode } from '@muxpad/shared';

const defaultShell = process.env.SHELL ?? '/bin/zsh';

export function makeMuxpadDispatcher(deps: {
  db: Database.Database;
  paneManager: PaneManager;
}) {
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  const workspaces = new WorkspaceStore(deps.db);

  return async function dispatch(sourcePaneId: string, cmd: MuxpadCmd): Promise<void> {
    const source = panes.getById(sourcePaneId);
    if (!source) return;
    const tab = tabs.getById(source.tab_id);
    if (!tab) return;
    const workspaceId = (
      deps.db.prepare('SELECT workspace_id FROM tabs WHERE id = ?').get(tab.id) as
        | { workspace_id: string }
        | undefined
    )?.workspace_id;
    switch (cmd.verb) {
      case 'pane-new': {
        const live = deps.paneManager.get(sourcePaneId)?.getCurrentCwd();
        const cwd = cmd.args.cwd ?? live ?? source.cwd ?? homedir();
        const created = panes.create({
          tab_id: tab.id,
          kind: 'shell',
          shell: defaultShell,
          cwd,
          startup_cmd: cmd.args.cmd ?? null,
        });
        appendToLayout(tabs, tab.id, tab.layout, sourcePaneId, created.id);
        return;
      }
      case 'open': {
        const url = cmd.args.url;
        if (!url) return;
        const created = panes.create({ tab_id: tab.id, kind: 'url', url });
        appendToLayout(tabs, tab.id, tab.layout, sourcePaneId, created.id);
        return;
      }
      case 'tab-new': {
        if (!workspaceId) return;
        tabs.create({ workspace_id: workspaceId, name: cmd.args.name ?? 'tab' });
        return;
      }
      case 'workspace-new': {
        workspaces.create({ name: cmd.args.name ?? 'workspace' });
        // New workspace starts empty; user navigates to it via the
        // workspace switcher when they want to.
        return;
      }
      default:
        return;
    }
  };
}

function appendToLayout(
  tabs: TabStore,
  tabId: string,
  current: LayoutNode,
  sourcePaneId: string,
  newId: string,
): void {
  // CLI verbs always split-right of the source pane.
  const next = splitAt(current, sourcePaneId, newId);
  tabs.update(tabId, { layout: next });
}

function splitAt(node: LayoutNode, target: string, newId: string): LayoutNode {
  if (node === '' || node == null) return newId;
  if (typeof node === 'string') {
    return node === target ? { direction: 'row', first: node, second: newId } : node;
  }
  return {
    ...node,
    first: splitAt(node.first, target, newId),
    second: splitAt(node.second, target, newId),
  };
}
```

(If `WorkspaceStore.create()` has a different signature than `{ name }`, adapt — the goal is "create an empty workspace at the end of the list with this name." Don't grow store APIs unnecessarily.)

Wire it in `server/src/index.ts` where `PaneManager` is constructed:

```ts
let dispatcher: ((sourceId: string, cmd: MuxpadCmd) => Promise<void>) | undefined;
const paneManager = new PaneManager({
  // existing opts…
  onMuxpadCmd: (sourceId, cmd) => dispatcher?.(sourceId, cmd),
});
dispatcher = makeMuxpadDispatcher({ db, paneManager });
```

The `let dispatcher` + late-assign pattern resolves the chicken-and-egg between `PaneManager` (needs the callback) and `makeMuxpadDispatcher` (needs the manager). Task 14 widens the `makeMuxpadDispatcher` deps to include the `EventBus`.

**Step 4: Tests**

Add `server/src/runtime/muxpad-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../store/migrations.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { PaneManager } from './PaneManager.js';
import { makeMuxpadDispatcher } from './muxpad-dispatch.js';

describe('muxpad dispatcher', () => {
  let db: Database.Database;
  let panes: PaneStore;
  let tabs: TabStore;
  let manager: PaneManager;
  let dispatch: ReturnType<typeof makeMuxpadDispatcher>;
  let source: { id: string; tab_id: string };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES ('w', 'w', 'w', 0, 0, 0)`).run();
    db.prepare(`INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES ('t', 't', 't', '', 'w', 0, 0, 0)`).run();
    panes = new PaneStore(db);
    tabs = new TabStore(db);
    const created = panes.create({ tab_id: 't', kind: 'shell', shell: '/bin/sh', cwd: '/tmp' });
    source = { id: created.id, tab_id: 't' };
    // Update layout root to the source pane so splits target it.
    tabs.update('t', { layout: source.id });
    manager = new PaneManager({});
    dispatch = makeMuxpadDispatcher({ db, paneManager: manager });
  });

  it('pane-new creates a shell pane and splits the layout', async () => {
    await dispatch(source.id, { verb: 'pane-new', args: { cmd: 'vim' } });
    const all = panes.listByTab('t');
    expect(all).toHaveLength(2);
    const created = all.find((p) => p.id !== source.id)!;
    expect(created.kind).toBe('shell');
    expect(created.startup_cmd).toBe('vim');
    expect(tabs.getById('t')!.layout).toMatchObject({ direction: 'row', first: source.id, second: created.id });
  });

  it('open creates a url pane', async () => {
    await dispatch(source.id, { verb: 'open', args: { url: 'https://x' } });
    const url = panes.listByTab('t').find((p) => p.kind === 'url');
    expect(url?.url).toBe('https://x');
  });

  it('tab-new creates a sibling tab', async () => {
    await dispatch(source.id, { verb: 'tab-new', args: { name: 'logs' } });
    const all = tabs.listByWorkspace('w');
    expect(all.map((t) => t.name)).toContain('logs');
  });

  it('workspace-new creates a new workspace', async () => {
    await dispatch(source.id, { verb: 'workspace-new', args: { name: 'side-project' } });
    const ws = new WorkspaceStore(db).list();
    expect(ws.map((w) => w.name)).toContain('side-project');
  });

  it('ignores unknown verbs', async () => {
    await dispatch(source.id, { verb: 'nope', args: {} });
    expect(panes.listByTab('t')).toHaveLength(1);
  });
});
```

**Step 5: Verify**

```bash
pnpm --filter @muxpad/server test
```
Expected: PASS.

**Step 6: Commit**

```bash
git add server/src/runtime/PaneRuntime.ts server/src/runtime/PaneManager.ts server/src/runtime/muxpad-dispatch.ts server/src/runtime/muxpad-dispatch.test.ts server/src/index.ts
git commit -m "feat(server): dispatch muxpad OSC commands (pane-new, open, tab-new)"
```

---

## Task 12: Env injection — `MUXPAD_BIN` + `PATH` for spawned shells

**Files:**
- Modify: `server/src/runtime/PaneRuntime.ts`

**Step 1: Implement**

In `start()`, after the `env` object is built:

```ts
// Repo root resolves from this file's location: server/src/runtime/PaneRuntime.ts
// → repoRoot = ../../.. (server dir, then up to repo root). Use process.cwd()
// if the daemon is started via scripts/muxpad (which it always is in
// production); falls back to a sensible default in dev (`pnpm dev` from repo root).
const scriptsDir = path.resolve(process.cwd(), 'scripts');
env.MUXPAD_BIN = path.join(scriptsDir, 'muxpad');
env.PATH = `${scriptsDir}:${env.PATH ?? ''}`;
```

(`import path from 'node:path'` at top of file.)

**Step 2: Manual verify**

Restart the dev server, open a new pane, run:

```sh
echo $MUXPAD_BIN
which muxpad
```

Expected: `MUXPAD_BIN` points at `…/scripts/muxpad`, and `which muxpad` resolves to the same path.

**Step 3: Commit**

```bash
git add server/src/runtime/PaneRuntime.ts
git commit -m "feat(server): expose MUXPAD_BIN + scripts/ on PATH in spawned shells"
```

---

## Task 13: Extend `scripts/muxpad` with `pane`, `tab`, `workspace`, `open` subcommands

**Files:**
- Modify: `scripts/muxpad`

**Step 1: Implement**

Add a new function and dispatch arm. The existing daemon-control verbs (`start`, `stop`, `restart`, `status`, `logs`) stay unchanged.

```bash
emit_osc() {
  # Args: $1 = verb, remaining = "key=value" tokens
  # Emits: ESC ] muxpad ; verb [; key=urlencoded-value]… BEL
  if [ -z "${MUXPAD_BIN:-}" ]; then
    echo "muxpad: in-pane commands only work inside a muxpad pane" >&2
    exit 1
  fi
  local verb="$1"; shift
  printf '\033]muxpad;%s' "$verb"
  for kv in "$@"; do
    local k="${kv%%=*}"
    local v="${kv#*=}"
    # Minimal URL encoding: pass through [A-Za-z0-9._~-/:], encode the rest.
    local enc
    enc="$(printf %s "$v" | LC_ALL=C awk 'BEGIN{
      for (i=0;i<256;i++) ord[sprintf("%c",i)]=i
    }
    { n=length($0); for (i=1;i<=n;i++) {
        c=substr($0,i,1); o=ord[c]
        if ((o>=48&&o<=57)||(o>=65&&o<=90)||(o>=97&&o<=122)||c=="-"||c=="_"||c=="."||c=="~"||c=="/"||c==":") printf "%s", c
        else printf "%%%02X", o
      } }')"
    printf ';%s=%s' "$k" "$enc"
  done
  printf '\007'
}

cmd_pane() {
  case "${1:-}" in
    new)
      shift
      emit_osc pane-new "$@"
      ;;
    *)
      echo "usage: muxpad pane new [cmd=…] [cwd=…]" >&2
      exit 1
      ;;
  esac
}

cmd_tab() {
  case "${1:-}" in
    new)
      shift
      emit_osc tab-new "$@"
      ;;
    *)
      echo "usage: muxpad tab new [name=…]" >&2
      exit 1
      ;;
  esac
}

cmd_workspace() {
  case "${1:-}" in
    new)
      shift
      emit_osc workspace-new "$@"
      ;;
    *)
      echo "usage: muxpad workspace new [name=…]" >&2
      exit 1
      ;;
  esac
}

cmd_open() {
  if [ $# -lt 1 ]; then
    echo "usage: muxpad open <url>" >&2
    exit 1
  fi
  local url="$1"
  emit_osc open "url=$url"
}
```

Update the dispatch at the bottom:

```bash
case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  pane) shift; cmd_pane "$@" ;;
  tab) shift; cmd_tab "$@" ;;
  workspace) shift; cmd_workspace "$@" ;;
  open) shift; cmd_open "$@" ;;
  *)
    echo "usage: $(basename "$0") {start|stop|restart|status|logs|pane|tab|workspace|open}" >&2
    exit 1
    ;;
esac
```

**Step 2: Manual verify (end-to-end)**

Restart the dev server. In an existing pane:

```sh
muxpad pane new cmd=top
```

Expected: within ~5s a new pane appears to the right of the current one, running `top`.

```sh
muxpad open https://example.com
```

Expected: a URL pane appears to the right of the current pane within ~5s, loading `example.com`.

```sh
muxpad tab new name=logs
```

Expected: a new tab `logs` appears in the tab bar within ~5s (empty).

```sh
muxpad workspace new name=side-project
```

Expected: a new workspace `side-project` appears in the workspace switcher within ~5s. Navigate to it manually; it's empty until you create tabs/panes.

(Task 14 makes all of the above instant.)

**Step 3: Commit**

```bash
git add scripts/muxpad
git commit -m "feat(cli): muxpad {pane,tab,workspace,open} subcommands via PTY OSC"
```

---

## Task 14: App-level events WebSocket — push structural changes to all browser tabs

Converts the 5s `getTab` poll to push. Single `/ws/events` socket per browser tab, server broadcasts typed events on every mutation, clients merge into existing caches. Largest task in the plan; budget half a day. Touches every mutation route and `PaneManager`.

**Strategy: hybrid mode for one commit.** Sub-tasks 14a-14d ship the events socket *alongside* the existing 5s poll. Manually verify both paths produce the same UI. Then sub-task 14e is a single commit that removes the poll. If 14e proves anything was missed, revert the single commit and patch.

**Files (whole task):**
- Modify: `shared/src/types.ts` (add `MuxpadEventSchema` union)
- Create: `server/src/events.ts` (EventBus)
- Create: `server/src/events.test.ts`
- Modify: `server/src/ws.ts` (mount `/ws/events`)
- Modify: `server/src/index.ts` (instantiate bus, thread to routes + dispatcher)
- Modify: every file under `server/src/routes/` (emit on mutations)
- Modify: `server/src/runtime/muxpad-dispatch.ts` (accept `events` dep; emit pane.added / tab.added / tab.updated)
- Modify: `server/src/runtime/PaneManager.ts` (diff-emit title/foreground_cmd)
- Modify: `server/src/runtime/PaneManager.test.ts` (the 3-signal test)
- Create: `web/src/events.ts` (singleton subscriber + reconnect)
- Modify: `web/src/main.tsx` (open socket on boot)
- Modify: `web/src/tabs.ts`, `web/src/workspaces.ts` (drive caches off events)
- Modify: `web/src/pages/TabView.tsx` (subscribe to events; final removal of the 5s poll in 14e)

### Sub-task 14a: Shared event types

Add `MuxpadEventSchema` to `shared/src/types.ts`:

```ts
export const PaneAddedEventSchema = z.object({ type: z.literal('pane.added'), tab_id: z.string(), pane: PaneSpecSchema });
export const PaneRemovedEventSchema = z.object({ type: z.literal('pane.removed'), tab_id: z.string(), pane_id: z.string() });
export const PaneUpdatedEventSchema = z.object({ type: z.literal('pane.updated'), tab_id: z.string(), pane: PaneSpecSchema });
export const TabAddedEventSchema = z.object({ type: z.literal('tab.added'), workspace_id: z.string(), tab: TabSchema });
export const TabUpdatedEventSchema = z.object({ type: z.literal('tab.updated'), tab: TabSchema });
export const TabRemovedEventSchema = z.object({ type: z.literal('tab.removed'), workspace_id: z.string(), tab_id: z.string() });
export const WorkspaceAddedEventSchema = z.object({ type: z.literal('workspace.added'), workspace: WorkspaceSchema });
export const WorkspaceUpdatedEventSchema = z.object({ type: z.literal('workspace.updated'), workspace: WorkspaceSchema });
export const WorkspaceRemovedEventSchema = z.object({ type: z.literal('workspace.removed'), workspace_id: z.string() });

export const MuxpadEventSchema = z.discriminatedUnion('type', [
  PaneAddedEventSchema, PaneRemovedEventSchema, PaneUpdatedEventSchema,
  TabAddedEventSchema, TabUpdatedEventSchema, TabRemovedEventSchema,
  WorkspaceAddedEventSchema, WorkspaceUpdatedEventSchema, WorkspaceRemovedEventSchema,
]);
export type MuxpadEvent = z.infer<typeof MuxpadEventSchema>;
```

Build + commit:
```bash
pnpm --filter @muxpad/shared build
git add shared/src/types.ts shared/dist
git commit -m "feat(shared): MuxpadEvent union for /ws/events"
```

### Sub-task 14b: Server EventBus + /ws/events endpoint

Failing test in `server/src/events.test.ts`:

```ts
describe('EventBus', () => {
  it('broadcasts to all subscribers', () => {
    const bus = new EventBus();
    const received: MuxpadEvent[][] = [[], []];
    const u1 = bus.subscribe((e) => received[0]!.push(e));
    const u2 = bus.subscribe((e) => received[1]!.push(e));
    bus.emit({ type: 'tab.removed', workspace_id: 'w', tab_id: 't' });
    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(1);
    u1();
    bus.emit({ type: 'tab.removed', workspace_id: 'w', tab_id: 't2' });
    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(2);
    u2();
  });

  it('subscriber errors do not stop other subscribers', () => {
    const bus = new EventBus();
    let okCalls = 0;
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe(() => { okCalls++; });
    bus.emit({ type: 'workspace.removed', workspace_id: 'w' });
    expect(okCalls).toBe(1);
  });
});
```

`server/src/events.ts`:

```ts
import type { MuxpadEvent } from '@muxpad/shared';

type Listener = (event: MuxpadEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: MuxpadEvent): void {
    for (const l of this.listeners) {
      try { l(event); } catch (err) { console.error('EventBus listener threw', err); }
    }
  }
}
```

Mount `/ws/events` in `server/src/ws.ts` (before the per-pane upgrade match):

```ts
if (url.pathname === '/ws/events') {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const unsub = deps.events.subscribe((e) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
    });
    ws.on('close', unsub);
    ws.on('error', unsub);
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });
  });
  return;
}
```

In `server/src/index.ts`, instantiate `const events = new EventBus()` and thread it into route factories + `setupWs({ ..., events })` + `makeMuxpadDispatcher({ ..., events })`.

Commit:
```bash
git add server/src/events.ts server/src/events.test.ts server/src/ws.ts server/src/index.ts
git commit -m "feat(server): /ws/events broadcast endpoint + EventBus"
```

### Sub-task 14c: Emit from every mutation site

Wire `events.emit(...)` next to every mutation in routes + dispatcher. Cover:

- `POST /api/tabs/:id/panes`: `pane.added`
- `DELETE /api/panes/:id`: `pane.removed`
- `PATCH /api/panes/:id`: `pane.updated` (both the URL-change path and the kind-flip path from Task 9 emit the same event)
- `POST /api/workspaces/.../tabs` (tab create): `tab.added`
- `PATCH /api/tabs/:id`: `tab.updated`
- `DELETE /api/tabs/:id`: `tab.removed` (no cascade pane.removed — clients infer)
- `POST /api/tabs/reorder`: a coarse `workspace.updated` (or per-tab `tab.updated`, pick the cheaper one)
- `POST /api/workspaces`, `PATCH /api/workspaces/:id`, `DELETE /api/workspaces/:id`: matching workspace events
- `muxpad-dispatch.ts`: `pane.added` + `tab.updated` for pane-new/open; `tab.added` for tab-new; `workspace.added` for workspace-new

Each is a one-liner adjacent to the existing `return c.json(...)`. Run the full server test suite — should still pass (existing tests have no subscribers so emissions are no-ops).

Commit:
```bash
git add server/src/routes server/src/runtime/muxpad-dispatch.ts
git commit -m "feat(server): emit events from every mutation site"
```

### Sub-task 14d: PaneManager diff-emit for title / foreground_cmd / attention (and the 3-signal test)

This is the soft-spot mitigation: the three signals that today flow through GET decoration need explicit emissions when they change. Write the test first.

`server/src/runtime/PaneManager.test.ts`:

```ts
describe('PaneManager → events bus', () => {
  it('emits pane.updated when title changes (OSC 0/1/2)', async () => {
    const events = new EventBus();
    const seen: MuxpadEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const mgr = new PaneManager({ events, /* …other deps… */ });
    // Use whatever harness creates a pane + runtime and feeds bytes
    // through it. Push '\x1b]0;new-title\x07' through the runtime.
    // …
    await flushTimers();
    const titleEvents = seen.filter((e) => e.type === 'pane.updated' && e.pane.title === 'new-title');
    expect(titleEvents.length).toBeGreaterThan(0);
  });

  it('emits pane.updated when foreground_cmd changes', async () => { /* … */ });
  it('emits pane.updated when attention flips on BEL', async () => { /* … */ });
});
```

In `PaneManager.ts`, alongside the existing 3s fg poll loop, add diffed emission:

```ts
private lastTitle = new Map<string, string | null>();
private lastFg = new Map<string, string | null>();
private lastAttention = new Map<string, boolean>();

private emitDecorations(): void {
  if (!this.opts.events) return;
  for (const [id, runtime] of this.runtimes) {
    const title = runtime.getCurrentTitle() ?? null;
    const fg = this.lastFgCache.get(id) ?? null;
    const attention = runtime.getNeedsAttention();
    if (
      this.lastTitle.get(id) !== title ||
      this.lastFg.get(id) !== fg ||
      this.lastAttention.get(id) !== attention
    ) {
      this.lastTitle.set(id, title);
      this.lastFg.set(id, fg);
      this.lastAttention.set(id, attention);
      const pane = this.panes.getById(id);
      if (pane) {
        this.opts.events.emit({
          type: 'pane.updated',
          tab_id: pane.tab_id,
          pane: { ...pane, title, foreground_cmd: fg },
        });
      }
    }
  }
}
```

Call `emitDecorations()` at the end of the existing 3s fg poll tick and at the end of any code path that flips `needsAttention` (BEL detection in `PaneRuntime.onData`). For BEL, the cleanest hook is: when `scanner.feed()` returns `bel === true` and the runtime flips `needsAttention=true`, emit immediately rather than wait for the next tick. Add a `attentionChanged` listener on the runtime if you want clean separation.

`PaneManager` constructor needs `events: EventBus` and `panes: PaneStore` in its opts (it currently takes neither — small surgery in `index.ts`).

Commit:
```bash
git add server/src/runtime/PaneManager.ts server/src/runtime/PaneManager.test.ts server/src/index.ts
git commit -m "feat(server): emit pane.updated on title/fg/attention changes"
```

### Sub-task 14e: Client subscriber + hybrid verification + remove the 5s poll

Client side `web/src/events.ts`:

```ts
import { MuxpadEventSchema, type MuxpadEvent } from '@muxpad/shared';

type Handler = (e: MuxpadEvent) => void;
let ws: WebSocket | null = null;
const handlers = new Set<Handler>();
let reconnectDelayMs = 250;
let onReconnectCb: (() => void) | null = null;

function endpoint() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/events`;
}
function connect() {
  ws = new WebSocket(endpoint());
  ws.onopen = () => { reconnectDelayMs = 250; onReconnectCb?.(); };
  ws.onmessage = (m) => {
    try {
      const e = MuxpadEventSchema.parse(JSON.parse(m.data));
      for (const h of handlers) h(e);
    } catch (err) { console.warn('bad event payload', err); }
  };
  ws.onclose = () => { ws = null; setTimeout(connect, reconnectDelayMs); reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000); };
  ws.onerror = () => ws?.close();
}
export function startEvents(opts: { onReconnect?: () => void } = {}) {
  if (ws) return;
  onReconnectCb = opts.onReconnect ?? null;
  connect();
}
export function subscribe(handler: Handler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
```

Open in `web/src/main.tsx`:

```ts
startEvents({ onReconnect: () => void refreshWorkspaces() });
subscribe((e) => {
  switch (e.type) {
    case 'workspace.added':
    case 'workspace.updated':
    case 'workspace.removed':
      void refreshWorkspaces(); return;
    case 'tab.added':
    case 'tab.removed':
      void refreshTabs(e.workspace_id); return;
    case 'tab.updated':
      void refreshWorkspaces(); return;  // refreshes active workspace's tabs cache
    case 'pane.added':
    case 'pane.removed':
    case 'pane.updated':
      return;  // TabView subscribes directly to merge these into local tab.panes
  }
});
```

In `TabView.tsx`, add an event subscription (in addition to the existing poll — this is the hybrid step):

```tsx
useEffect(() => {
  if (!tab) return;
  return subscribe((e) => {
    if (e.type === 'pane.added' && e.tab_id === tab.id) {
      setTab((prev) => prev && prev.panes.some((p) => p.id === e.pane.id)
        ? prev
        : prev ? { ...prev, panes: [...prev.panes, e.pane] } : prev);
    } else if (e.type === 'pane.removed' && e.tab_id === tab.id) {
      setTab((prev) => prev ? { ...prev, panes: prev.panes.filter((p) => p.id !== e.pane_id) } : prev);
    } else if (e.type === 'pane.updated' && e.tab_id === tab.id) {
      setTab((prev) => prev ? { ...prev, panes: prev.panes.map((p) => p.id === e.pane.id ? e.pane : p) } : prev);
    } else if (e.type === 'tab.updated' && e.tab.id === tab.id) {
      setTab((prev) => prev ? {
        ...prev,
        name: e.tab.name, slug: e.tab.slug, layout: e.tab.layout,
        attention: e.tab.attention, updated_at: e.tab.updated_at,
      } : prev);
      layoutRef.current = toMosaic(e.tab.layout);
    } else if (e.type === 'tab.removed' && e.tab_id === tab.id) {
      setClosingTab(true);
      void navigate({ to: '/w/$wsSlug', params: { wsSlug } });
    }
  });
}, [tab?.id, navigate, wsSlug]);
```

**Manual hybrid verification (mandatory before the next commit):**

- All Phase 1 manual tests still pass with both poll and events live.
- Open two browser tabs. Create / delete / rename / flip-kind via UI in one tab; the other tab should react **within ~250ms** (events) rather than ~5s (poll). If both behaviors are present and indistinguishable in correctness, the events path is healthy.
- From a shell pane, `muxpad open https://example.com` → URL pane shows up within ~250ms in both tabs.
- Restart the dev server; the events socket reconnects within ~1-2s; UI is correct after.
- All three signals (title, foreground_cmd, attention/BEL) update via events within ~3s of changing.

If anything looks wrong, fix BEFORE proceeding. The poll is your safety net.

**Now remove the poll** — separate commit, easy revert:

In `TabView.tsx` remove the `pollTimer` / `setInterval` block + the `refreshDetail` helper from the load effect. Title/fg/attention now flow exclusively via `pane.updated` events.

```bash
git add web/src/events.ts web/src/main.tsx web/src/pages/TabView.tsx
git commit -m "feat(web): /ws/events client + TabView subscribes (hybrid)"

# After manual verification:
git add web/src/pages/TabView.tsx
git commit -m "refactor(web): remove TabView 5s poll, rely on /ws/events"
```

---

## Task 15: Document for Claude Code (optional, low priority)

**Files:**
- Modify: `~/.claude/CLAUDE.md` (user-level, not in repo) — or skip if user prefers.

Drop a short section:

```md
## Environment: muxpad
If `$MUXPAD_BIN` is set, you're running inside a muxpad pane. Available:
- `muxpad pane new [cmd=…] [cwd=…]`   spawn a sibling shell pane (always to the right)
- `muxpad tab new [name=…]`           new empty tab in this workspace
- `muxpad open <url>`                 open a URL iframe pane to the right

Use when something long-running would block flow if run here (watchers,
dev servers, log tails). Don't spawn pre-emptively; only when the user
asks or when blocking would interrupt the flow.
```

No commit (file lives outside repo).

---

## Verification checklist before merging

**Phase 1 (Tasks 1-13) — URL panes + CLI, against the 5s poll:**

- [ ] `pnpm test` (all packages) green.
- [ ] `pnpm lint` clean.
- [ ] Manual: type-switch toggle: click globe on a shell pane → PTY dies, address bar focused; type URL, submit, iframe loads. Click terminal on a URL pane → shell prompt appears.
- [ ] Manual: URL pane persists across browser reload; address-bar edit persists; close removes from layout.
- [ ] Manual: from a shell pane, `muxpad pane new cmd=top` spawns a sibling shell pane to the right within ~5s.
- [ ] Manual: `muxpad open https://example.com` spawns a URL pane to the right within ~5s.
- [ ] Manual: `muxpad tab new name=logs` adds a new tab within ~5s.
- [ ] Manual: `muxpad workspace new name=foo` adds a new workspace within ~5s.
- [ ] Manual: `muxpad open https://github.com` shows a refused-to-frame page. Expected; X-Frame-Options out-of-scope.
- [ ] Server restart: existing panes (shell + URL) survive; CLI works in newly spawned panes (env injection is per-spawn).
- [ ] Negative: WS connection to `/ws/pane/<url-pane-id>` is rejected.
- [ ] Negative: `POST /tabs/:id/panes` with `kind=url` and no `url` returns 400.
- [ ] Negative: while a WS is attached to a shell pane, flip its kind to URL — WS closes cleanly with code 4001.

**Phase 2 (Task 14) — events socket:**

- [ ] All Phase 1 manual tests still pass after the hybrid step (both poll + events live).
- [ ] Manual: open two browser tabs on the same workspace; every UI- or CLI-driven change reflects in the other tab within ~250ms.
- [ ] Manual: kill and restart the dev server; events socket reconnects within ~1-2s; UI re-syncs.
- [ ] After the poll-removal commit (14e final): repeat all Phase 1 manual tests with only the events socket.
- [ ] Manual: title/foreground_cmd/attention all flow via events within ~3s of changing (the three soft-spot signals).

## Deliberately out of scope

- Reverse-proxy header rewriting for X-Frame-Options bypass.
- MCP-server upgrade of the CLI.
- CLI-side split direction control (always right; UI keeps both right/down buttons).
- CLI editing of existing panes/tabs/workspaces. CLI is creators-only (`pane new`, `tab new`, `workspace new`, `open`). All editing/renaming/type-switching is UI.
- Per-URL-pane refresh keyboard shortcut (we ship an inline reload button instead).
- Rename URL panes from the tab bar (we infer the hostname automatically).
- Per-pane attention API extension (URL panes never need attention).
- Per-event delivery guarantees: events are best-effort. On reconnect the client refetches workspaces; per-tab data rehydrates lazily when a route mounts. Events lost during a disconnect window are tolerated.
- Confirmation dialogs on type-switch. Lossy is acceptable; one click to flip back.
- Preserving the previous URL when toggling URL → shell. We can add a `last_url` column if it bites.

## Risk / known gotchas

- **`tsx watch` restarts kill all PTYs.** Batch server changes per commit and accept it. The events WS will reconnect automatically — no UI refresh needed.
- **`muxpad` script name collision** with the existing daemon-control script — resolved by extending the same script with new subcommands.
- **Type-switch is lossy.** shell → URL kills the PTY; URL → shell discards the URL. No confirm. User-initiated, one-click reversible. If it bites, add a confirm prompt for "shell with non-default foreground process" cases.
- **WS lifecycle on kind flip** — covered by Task 9's explicit `closePaneClients(id)` call before mutation, plus the composite React key (`${paneId}-${kind}`) that forces a clean remount on both client and server. Manual verify in Task 9 step 7 exercises this.
- **Race on tab layout** if a user is dragging panes around the exact moment the CLI inserts a new pane. With the events socket the race window is tiny (milliseconds), but server-side `tabs.update({ layout })` from the dispatcher can still overwrite an in-flight drag. Acceptable for v1.
- **Event ordering across origins.** A pane created by the dispatcher emits `pane.added` then `tab.updated`. Subscribers should be idempotent (merge by id; ignore duplicates) so the order doesn't matter and an echoed self-update is harmless. The sketches in Task 14e already are.
- **Events soft spots** (title / foreground_cmd / attention) — covered by Task 14d's diff-emit in `PaneManager` + the focused 3-signal test. Hybrid mode in Task 14e (poll + events together for one commit) is the final safety net.
- **OSC payload size cap** in `pty-scanner.ts` is 2048. URLs longer than ~2000 chars will be silently dropped. Acceptable.
- **Wrapper script encoding** uses `awk` for URL encoding. If the host doesn't have a POSIX `awk` available the script breaks — macOS and every Linux distro ships one, so fine.
- **Unverified file path assumptions.** The plan assumes `web/src/main.tsx`, `web/src/tabs.ts`, `web/src/workspaces.ts`, and `WorkspaceStore.create({ name })` exist as referenced. Grep before trusting; adapt if shapes differ. Risk is small but non-zero.
