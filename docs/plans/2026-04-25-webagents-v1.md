# webagents v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a self-hosted browser-based terminal host that replaces ssh+zellij — Node daemon owns PTYs and serves a React app where each browser tab is a workspace with a tree of native-DOM xterm.js panes, with full clipboard support (image paste, text paste, copy, OSC 52).

**Architecture:** Single Node 22 process on the Mac mini owns HTTP/WS, all PTYs (`node-pty`), and a SQLite store of workspace specs. React frontend uses `react-mosaic-component` for the split tree and `xterm.js` for terminals. PTY runtime state is in-memory only — workspace specs persist; PTYs respawn from spec after daemon restart. Tailscale bind, no auth.

**Tech Stack:** Node 22 + TypeScript monorepo (`server/`, `web/`, `shared/`); `hono` (HTTP), `ws` (WebSocket), `node-pty`, `better-sqlite3`, `zod`. React + Vite + `xterm.js` + `@xterm/addon-fit` + `@xterm/addon-clipboard` + `react-mosaic-component` + TanStack Router. Vitest for unit/integration; Playwright for e2e. launchd for service.

**Reference design:** see `docs/plans/2026-04-25-webagents-design.md` for the full design — tasks below assume that document's data model and decisions.

---

## How to use this plan

- Each task is small and self-contained. Run them in order.
- TDD is used for backend logic (`shared/`, `server/store/`, `server/runtime/`) where it pays off. Frontend integration tasks are validated by Playwright e2e at the milestone boundaries.
- Commit after every passing step. Never batch commits across tasks.
- After every task, run the **whole** test suite, not just the new tests. If something breaks, fix it before moving on.
- File paths are absolute relative to `/Users/you/Dropbox/Computer/MyDev/2025/webagents`.

---

## Milestone 0 — Repo bootstrap

### Task 0.1: Initialize git repo

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Create: `LICENSE` (MIT)

**Step 1:** Initialize git.

```bash
cd /Users/you/Dropbox/Computer/MyDev/2025/webagents
git init -b main
```

**Step 2:** Write `.gitignore`:

```
node_modules/
dist/
.DS_Store
*.log
.env
.env.local
~/.muxpad/
coverage/
.vite/
playwright-report/
test-results/
```

**Step 3:** Write a minimal `README.md`:

```markdown
# webagents

Self-hosted browser terminal host. See `docs/plans/2026-04-25-webagents-design.md`.
```

**Step 4:** Add MIT `LICENSE` (year 2026, holder: the user).

**Step 5:** Commit.

```bash
git add .gitignore README.md LICENSE docs/
git commit -m "chore: initial commit with design doc"
```

---

### Task 0.2: pnpm workspace + root package.json

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.nvmrc`

**Step 1:** Verify Node and pnpm.

```bash
node --version   # expect v22.x
corepack enable
pnpm --version   # expect 9.x or newer
```

If pnpm missing: `corepack prepare pnpm@latest --activate`.

**Step 2:** Write `.nvmrc`: `22`.

**Step 3:** Write `pnpm-workspace.yaml`:

```yaml
packages:
  - "shared"
  - "server"
  - "web"
```

**Step 4:** Write root `package.json`:

```json
{
  "name": "webagents",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "dev": "pnpm -r --parallel dev"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@biomejs/biome": "^1.9.0"
  },
  "packageManager": "pnpm@9.12.0"
}
```

**Step 5:** Write `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "lib": ["ES2022"]
  }
}
```

**Step 6:** `pnpm install` (will succeed with no packages yet — generates the lockfile).

**Step 7:** Commit.

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .nvmrc
git commit -m "chore: pnpm workspace scaffold"
```

---

### Task 0.3: Biome config

**Files:**
- Create: `biome.json`

**Step 1:** Write `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "files": { "ignore": ["dist", "node_modules", "coverage"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true, "style": { "noNonNullAssertion": "off" } }
  },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } }
}
```

**Step 2:** Verify it runs: `pnpm exec biome check .` — expect "no files to check" or similar (no source files yet).

**Step 3:** Commit.

```bash
git add biome.json
git commit -m "chore: biome config"
```

---

### Task 0.4: `shared/` package skeleton

**Files:**
- Create: `shared/package.json`
- Create: `shared/tsconfig.json`
- Create: `shared/src/index.ts`
- Create: `shared/vitest.config.ts`

**Step 1:** Write `shared/package.json`:

```json
{
  "name": "@muxpad/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check ."
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "vitest": "^2.1.0", "typescript": "^5.6.0" }
}
```

**Step 2:** Write `shared/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

**Step 3:** Write `shared/src/index.ts`: just `export {};`.

**Step 4:** Write `shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

**Step 5:** Install: `pnpm install`. Verify `pnpm --filter @muxpad/shared test` runs (no tests, exit 0).

**Step 6:** Commit.

```bash
git add shared/
git commit -m "chore: shared package skeleton"
```

---

### Task 0.5: `server/` and `web/` package skeletons

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/index.ts`, `server/vitest.config.ts`
- Create: `web/package.json`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/vite.config.ts`

**Step 1:** Write `server/package.json`:

```json
{
  "name": "@muxpad/server",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check ."
  },
  "dependencies": {
    "@muxpad/shared": "workspace:*",
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "ws": "^8.18.0",
    "node-pty": "^1.0.0",
    "better-sqlite3": "^11.5.0",
    "ulid": "^2.3.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.13",
    "@types/better-sqlite3": "^7.6.11",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

**Step 2:** Write `server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"]
}
```

**Step 3:** Write `server/src/index.ts`: `console.log('webagents server boot');`

**Step 4:** Write `server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

**Step 5:** Write `web/package.json`:

```json
{
  "name": "@muxpad/web",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -b && vite build",
    "dev": "vite",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "biome check ."
  },
  "dependencies": {
    "@muxpad/shared": "workspace:*",
    "@tanstack/react-router": "^1.84.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-clipboard": "^0.1.0",
    "@xterm/addon-web-links": "^0.11.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-mosaic-component": "^6.1.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

**Step 6:** Write `web/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"]
}
```

**Step 7:** Write `web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:7777', '/ws': { target: 'ws://localhost:7777', ws: true } } },
});
```

**Step 8:** Write `web/index.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8" /><title>webagents</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

**Step 9:** Write `web/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
const root = createRoot(document.getElementById('root')!);
root.render(<div>webagents</div>);
```

**Step 10:** `pnpm install` from repo root. **node-pty and better-sqlite3 will compile native modules** — this is expected; if it fails, install Xcode CLT (`xcode-select --install`) and retry.

**Step 11:** Verify build:

```bash
pnpm --filter @muxpad/server build  # expect dist/index.js
pnpm --filter @muxpad/web build      # expect dist/index.html and assets
```

**Step 12:** Commit.

```bash
git add server/ web/ pnpm-lock.yaml
git commit -m "chore: server and web package skeletons"
```

---

## Milestone 1 — Shared types and SQLite store

### Task 1.1: Define core domain types in `shared/`

**Files:**
- Create: `shared/src/types.ts`
- Create: `shared/src/types.test.ts`
- Modify: `shared/src/index.ts`

**Step 1: Write the failing test**

```ts
// shared/src/types.test.ts
import { describe, it, expect } from 'vitest';
import { WorkspaceSchema, PaneSpecSchema, LayoutNodeSchema } from './types';

describe('domain schemas', () => {
  it('parses a leaf layout node', () => {
    expect(LayoutNodeSchema.parse('pane-abc')).toBe('pane-abc');
  });

  it('parses a split layout node', () => {
    const node = { direction: 'row', splitPercentage: 50, first: 'a', second: 'b' };
    expect(LayoutNodeSchema.parse(node)).toEqual(node);
  });

  it('rejects unknown direction', () => {
    expect(() => LayoutNodeSchema.parse({ direction: 'diagonal', first: 'a', second: 'b' })).toThrow();
  });

  it('parses a pane spec with defaults', () => {
    const p = PaneSpecSchema.parse({ id: 'p1', workspace_id: 'w1', shell: '/bin/zsh', cwd: '/tmp', created_at: 0 });
    expect(p.startup_cmd).toBeNull();
    expect(p.env).toBeNull();
  });

  it('parses a workspace', () => {
    const w = WorkspaceSchema.parse({ id: 'w1', slug: 'dev', name: 'Dev', layout: 'pane-1', created_at: 0, updated_at: 0 });
    expect(w.slug).toBe('dev');
  });
});
```

**Step 2: Run test, verify it fails**

```bash
pnpm --filter @muxpad/shared test
```

Expected: FAIL — module `./types` not found.

**Step 3: Write minimal implementation**

```ts
// shared/src/types.ts
import { z } from 'zod';

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.string(),
    z.object({
      direction: z.enum(['row', 'column']),
      splitPercentage: z.number().min(0).max(100).optional(),
      first: LayoutNodeSchema,
      second: LayoutNodeSchema,
    }),
  ])
);
export type LayoutNode = string | { direction: 'row' | 'column'; splitPercentage?: number; first: LayoutNode; second: LayoutNode };

export const PaneSpecSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  shell: z.string(),
  startup_cmd: z.string().nullable().default(null),
  cwd: z.string(),
  env: z.record(z.string()).nullable().default(null),
  created_at: z.number(),
});
export type PaneSpec = z.infer<typeof PaneSpecSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  layout: LayoutNodeSchema,
  created_at: z.number(),
  updated_at: z.number(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
```

**Step 4:** Update `shared/src/index.ts`: `export * from './types';`

**Step 5: Run tests, verify they pass**

```bash
pnpm --filter @muxpad/shared test
```

Expected: 5 passing.

**Step 6: Commit**

```bash
git add shared/src/
git commit -m "feat(shared): domain schemas for workspace, pane, layout"
```

---

### Task 1.2: WS message protocol types in `shared/`

**Files:**
- Create: `shared/src/ws-protocol.ts`
- Create: `shared/src/ws-protocol.test.ts`
- Modify: `shared/src/index.ts`

**Step 1: Write the failing test**

```ts
// shared/src/ws-protocol.test.ts
import { describe, it, expect } from 'vitest';
import {
  encodeInput, encodeResize, encodeOutput, encodeExit,
  decodeServerMessage, decodeClientMessage,
} from './ws-protocol';

describe('ws protocol', () => {
  it('round-trips input', () => {
    const buf = encodeInput('hello');
    const msg = decodeClientMessage(buf);
    expect(msg).toEqual({ kind: 'input', data: 'hello' });
  });

  it('round-trips resize', () => {
    const buf = encodeResize(120, 40);
    const msg = decodeClientMessage(buf);
    expect(msg).toEqual({ kind: 'resize', cols: 120, rows: 40 });
  });

  it('round-trips output', () => {
    const buf = encodeOutput('world');
    expect(decodeServerMessage(buf)).toEqual({ kind: 'output', data: 'world' });
  });

  it('round-trips exit', () => {
    const buf = encodeExit(127);
    expect(decodeServerMessage(buf)).toEqual({ kind: 'exit', code: 127 });
  });

  it('rejects unknown opcode', () => {
    const buf = new Uint8Array([0xff, 1, 2, 3]);
    expect(() => decodeClientMessage(buf)).toThrow();
  });
});
```

**Step 2: Run test, verify it fails.**

**Step 3: Write minimal implementation**

```ts
// shared/src/ws-protocol.ts
const enc = new TextEncoder();
const dec = new TextDecoder();

export type ClientMessage =
  | { kind: 'input'; data: string }
  | { kind: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { kind: 'output'; data: string }
  | { kind: 'exit'; code: number }
  | { kind: 'error'; message: string };

export function encodeInput(data: string): Uint8Array {
  const body = enc.encode(data);
  const out = new Uint8Array(1 + body.length);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

export function encodeResize(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = 0x02;
  new DataView(out.buffer).setUint16(1, cols);
  new DataView(out.buffer).setUint16(3, rows);
  return out;
}

export function encodeOutput(data: string): Uint8Array {
  const body = enc.encode(data);
  const out = new Uint8Array(1 + body.length);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

export function encodeExit(code: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = 0x03;
  new DataView(out.buffer).setInt32(1, code);
  return out;
}

export function encodeError(message: string): Uint8Array {
  const body = enc.encode(message);
  const out = new Uint8Array(1 + body.length);
  out[0] = 0x04;
  out.set(body, 1);
  return out;
}

export function decodeClientMessage(buf: Uint8Array): ClientMessage {
  const op = buf[0];
  if (op === 0x01) return { kind: 'input', data: dec.decode(buf.subarray(1)) };
  if (op === 0x02) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { kind: 'resize', cols: view.getUint16(1), rows: view.getUint16(3) };
  }
  throw new Error(`unknown client opcode: ${op}`);
}

export function decodeServerMessage(buf: Uint8Array): ServerMessage {
  const op = buf[0];
  if (op === 0x01) return { kind: 'output', data: dec.decode(buf.subarray(1)) };
  if (op === 0x03) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { kind: 'exit', code: view.getInt32(1) };
  }
  if (op === 0x04) return { kind: 'error', message: dec.decode(buf.subarray(1)) };
  throw new Error(`unknown server opcode: ${op}`);
}
```

**Step 4:** Add to `shared/src/index.ts`: `export * from './ws-protocol';`

**Step 5: Run tests, verify all pass.**

**Step 6: Commit**

```bash
git add shared/src/
git commit -m "feat(shared): binary ws-protocol with codecs and tests"
```

---

### Task 1.3: SQLite schema + migration runner

**Files:**
- Create: `server/src/store/db.ts`
- Create: `server/src/store/migrations.ts`
- Create: `server/src/store/migrations.test.ts`

**Step 1: Write the failing test**

```ts
// server/src/store/migrations.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

describe('migrations', () => {
  it('creates tables on a fresh db', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['workspaces', 'panes', 'attachments', 'schema_version']));
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('records the current schema version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBeGreaterThan(0);
  });
});
```

**Step 2: Run, verify FAIL.**

**Step 3: Write the implementation**

```ts
// server/src/store/migrations.ts
import type Database from 'better-sqlite3';

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        layout      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE panes (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        shell         TEXT NOT NULL,
        startup_cmd   TEXT,
        cwd           TEXT NOT NULL,
        env           TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX panes_workspace_id ON panes(workspace_id);
      CREATE TABLE attachments (
        id          TEXT PRIMARY KEY,
        pane_id     TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
        mime        TEXT NOT NULL,
        path        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.transaction(() => {
        db.exec(m.sql);
      })();
    }
  }
}
```

```ts
// server/src/store/db.ts
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
```

**Step 4: Run tests, verify PASS.**

**Step 5: Commit**

```bash
git add server/src/store/
git commit -m "feat(server): sqlite migrations and db opener"
```

---

### Task 1.4: WorkspaceStore CRUD

**Files:**
- Create: `server/src/store/WorkspaceStore.ts`
- Create: `server/src/store/WorkspaceStore.test.ts`

**Step 1: Write the failing test**

```ts
// server/src/store/WorkspaceStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import { WorkspaceStore } from './WorkspaceStore';

describe('WorkspaceStore', () => {
  let store: WorkspaceStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    store = new WorkspaceStore(db);
  });

  it('creates and retrieves a workspace', () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1' });
    expect(w.slug).toBeTruthy();
    expect(store.getById(w.id)).toEqual(w);
    expect(store.getBySlug(w.slug)).toEqual(w);
  });

  it('auto-deconflicts slugs', () => {
    const a = store.create({ name: 'Dev', layout: 'pane-1' });
    const b = store.create({ name: 'Dev', layout: 'pane-2' });
    expect(a.slug).not.toBe(b.slug);
  });

  it('lists all workspaces sorted by updated_at desc', () => {
    const a = store.create({ name: 'A', layout: 'pa' });
    const b = store.create({ name: 'B', layout: 'pb' });
    const list = store.list();
    expect(list.map(w => w.id)).toEqual([b.id, a.id]);
  });

  it('updates layout and bumps updated_at', async () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1' });
    await new Promise(r => setTimeout(r, 5));
    const updated = store.update(w.id, { layout: { direction: 'row', first: 'a', second: 'b' } });
    expect(updated.updated_at).toBeGreaterThan(w.updated_at);
  });

  it('deletes a workspace', () => {
    const w = store.create({ name: 'Dev', layout: 'pane-1' });
    store.delete(w.id);
    expect(store.getById(w.id)).toBeNull();
  });
});
```

**Step 2: Run, verify FAIL.**

**Step 3: Write implementation**

```ts
// server/src/store/WorkspaceStore.ts
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { LayoutNode, Workspace } from '@muxpad/shared';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
}

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: { name: string; layout: LayoutNode }): Workspace {
    const id = ulid();
    const base = slugify(input.name);
    const slug = this.uniqueSlug(base);
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO workspaces (id, slug, name, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, slug, input.name, JSON.stringify(input.layout), now, now);
    return { id, slug, name: input.name, layout: input.layout, created_at: now, updated_at: now };
  }

  private uniqueSlug(base: string): string {
    const exists = this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?');
    if (!exists.get(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!exists.get(candidate)) return candidate;
    }
    throw new Error('unable to allocate slug');
  }

  getById(id: string): Workspace | null {
    return this.row(this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id));
  }

  getBySlug(slug: string): Workspace | null {
    return this.row(this.db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug));
  }

  list(): Workspace[] {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY updated_at DESC').all();
    return rows.map(r => this.row(r)!).filter(Boolean);
  }

  update(id: string, patch: { name?: string; slug?: string; layout?: LayoutNode }): Workspace {
    const existing = this.getById(id);
    if (!existing) throw new Error(`workspace ${id} not found`);
    const next = {
      name: patch.name ?? existing.name,
      slug: patch.slug ?? existing.slug,
      layout: patch.layout ?? existing.layout,
    };
    const now = Date.now();
    this.db.prepare(
      'UPDATE workspaces SET name = ?, slug = ?, layout = ?, updated_at = ? WHERE id = ?'
    ).run(next.name, next.slug, JSON.stringify(next.layout), now, id);
    return { ...existing, ...next, updated_at: now };
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  private row(r: unknown): Workspace | null {
    if (!r) return null;
    const x = r as { id: string; slug: string; name: string; layout: string; created_at: number; updated_at: number };
    return { id: x.id, slug: x.slug, name: x.name, layout: JSON.parse(x.layout), created_at: x.created_at, updated_at: x.updated_at };
  }
}
```

**Step 4: Run tests, verify PASS.**

**Step 5: Commit**

```bash
git add server/src/store/
git commit -m "feat(server): WorkspaceStore CRUD"
```

---

### Task 1.5: PaneStore CRUD

**Files:**
- Create: `server/src/store/PaneStore.ts`
- Create: `server/src/store/PaneStore.test.ts`

**Step 1: Write the failing test**

```ts
// server/src/store/PaneStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import { PaneStore } from './PaneStore';
import { WorkspaceStore } from './WorkspaceStore';

describe('PaneStore', () => {
  let panes: PaneStore;
  let workspaces: WorkspaceStore;
  let workspaceId: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    panes = new PaneStore(db);
    workspaces = new WorkspaceStore(db);
    workspaceId = workspaces.create({ name: 'W', layout: 'p1' }).id;
  });

  it('creates a pane', () => {
    const p = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    expect(p.startup_cmd).toBeNull();
    expect(panes.getById(p.id)).toEqual(p);
  });

  it('lists panes for a workspace', () => {
    const a = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    const b = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp', startup_cmd: 'claude' });
    const list = panes.listByWorkspace(workspaceId);
    expect(list.map(p => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('cascades on workspace delete', () => {
    const p = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    workspaces.delete(workspaceId);
    expect(panes.getById(p.id)).toBeNull();
  });

  it('deletes a pane', () => {
    const p = panes.create({ workspace_id: workspaceId, shell: '/bin/zsh', cwd: '/tmp' });
    panes.delete(p.id);
    expect(panes.getById(p.id)).toBeNull();
  });
});
```

**Step 2: Run, verify FAIL.**

**Step 3: Write the implementation**

```ts
// server/src/store/PaneStore.ts
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { PaneSpec } from '@muxpad/shared';

export class PaneStore {
  constructor(private readonly db: Database.Database) {}

  create(input: { workspace_id: string; shell: string; cwd: string; startup_cmd?: string | null; env?: Record<string, string> | null }): PaneSpec {
    const id = ulid();
    const now = Date.now();
    const startup_cmd = input.startup_cmd ?? null;
    const env = input.env ?? null;
    this.db.prepare(
      'INSERT INTO panes (id, workspace_id, shell, startup_cmd, cwd, env, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.workspace_id, input.shell, startup_cmd, input.cwd, env ? JSON.stringify(env) : null, now);
    return { id, workspace_id: input.workspace_id, shell: input.shell, startup_cmd, cwd: input.cwd, env, created_at: now };
  }

  getById(id: string): PaneSpec | null {
    return this.row(this.db.prepare('SELECT * FROM panes WHERE id = ?').get(id));
  }

  listByWorkspace(workspaceId: string): PaneSpec[] {
    const rows = this.db.prepare('SELECT * FROM panes WHERE workspace_id = ? ORDER BY created_at').all(workspaceId);
    return rows.map(r => this.row(r)!).filter(Boolean);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM panes WHERE id = ?').run(id);
  }

  private row(r: unknown): PaneSpec | null {
    if (!r) return null;
    const x = r as { id: string; workspace_id: string; shell: string; startup_cmd: string | null; cwd: string; env: string | null; created_at: number };
    return { id: x.id, workspace_id: x.workspace_id, shell: x.shell, startup_cmd: x.startup_cmd, cwd: x.cwd, env: x.env ? JSON.parse(x.env) : null, created_at: x.created_at };
  }
}
```

**Step 4:** Run tests, verify PASS.

**Step 5: Commit**

```bash
git add server/src/store/
git commit -m "feat(server): PaneStore CRUD"
```

---

## Milestone 2 — PaneRuntime + PaneManager (PTY layer)

### Task 2.1: RingBuffer

**Files:**
- Create: `server/src/runtime/RingBuffer.ts`
- Create: `server/src/runtime/RingBuffer.test.ts`

**Step 1: Write the failing test**

```ts
// server/src/runtime/RingBuffer.test.ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from './RingBuffer';

describe('RingBuffer', () => {
  it('returns appended chunks in order', () => {
    const r = new RingBuffer(1024);
    r.push('hello ');
    r.push('world');
    expect(r.snapshot()).toBe('hello world');
  });

  it('drops the oldest bytes when over capacity', () => {
    const r = new RingBuffer(5);
    r.push('hello ');
    r.push('world');
    expect(r.snapshot().length).toBeLessThanOrEqual(5);
    expect(r.snapshot().endsWith('world')).toBe(true);
  });

  it('handles a single push that exceeds capacity', () => {
    const r = new RingBuffer(3);
    r.push('abcdef');
    expect(r.snapshot()).toBe('def');
  });
});
```

**Step 2:** Run, verify FAIL.

**Step 3:** Write implementation:

```ts
// server/src/runtime/RingBuffer.ts
export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly capacity: number) {}

  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.capacity) {
      const head = this.chunks[0]!;
      const overshoot = this.size - this.capacity;
      if (head.length <= overshoot) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.slice(overshoot);
        this.size -= overshoot;
      }
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }
}
```

**Step 4:** Run tests, verify PASS.

**Step 5: Commit**

```bash
git add server/src/runtime/
git commit -m "feat(server): RingBuffer with capacity-based eviction"
```

---

### Task 2.2: PaneRuntime (PTY + buffer + broadcast)

**Files:**
- Create: `server/src/runtime/PaneRuntime.ts`
- Create: `server/src/runtime/PaneRuntime.test.ts`

**Important:** node-pty cannot run inside `:memory:` test isolation cleanly because spawning a real shell pollutes a CI environment. We test against a tiny known command (`/bin/echo` and `/bin/cat`) instead of an interactive shell.

**Step 1: Write the failing test**

```ts
// server/src/runtime/PaneRuntime.test.ts
import { describe, it, expect } from 'vitest';
import { PaneRuntime } from './PaneRuntime';

describe('PaneRuntime', () => {
  it('runs a command and emits output', async () => {
    const runtime = new PaneRuntime({ id: 'p1', shell: '/bin/sh', startup_cmd: 'echo hello-world', cwd: '/tmp' });
    runtime.start();
    const collected: string[] = [];
    const exitCode = await new Promise<number>((resolve) => {
      runtime.on('output', (s) => collected.push(s));
      runtime.on('exit', resolve);
    });
    expect(exitCode).toBe(0);
    expect(collected.join('')).toContain('hello-world');
    expect(runtime.snapshot()).toContain('hello-world');
  });

  it('broadcasts output to all subscribers', async () => {
    const runtime = new PaneRuntime({ id: 'p2', shell: '/bin/sh', startup_cmd: 'echo broadcast', cwd: '/tmp' });
    runtime.start();
    const a: string[] = [], b: string[] = [];
    runtime.on('output', (s) => a.push(s));
    runtime.on('output', (s) => b.push(s));
    await new Promise<void>(resolve => runtime.on('exit', () => resolve()));
    expect(a.join('')).toContain('broadcast');
    expect(b.join('')).toContain('broadcast');
  });

  it('forwards input to the PTY', async () => {
    const runtime = new PaneRuntime({ id: 'p3', shell: '/bin/cat', cwd: '/tmp' });
    runtime.start();
    const collected: string[] = [];
    runtime.on('output', (s) => collected.push(s));
    runtime.write('echo-back\n');
    await new Promise(r => setTimeout(r, 200));
    runtime.kill();
    await new Promise<void>(resolve => runtime.on('exit', () => resolve()));
    expect(collected.join('')).toContain('echo-back');
  });
});
```

**Step 2:** Run, verify FAIL.

**Step 3:** Write implementation:

```ts
// server/src/runtime/PaneRuntime.ts
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { RingBuffer } from './RingBuffer';

const RING_CAPACITY = 2 * 1024 * 1024; // 2MB

export type PaneRuntimeEvents = {
  output: (data: string) => void;
  exit: (code: number) => void;
};

export interface PaneRuntimeSpec {
  id: string;
  shell: string;
  startup_cmd?: string | null | undefined;
  cwd: string;
  env?: Record<string, string> | null | undefined;
}

export interface PaneRuntime {
  on<E extends keyof PaneRuntimeEvents>(event: E, listener: PaneRuntimeEvents[E]): this;
  emit<E extends keyof PaneRuntimeEvents>(event: E, ...args: Parameters<PaneRuntimeEvents[E]>): boolean;
}

export class PaneRuntime extends EventEmitter {
  private process: pty.IPty | null = null;
  private buffer = new RingBuffer(RING_CAPACITY);
  private exited = false;
  private exitCode = 0;
  cols = 80;
  rows = 24;

  constructor(public readonly spec: PaneRuntimeSpec) {
    super();
  }

  start(): void {
    if (this.process) return;
    const args = this.spec.startup_cmd ? ['-c', this.spec.startup_cmd] : [];
    const env = { ...process.env, ...(this.spec.env ?? {}), TERM: 'xterm-256color' } as Record<string, string>;
    this.process = pty.spawn(this.spec.shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.spec.cwd,
      env,
    });
    this.process.onData((data) => {
      this.buffer.push(data);
      this.emit('output', data);
    });
    this.process.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.emit('exit', exitCode);
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.process?.resize(cols, rows);
  }

  kill(signal: NodeJS.Signals = 'SIGHUP'): void {
    this.process?.kill(signal);
  }

  isExited(): boolean {
    return this.exited;
  }

  getExitCode(): number {
    return this.exitCode;
  }

  snapshot(): string {
    return this.buffer.snapshot();
  }
}
```

**Step 4:** Run tests:

```bash
pnpm --filter @muxpad/server test src/runtime/PaneRuntime.test.ts
```

Expected: 3 passing. (If this fails because node-pty failed to compile, fix the build before continuing.)

**Step 5: Commit**

```bash
git add server/src/runtime/
git commit -m "feat(server): PaneRuntime wrapping node-pty with ring buffer"
```

---

### Task 2.3: PaneManager

**Files:**
- Create: `server/src/runtime/PaneManager.ts`
- Create: `server/src/runtime/PaneManager.test.ts`

**Step 1: Write the failing test**

```ts
// server/src/runtime/PaneManager.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PaneManager } from './PaneManager';

describe('PaneManager', () => {
  let mgr: PaneManager;

  beforeEach(() => { mgr = new PaneManager(); });

  it('lazily creates a runtime on first access', () => {
    const r = mgr.getOrCreate({ id: 'p1', shell: '/bin/sh', startup_cmd: 'echo hi', cwd: '/tmp' });
    expect(r).toBeTruthy();
    expect(mgr.getOrCreate({ id: 'p1', shell: '/bin/sh', cwd: '/tmp' })).toBe(r);
  });

  it('stops and removes a runtime', async () => {
    mgr.getOrCreate({ id: 'p2', shell: '/bin/sh', startup_cmd: 'sleep 5', cwd: '/tmp' });
    await mgr.kill('p2');
    expect(mgr.has('p2')).toBe(false);
  });
});
```

**Step 2:** Run, verify FAIL.

**Step 3:** Write implementation:

```ts
// server/src/runtime/PaneManager.ts
import { PaneRuntime, type PaneRuntimeSpec } from './PaneRuntime';

export class PaneManager {
  private runtimes = new Map<string, PaneRuntime>();

  getOrCreate(spec: PaneRuntimeSpec): PaneRuntime {
    let r = this.runtimes.get(spec.id);
    if (r) return r;
    r = new PaneRuntime(spec);
    r.start();
    r.on('exit', () => this.runtimes.delete(spec.id));
    this.runtimes.set(spec.id, r);
    return r;
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  get(id: string): PaneRuntime | undefined {
    return this.runtimes.get(id);
  }

  async kill(id: string, signal: NodeJS.Signals = 'SIGHUP'): Promise<void> {
    const r = this.runtimes.get(id);
    if (!r) return;
    return new Promise((resolve) => {
      r.once('exit', () => resolve());
      r.kill(signal);
      // Hard timeout fallback
      setTimeout(() => {
        if (this.runtimes.has(id)) {
          r.kill('SIGKILL');
          this.runtimes.delete(id);
          resolve();
        }
      }, 2000);
    });
  }

  killAll(): Promise<void[]> {
    return Promise.all([...this.runtimes.keys()].map(id => this.kill(id)));
  }
}
```

**Step 4:** Run tests, verify PASS.

**Step 5: Commit**

```bash
git add server/src/runtime/
git commit -m "feat(server): PaneManager with lazy runtime creation"
```

---

## Milestone 3 — HTTP & WebSocket server

### Task 3.1: HTTP server scaffold (Hono)

**Files:**
- Modify: `server/src/index.ts`
- Create: `server/src/server.ts`
- Create: `server/src/server.test.ts`
- Create: `server/src/config.ts`

**Step 1:** Write `server/src/config.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
export const config = {
  host: process.env.MUXPAD_HOST ?? '0.0.0.0',
  port: Number(process.env.MUXPAD_PORT ?? 7777),
  dataDir: process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad'),
};
```

**Step 2:** Write the failing test:

```ts
// server/src/server.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from './server';
import { openDb } from './store/db';
import { PaneManager } from './runtime/PaneManager';

describe('HTTP server', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const db = openDb(':memory:');
    const mgr = new PaneManager();
    app = createApp({ db, paneManager: mgr });
  });

  it('GET /api/health returns ok', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

**Step 3:** Run, verify FAIL.

**Step 4:** Write minimal implementation:

```ts
// server/src/server.ts
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { PaneManager } from './runtime/PaneManager';

export interface AppDeps {
  db: Database.Database;
  paneManager: PaneManager;
}

export function createApp(_deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  return app;
}
```

```ts
// server/src/index.ts
import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from './config';
import { createApp } from './server';
import { openDb } from './store/db';
import { PaneManager } from './runtime/PaneManager';

mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'db.sqlite'));
const paneManager = new PaneManager();
const app = createApp({ db, paneManager });
serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`webagents listening on http://${info.address}:${info.port}`);
});
```

**Step 5:** Run tests, verify PASS.

**Step 6:** Commit:

```bash
git add server/src/
git commit -m "feat(server): http scaffold with hono and /api/health"
```

---

### Task 3.2: Workspaces REST endpoints

**Files:**
- Create: `server/src/routes/workspaces.ts`
- Create: `server/src/routes/workspaces.test.ts`
- Modify: `server/src/server.ts`

**Step 1:** Write the failing test:

```ts
// server/src/routes/workspaces.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server';
import { openDb } from '../store/db';
import { PaneManager } from '../runtime/PaneManager';

describe('workspaces routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp({ db: openDb(':memory:'), paneManager: new PaneManager() });
  });

  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('creates a workspace', async () => {
    const res = await post('/api/workspaces', { name: 'Dev' });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; slug: string };
    expect(body.id).toBeTruthy();
    expect(body.slug).toBe('dev');
  });

  it('lists workspaces', async () => {
    await post('/api/workspaces', { name: 'A' });
    await post('/api/workspaces', { name: 'B' });
    const res = await app.request('/api/workspaces');
    const list = await res.json() as Array<{ name: string }>;
    expect(list.map(w => w.name).sort()).toEqual(['A', 'B']);
  });

  it('updates a workspace layout', async () => {
    const created = await (await post('/api/workspaces', { name: 'Dev' })).json() as { id: string };
    const res = await app.request(`/api/workspaces/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: { direction: 'row', first: 'a', second: 'b' } }),
    });
    expect(res.status).toBe(200);
  });

  it('deletes a workspace', async () => {
    const created = await (await post('/api/workspaces', { name: 'Dev' })).json() as { id: string };
    const res = await app.request(`/api/workspaces/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 for missing workspace', async () => {
    const res = await app.request('/api/workspaces/does-not-exist');
    expect(res.status).toBe(404);
  });
});
```

**Step 2:** Run, verify FAIL.

**Step 3:** Write implementation:

```ts
// server/src/routes/workspaces.ts
import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { LayoutNodeSchema } from '@muxpad/shared';
import { WorkspaceStore } from '../store/WorkspaceStore';
import { PaneStore } from '../store/PaneStore';
import type { PaneManager } from '../runtime/PaneManager';

export function workspacesRoutes(deps: { db: Database.Database; paneManager: PaneManager }): Hono {
  const app = new Hono();
  const workspaces = new WorkspaceStore(deps.db);
  const panes = new PaneStore(deps.db);

  app.post('/', async (c) => {
    const body = z.object({ name: z.string().min(1), layout: LayoutNodeSchema.optional() }).parse(await c.req.json());
    const w = workspaces.create({ name: body.name, layout: body.layout ?? { direction: 'row', first: '', second: '' } });
    return c.json(w, 201);
  });

  app.get('/', (c) => {
    return c.json(workspaces.list());
  });

  app.get('/:id', (c) => {
    const w = workspaces.getById(c.req.param('id'));
    if (!w) return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    return c.json({ ...w, panes: panes.listByWorkspace(w.id) });
  });

  app.patch('/:id', async (c) => {
    const body = z.object({ name: z.string().optional(), slug: z.string().optional(), layout: LayoutNodeSchema.optional() }).parse(await c.req.json());
    const w = workspaces.update(c.req.param('id'), body);
    return c.json(w);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const ws = workspaces.getById(id);
    if (!ws) return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    for (const p of panes.listByWorkspace(id)) {
      await deps.paneManager.kill(p.id);
    }
    workspaces.delete(id);
    return c.body(null, 204);
  });

  return app;
}
```

Modify `server/src/server.ts`:

```ts
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { PaneManager } from './runtime/PaneManager';
import { workspacesRoutes } from './routes/workspaces';

export interface AppDeps { db: Database.Database; paneManager: PaneManager }

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/workspaces', workspacesRoutes(deps));
  return app;
}
```

**Step 4:** Run tests, verify PASS.

**Step 5:** Commit:

```bash
git add server/src/
git commit -m "feat(server): workspaces REST endpoints"
```

---

### Task 3.3: Panes REST endpoints

**Files:**
- Create: `server/src/routes/panes.ts`
- Create: `server/src/routes/panes.test.ts`
- Modify: `server/src/server.ts`

**Step 1:** Write the failing test:

```ts
// server/src/routes/panes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server';
import { openDb } from '../store/db';
import { PaneManager } from '../runtime/PaneManager';

describe('panes routes', () => {
  let app: ReturnType<typeof createApp>;
  let workspaceId: string;

  beforeEach(async () => {
    app = createApp({ db: openDb(':memory:'), paneManager: new PaneManager() });
    const w = await (await app.request('/api/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'W' }),
    })).json() as { id: string };
    workspaceId = w.id;
  });

  it('creates a pane with defaults', async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/panes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const p = await res.json() as { id: string; shell: string };
    expect(p.id).toBeTruthy();
    expect(p.shell).toMatch(/sh|zsh|bash/);
  });

  it('creates a pane with explicit shell + cmd', async () => {
    const res = await app.request(`/api/workspaces/${workspaceId}/panes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shell: '/bin/sh', startup_cmd: 'echo hi', cwd: '/tmp' }),
    });
    const p = await res.json() as { startup_cmd: string };
    expect(p.startup_cmd).toBe('echo hi');
  });

  it('deletes a pane', async () => {
    const p = await (await app.request(`/api/workspaces/${workspaceId}/panes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as { id: string };
    const res = await app.request(`/api/panes/${p.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});
```

**Step 2:** Run, verify FAIL.

**Step 3:** Write implementation:

```ts
// server/src/routes/panes.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { homedir, userInfo } from 'node:os';
import type Database from 'better-sqlite3';
import { PaneStore } from '../store/PaneStore';
import { WorkspaceStore } from '../store/WorkspaceStore';
import type { PaneManager } from '../runtime/PaneManager';

const defaultShell = process.env.SHELL ?? '/bin/zsh';
const _ = userInfo; // ensures import isn't dropped

export function panesRoutes(deps: { db: Database.Database; paneManager: PaneManager }): { workspaceScoped: Hono; paneScoped: Hono } {
  const panes = new PaneStore(deps.db);
  const workspaces = new WorkspaceStore(deps.db);

  const workspaceScoped = new Hono();
  workspaceScoped.post('/:id/panes', async (c) => {
    const wsId = c.req.param('id');
    const ws = workspaces.getById(wsId);
    if (!ws) return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    const body = z.object({
      shell: z.string().optional(),
      startup_cmd: z.string().nullable().optional(),
      cwd: z.string().optional(),
      env: z.record(z.string()).nullable().optional(),
    }).parse(await c.req.json().catch(() => ({})));
    const pane = panes.create({
      workspace_id: wsId,
      shell: body.shell ?? defaultShell,
      cwd: body.cwd ?? homedir(),
      startup_cmd: body.startup_cmd ?? null,
      env: body.env ?? null,
    });
    return c.json(pane, 201);
  });

  const paneScoped = new Hono();
  paneScoped.get('/:id', (c) => {
    const p = panes.getById(c.req.param('id'));
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const isRunning = deps.paneManager.has(p.id);
    return c.json({ ...p, isRunning });
  });

  paneScoped.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    await deps.paneManager.kill(id);
    panes.delete(id);
    return c.body(null, 204);
  });

  paneScoped.post('/:id/respawn', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    await deps.paneManager.kill(id);
    deps.paneManager.getOrCreate({ id: p.id, shell: p.shell, startup_cmd: p.startup_cmd, cwd: p.cwd, env: p.env });
    return c.body(null, 204);
  });

  return { workspaceScoped, paneScoped };
}
```

Modify `server/src/server.ts` to wire both:

```ts
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { PaneManager } from './runtime/PaneManager';
import { workspacesRoutes } from './routes/workspaces';
import { panesRoutes } from './routes/panes';

export interface AppDeps { db: Database.Database; paneManager: PaneManager }

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/workspaces', workspacesRoutes(deps));
  const panes = panesRoutes(deps);
  app.route('/api/workspaces', panes.workspaceScoped);
  app.route('/api/panes', panes.paneScoped);
  return app;
}
```

**Step 4:** Run tests, verify PASS.

**Step 5:** Commit:

```bash
git add server/src/
git commit -m "feat(server): panes REST endpoints"
```

---

### Task 3.4: Attachments endpoint (multipart upload)

**Files:**
- Create: `server/src/routes/attachments.ts`
- Create: `server/src/routes/attachments.test.ts`
- Modify: `server/src/server.ts`

**Step 1:** Write the failing test:

```ts
// server/src/routes/attachments.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server';
import { openDb } from '../store/db';
import { PaneManager } from '../runtime/PaneManager';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('attachments', () => {
  let app: ReturnType<typeof createApp>;
  let paneId: string;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'webagents-att-'));
    process.env.MUXPAD_DATA_DIR = tmp;
    app = createApp({ db: openDb(':memory:'), paneManager: new PaneManager() });
    const w = await (await app.request('/api/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'W' }),
    })).json() as { id: string };
    const p = await (await app.request(`/api/workspaces/${w.id}/panes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as { id: string };
    paneId = p.id;
  });

  it('saves an uploaded image and returns its absolute path', async () => {
    const fd = new FormData();
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    fd.append('file', blob, 'pasted.png');
    const res = await app.request(`/api/panes/${paneId}/attachments`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const body = await res.json() as { path: string };
    expect(body.path).toMatch(/\.png$/);
    expect(readFileSync(body.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
```

**Step 2:** Run, verify FAIL.

**Step 3:** Write implementation:

```ts
// server/src/routes/attachments.ts
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { config } from '../config';
import { PaneStore } from '../store/PaneStore';

export function attachmentsRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);

  app.post('/:paneId/attachments', async (c) => {
    const paneId = c.req.param('paneId');
    const pane = panes.getById(paneId);
    if (!pane) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);

    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: { code: 'bad_request', message: 'file is required' } }, 400);

    const ext = extname(file.name) || mimeExt(file.type);
    const dir = join(config.dataDir, 'attachments', pane.workspace_id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${ulid()}${ext}`);
    writeFileSync(path, Buffer.from(await file.arrayBuffer()));

    deps.db.prepare(
      'INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(ulid(), paneId, file.type, path, Date.now());

    return c.json({ path }, 201);
  });

  return app;
}

function mimeExt(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  return '.bin';
}
```

Modify `server/src/server.ts` to wire it under `/api/panes`. Add to the existing `panes` group:

```ts
import { attachmentsRoutes } from './routes/attachments';
// inside createApp, after panesRoutes wiring:
app.route('/api/panes', attachmentsRoutes(deps));
```

**Step 4:** Run tests, verify PASS.

**Step 5:** Commit:

```bash
git add server/src/
git commit -m "feat(server): attachments multipart upload endpoint"
```

---

### Task 3.5: WebSocket server (`/ws/pane/:id`)

**Files:**
- Create: `server/src/ws.ts`
- Create: `server/src/ws.test.ts`
- Modify: `server/src/index.ts`

**Step 1:** Write the failing test (uses a real localhost server):

```ts
// server/src/ws.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { openDb } from './store/db';
import { PaneManager } from './runtime/PaneManager';
import { attachWsServer } from './ws';
import { encodeInput, decodeServerMessage } from '@muxpad/shared';
import type { AddressInfo } from 'node:net';
import { PaneStore } from './store/PaneStore';
import { WorkspaceStore } from './store/WorkspaceStore';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

async function bootServer() {
  const db = openDb(':memory:');
  const paneManager = new PaneManager();
  const workspaces = new WorkspaceStore(db);
  const panes = new PaneStore(db);
  const ws = workspaces.create({ name: 'W', layout: 'p1' });
  const pane = panes.create({ workspace_id: ws.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  attachWsServer({ http, db, paneManager });
  await new Promise<void>(r => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => { await paneManager.killAll(); http.close(); };
  return { port, paneId: pane.id };
}

describe('WS server', () => {
  it('echoes input through cat and returns it as output', async () => {
    const { port, paneId } = await bootServer();
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>(r => sock.once('open', () => r()));
    const received: string[] = [];
    sock.on('message', (data: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(data));
      if (msg.kind === 'output') received.push(msg.data);
    });
    sock.send(encodeInput('hello-cat\n'));
    await new Promise(r => setTimeout(r, 300));
    sock.close();
    expect(received.join('')).toContain('hello-cat');
  });

  it('replays the ring buffer to a second client', async () => {
    const { port, paneId } = await bootServer();
    const a = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>(r => a.once('open', () => r()));
    a.send(encodeInput('first-line\n'));
    await new Promise(r => setTimeout(r, 200));
    const b = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    const received: string[] = [];
    b.on('message', (data: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(data));
      if (msg.kind === 'output') received.push(msg.data);
    });
    await new Promise<void>(r => b.once('open', () => r()));
    await new Promise(r => setTimeout(r, 200));
    a.close(); b.close();
    expect(received.join('')).toContain('first-line');
  });
});
```

**Step 2:** Run, verify FAIL.

**Step 3:** Write implementation:

```ts
// server/src/ws.ts
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { decodeClientMessage, encodeOutput, encodeExit } from '@muxpad/shared';
import type { PaneManager } from './runtime/PaneManager';
import { PaneStore } from './store/PaneStore';

export function attachWsServer(deps: { http: Server; db: Database.Database; paneManager: PaneManager }): void {
  const wss = new WebSocketServer({ noServer: true });
  const panes = new PaneStore(deps.db);

  deps.http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const match = url.pathname.match(/^\/ws\/pane\/([^/]+)$/);
    if (!match) { socket.destroy(); return; }
    const paneId = match[1]!;
    const pane = panes.getById(paneId);
    if (!pane) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const runtime = deps.paneManager.getOrCreate({
        id: pane.id, shell: pane.shell, startup_cmd: pane.startup_cmd, cwd: pane.cwd, env: pane.env,
      });
      // Replay ring buffer
      const snapshot = runtime.snapshot();
      if (snapshot.length) ws.send(encodeOutput(snapshot));
      // Stream future output
      const onOutput = (data: string) => ws.readyState === WebSocket.OPEN && ws.send(encodeOutput(data));
      const onExit = (code: number) => ws.readyState === WebSocket.OPEN && ws.send(encodeExit(code));
      runtime.on('output', onOutput);
      runtime.on('exit', onExit);
      ws.on('message', (data: Buffer) => {
        try {
          const msg = decodeClientMessage(new Uint8Array(data));
          if (msg.kind === 'input') runtime.write(msg.data);
          else if (msg.kind === 'resize') runtime.resize(msg.cols, msg.rows);
        } catch { /* ignore malformed */ }
      });
      ws.on('close', () => {
        runtime.off('output', onOutput);
        runtime.off('exit', onExit);
      });
    });
  });
}
```

Modify `server/src/index.ts` to use a node HTTP server and attach both:

```ts
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from './config';
import { createApp } from './server';
import { openDb } from './store/db';
import { PaneManager } from './runtime/PaneManager';
import { attachWsServer } from './ws';

mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'db.sqlite'));
const paneManager = new PaneManager();
const app = createApp({ db, paneManager });

const http = createServer((req, res) => {
  app.fetch(new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : (req as unknown as ReadableStream),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })).then(async (response) => {
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
    }
    res.end();
  }).catch((err) => { res.writeHead(500); res.end(String(err)); });
});

attachWsServer({ http, db, paneManager });
http.listen(config.port, config.host, () => {
  console.log(`webagents listening on http://${config.host}:${config.port}`);
});

process.on('SIGTERM', async () => { await paneManager.killAll(); http.close(() => process.exit(0)); });
```

**Note:** The Hono+raw http bridge above is verbose. If `@hono/node-server` exposes `serve` with a returned `server` object, you can `attachWsServer({ http: returnedServer, ... })` — check the docs and prefer that. The shape that works in `@hono/node-server` 1.13+:

```ts
import { serve } from '@hono/node-server';
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
attachWsServer({ http: server as unknown as import('node:http').Server, db, paneManager });
```

Use that path; replace the raw `createServer` block. (Adjust the note in code as needed.)

**Step 4:** Run tests:

```bash
pnpm --filter @muxpad/server test
```

Verify PASS.

**Step 5:** Commit:

```bash
git add server/src/
git commit -m "feat(server): websocket per-pane bridge with ring-buffer replay"
```

---

### Task 3.6: Static frontend serving + run end-to-end smoke

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/index.ts`

**Step 1:** Add a `serveStatic` route in `server/src/server.ts` that serves `dist/web` (built frontend) at `/`:

```ts
// add at top
import { serveStatic } from '@hono/node-server/serve-static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// inside createApp(deps):
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web', 'dist');
app.use('/*', serveStatic({ root: webRoot, fallback: 'index.html' }));
```

**Step 2:** Manual smoke:

```bash
pnpm --filter @muxpad/web build
pnpm --filter @muxpad/server build
pnpm --filter @muxpad/server start &
SERVER_PID=$!
sleep 1
curl -sf http://127.0.0.1:7777/api/health
curl -sf http://127.0.0.1:7777/ | head -c 100
kill $SERVER_PID
```

Expected: `{"ok":true}` and a snippet of the built `index.html`.

**Step 3:** Commit:

```bash
git add server/src/
git commit -m "feat(server): serve built web bundle as static fallback"
```

---

## Milestone 4 — Frontend (dashboard, workspace, panes, clipboard)

> Frontend tasks are validated by Playwright e2e at the milestone boundary (Task 4.10). Inside this milestone we use manual smoke + a few component-level Vitest tests.

### Task 4.1: Frontend root + router + client SDK

**Files:**
- Create: `web/src/api.ts`
- Create: `web/src/router.tsx`
- Modify: `web/src/main.tsx`

**Step 1:** Write `web/src/api.ts` with a typed wrapper around the REST API. Key methods:

```ts
import type { Workspace, PaneSpec, LayoutNode } from '@muxpad/shared';

async function req<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string) => req<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  getWorkspace: (id: string) => req<Workspace & { panes: PaneSpec[] }>(`/api/workspaces/${id}`),
  patchWorkspace: (id: string, patch: { name?: string; slug?: string; layout?: LayoutNode }) =>
    req<Workspace>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWorkspace: (id: string) => req<void>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  createPane: (workspaceId: string, body: Partial<Omit<PaneSpec, 'id' | 'workspace_id' | 'created_at'>>) =>
    req<PaneSpec>(`/api/workspaces/${workspaceId}/panes`, { method: 'POST', body: JSON.stringify(body) }),
  deletePane: (id: string) => req<void>(`/api/panes/${id}`, { method: 'DELETE' }),
  respawnPane: (id: string) => req<void>(`/api/panes/${id}/respawn`, { method: 'POST' }),
  uploadAttachment: async (paneId: string, blob: Blob, name: string): Promise<{ path: string }> => {
    const fd = new FormData(); fd.append('file', blob, name);
    const res = await fetch(`/api/panes/${paneId}/attachments`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};
```

**Step 2:** Write `web/src/router.tsx` with three routes (`/`, `/w/:slug`, `/p/:paneId`). Use TanStack Router's file-based or code-based router; code-based is simpler for v1:

```tsx
import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from '@tanstack/react-router';
import { Dashboard } from './pages/Dashboard';
import { WorkspaceView } from './pages/WorkspaceView';
import { PopoutView } from './pages/PopoutView';

const root = createRootRoute({ component: () => <Outlet /> });
const dashboard = createRoute({ getParentRoute: () => root, path: '/', component: Dashboard });
const workspace = createRoute({ getParentRoute: () => root, path: '/w/$slug', component: WorkspaceView });
const popout = createRoute({ getParentRoute: () => root, path: '/p/$paneId', component: PopoutView });
const tree = root.addChildren([dashboard, workspace, popout]);
export const router = createRouter({ routeTree: tree });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
```

**Step 3:** Modify `web/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './styles.css';
const root = createRoot(document.getElementById('root')!);
root.render(<RouterProvider router={router} />);
```

**Step 4:** Stub the three page components in `web/src/pages/` so TS compiles:

```tsx
// web/src/pages/Dashboard.tsx
export function Dashboard() { return <div>dashboard</div>; }
// web/src/pages/WorkspaceView.tsx
export function WorkspaceView() { return <div>workspace</div>; }
// web/src/pages/PopoutView.tsx
export function PopoutView() { return <div>popout</div>; }
```

Plus an empty `web/src/styles.css`.

**Step 5:** `pnpm --filter @muxpad/web build` — verify success.

**Step 6:** Commit:

```bash
git add web/src/
git commit -m "feat(web): router and api client scaffold"
```

---

### Task 4.2: Dashboard page

**Files:**
- Modify: `web/src/pages/Dashboard.tsx`

Implement: list workspaces, create new, delete with confirm, navigate to workspace by clicking. Use a basic table. Keep styling minimal in v1; add Tailwind in a later polish task if desired.

```tsx
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Workspace } from '@muxpad/shared';
import { api } from '../api';

export function Dashboard() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [name, setName] = useState('');

  const refresh = async () => setWorkspaces(await api.listWorkspaces());
  useEffect(() => { refresh(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    await api.createWorkspace(name.trim());
    setName('');
    refresh();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete workspace and kill all its panes?')) return;
    await api.deleteWorkspace(id);
    refresh();
  };

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>webagents</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New workspace name" />
        <button onClick={create}>Create</button>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th align="left">Name</th><th align="left">Slug</th><th></th></tr></thead>
        <tbody>
          {workspaces.map(w => (
            <tr key={w.id}>
              <td><Link to="/w/$slug" params={{ slug: w.slug }}>{w.name}</Link></td>
              <td>{w.slug}</td>
              <td><button onClick={() => remove(w.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Smoke: build, start server, hit `http://localhost:5173` (with `pnpm --filter @muxpad/web dev` running and the server running on 7777 via `pnpm --filter @muxpad/server dev`). Create a workspace; see it in the table.

Commit:

```bash
git add web/src/pages/Dashboard.tsx
git commit -m "feat(web): dashboard with create/list/delete"
```

---

### Task 4.3: `<XtermPane>` component (terminal + WS)

**Files:**
- Create: `web/src/components/XtermPane.tsx`
- Create: `web/src/components/XtermPane.css`

Covers: xterm.js mount, WebSocket connect, fit addon, resize → server, paste/copy handlers, OSC 52 addon. Image-paste integrates here (Task 4.6) but text paste/copy ship in this task.

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './XtermPane.css';
import { encodeInput, encodeResize, decodeServerMessage } from '@muxpad/shared';

export interface XtermPaneProps { paneId: string }

export function XtermPane({ paneId }: XtermPaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: true,
      theme: { background: '#0b0e14', foreground: '#cdd6f4' },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ClipboardAddon());
    term.loadAddon(new WebLinksAddon());
    term.open(ref.current);
    termRef.current = term;

    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/pane/${paneId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      fit.fit();
      ws.send(encodeResize(term.cols, term.rows));
    });
    ws.addEventListener('message', (e) => {
      const buf = new Uint8Array(e.data as ArrayBuffer);
      const msg = decodeServerMessage(buf);
      if (msg.kind === 'output') term.write(msg.data);
      else if (msg.kind === 'exit') term.writeln(`\r\n[process exited ${msg.code}]`);
    });

    term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(encodeInput(d)));

    const resizeObs = new ResizeObserver(() => {
      try { fit.fit(); ws.readyState === WebSocket.OPEN && ws.send(encodeResize(term.cols, term.rows)); } catch {}
    });
    resizeObs.observe(ref.current);

    // Cmd+C: copy selection if present, else pass through to PTY (SIGINT)
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); e.preventDefault(); }
      }
    };
    ref.current.addEventListener('keydown', onKeyDown, true);

    return () => {
      resizeObs.disconnect();
      ref.current?.removeEventListener('keydown', onKeyDown, true);
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [paneId]);

  return <div className="xterm-pane" ref={ref} />;
}
```

CSS:

```css
/* web/src/components/XtermPane.css */
.xterm-pane { width: 100%; height: 100%; background: #0b0e14; }
.xterm-pane .xterm { padding: 4px; height: 100%; }
```

Commit:

```bash
git add web/src/components/
git commit -m "feat(web): XtermPane component with WS, fit, OSC52, copy"
```

---

### Task 4.4: WorkspaceView with react-mosaic

**Files:**
- Modify: `web/src/pages/WorkspaceView.tsx`
- Create: `web/src/pages/workspace.css`

```tsx
import { useEffect, useState, useCallback } from 'react';
import { useParams } from '@tanstack/react-router';
import { Mosaic, MosaicNode, MosaicWindow } from 'react-mosaic-component';
import 'react-mosaic-component/styles.css';
import { XtermPane } from '../components/XtermPane';
import type { Workspace, PaneSpec } from '@muxpad/shared';
import { api } from '../api';
import './workspace.css';

export function WorkspaceView() {
  const { slug } = useParams({ from: '/w/$slug' });
  const [workspace, setWorkspace] = useState<(Workspace & { panes: PaneSpec[] }) | null>(null);

  useEffect(() => {
    (async () => {
      const list = await api.listWorkspaces();
      const w = list.find(x => x.slug === slug);
      if (!w) return;
      setWorkspace(await api.getWorkspace(w.id));
    })();
  }, [slug]);

  const onChange = useCallback(async (layout: MosaicNode<string> | null) => {
    if (!workspace || layout == null) return;
    setWorkspace({ ...workspace, layout: layout as never });
    await api.patchWorkspace(workspace.id, { layout: layout as never });
  }, [workspace]);

  const splitPane = useCallback(async (after: 'right' | 'down') => {
    if (!workspace) return;
    const pane = await api.createPane(workspace.id, {});
    // simplistic: append a new split at the root
    const newLayout: MosaicNode<string> = {
      direction: after === 'right' ? 'row' : 'column',
      first: workspace.layout as never,
      second: pane.id,
    } as never;
    await api.patchWorkspace(workspace.id, { layout: newLayout as never });
    setWorkspace(await api.getWorkspace(workspace.id));
  }, [workspace]);

  const killPane = useCallback(async (paneId: string) => {
    if (!workspace) return;
    await api.deletePane(paneId);
    setWorkspace(await api.getWorkspace(workspace.id));
  }, [workspace]);

  if (!workspace) return <div style={{ padding: 24 }}>loading…</div>;

  // Empty workspace: show a "Create first pane" affordance
  const isEmpty = typeof workspace.layout === 'string' && !workspace.layout;
  if (isEmpty) {
    return (
      <div style={{ padding: 24 }}>
        <button onClick={() => splitPane('right')}>+ Create first pane</button>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh' }}>
      <div style={{ padding: 4, borderBottom: '1px solid #222', display: 'flex', gap: 8 }}>
        <strong>{workspace.name}</strong>
        <button onClick={() => splitPane('right')}>Split right</button>
        <button onClick={() => splitPane('down')}>Split down</button>
      </div>
      <div style={{ height: 'calc(100vh - 32px)' }}>
        <Mosaic<string>
          renderTile={(paneId, path) => (
            <MosaicWindow<string>
              path={path}
              title={paneId}
              toolbarControls={<button onClick={() => killPane(paneId)}>×</button>}
            >
              <XtermPane paneId={paneId} />
            </MosaicWindow>
          )}
          value={workspace.layout as never}
          onChange={onChange}
        />
      </div>
    </div>
  );
}
```

`workspace.css`:

```css
.mosaic-window-toolbar { background: #11151c; color: #cdd6f4; }
.mosaic-tile { background: #0b0e14; }
```

Smoke: dev server up, create a workspace, click "Create first pane", see a shell. Click "Split right", see two panes. Drag the split bar.

Commit:

```bash
git add web/src/pages/
git commit -m "feat(web): WorkspaceView with react-mosaic and split/kill"
```

---

### Task 4.5: PopoutView

```tsx
// web/src/pages/PopoutView.tsx
import { useParams } from '@tanstack/react-router';
import { XtermPane } from '../components/XtermPane';
export function PopoutView() {
  const { paneId } = useParams({ from: '/p/$paneId' });
  return <div style={{ height: '100vh' }}><XtermPane paneId={paneId} /></div>;
}
```

Add a "Popout" button to the MosaicWindow toolbarControls in `WorkspaceView` that opens `window.open('/p/' + paneId, '_blank')`.

Commit:

```bash
git add web/src/pages/
git commit -m "feat(web): popout pane view via /p/:paneId"
```

---

### Task 4.6: Image paste

**Files:**
- Modify: `web/src/components/XtermPane.tsx`

Inside the effect, add a `paste` listener on `ref.current`:

```ts
const onPaste = async (e: ClipboardEvent) => {
  if (!e.clipboardData) return;
  const images = [...e.clipboardData.items].filter(i => i.type.startsWith('image/'));
  if (images.length === 0) return; // fall through to xterm's text paste
  e.preventDefault();
  e.stopPropagation();
  const paths: string[] = [];
  for (const item of images) {
    const blob = item.getAsFile();
    if (!blob) continue;
    const ext = blob.type.split('/')[1] ?? 'png';
    const { path } = await api.uploadAttachment(paneId, blob, `pasted.${ext}`);
    paths.push(path);
  }
  if (paths.length && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeInput(paths.join(' ') + ' '));
  }
};
ref.current.addEventListener('paste', onPaste, true);
// in cleanup:
ref.current?.removeEventListener('paste', onPaste, true);
```

Manual smoke: paste a screenshot into a Claude pane; observe path appears at the prompt; Claude reads it.

Commit:

```bash
git add web/src/components/
git commit -m "feat(web): image paste uploads attachment and types path into PTY"
```

---

### Task 4.7: Right-click context menu (Copy / Paste)

**Files:**
- Create: `web/src/components/ContextMenu.tsx`
- Modify: `web/src/components/XtermPane.tsx`

Implement a tiny context-menu div positioned at click coordinates with two items: Copy (writes selection to clipboard, disabled if no selection) and Paste (reads `navigator.clipboard.readText()` and sends as `encodeInput`). Wire `oncontextmenu` on the pane root, `e.preventDefault()`.

Commit:

```bash
git add web/src/components/
git commit -m "feat(web): right-click context menu with copy/paste"
```

---

### Task 4.8: Pane spawn dialog with shell + startup_cmd

**Files:**
- Create: `web/src/components/SpawnPaneDialog.tsx`
- Modify: `web/src/pages/WorkspaceView.tsx`

Replace the bare "Split right/down" buttons with a small dialog (HTML `<dialog>` is fine) asking for:
- Shell (default: server's `$SHELL`, displayed; editable)
- Startup command (optional; placeholder "e.g. claude")
- Working dir (default `~`; editable)

Add quick-pick buttons: "Shell", "Claude" (`startup_cmd=claude`).

Commit:

```bash
git add web/src/
git commit -m "feat(web): spawn-pane dialog with quick-pick shell/claude"
```

---

### Task 4.9: Layout debounce for SQLite writes

Wrap the existing `api.patchWorkspace(..., { layout })` call from `<Mosaic onChange>` in a 300ms debounce so drag-resize doesn't hammer the server.

```ts
import { useMemo, useRef } from 'react';
function useDebouncedCallback<F extends (...args: any[]) => any>(fn: F, ms: number): F {
  const t = useRef<number | null>(null);
  return useMemo(() => ((...args: any[]) => {
    if (t.current) window.clearTimeout(t.current);
    t.current = window.setTimeout(() => fn(...args), ms);
  }) as F, [fn, ms]);
}
```

Use it for layout PATCH only.

Commit:

```bash
git add web/src/pages/WorkspaceView.tsx
git commit -m "perf(web): debounce layout PATCH on resize/rearrange"
```

---

### Task 4.10: Playwright e2e

**Files:**
- Create: `e2e/playwright.config.ts`
- Create: `e2e/package.json`
- Create: `e2e/tests/smoke.spec.ts`
- Modify: root `package.json`

Add a top-level `e2e/` package (added to `pnpm-workspace.yaml`) running Playwright against the built server + frontend.

```ts
// e2e/tests/smoke.spec.ts
import { test, expect } from '@playwright/test';

test('create workspace, split panes, type into pane', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[placeholder="New workspace name"]', 'e2e');
  await page.click('button:has-text("Create")');
  await page.click('a:has-text("e2e")');
  await page.click('button:has-text("Create first pane")');
  await page.waitForSelector('.xterm', { timeout: 5000 });
  await page.locator('.xterm').first().click();
  await page.keyboard.type('echo hello-e2e\n');
  await expect(page.locator('.xterm')).toContainText('hello-e2e', { timeout: 5000 });
});
```

`playwright.config.ts` should:
- Launch `pnpm --filter @muxpad/server start` as `webServer` on port 7777 with built static frontend.
- Use `baseURL: http://127.0.0.1:7777`.
- Single worker.

Run: `pnpm --filter @muxpad/e2e test`. Verify PASS.

Commit:

```bash
git add e2e/ pnpm-workspace.yaml package.json
git commit -m "test(e2e): playwright smoke for create→split→type→see-output"
```

---

## Milestone 5 — Deployment + reliability

### Task 5.1: Build pipeline (single-step build of server with frontend)

**Files:**
- Modify: `package.json` (root)
- Modify: `server/package.json`

Make root `pnpm build` produce a runnable artifact: build `shared`, build `web`, build `server`. Verify `node server/dist/index.js` boots and serves the bundled frontend.

Commit.

---

### Task 5.2: `webagents` CLI

**Files:**
- Create: `server/src/cli.ts`
- Modify: `server/package.json` (add `bin`)

Subcommands:
- `webagents start` — runs the server inline (replaces `node dist/index.js`)
- `webagents install` — writes a launchd plist to `~/Library/LaunchAgents/dev.muxpad.plist` and `launchctl bootstrap`s it
- `webagents uninstall` — bootout + remove plist
- `webagents status` — `launchctl print` summary
- `webagents logs` — tail `~/Library/Logs/webagents/*.log`

Plist template:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.muxpad</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>{{INSTALL_PATH}}/server/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>MUXPAD_HOST</key><string>{{HOST}}</string>
    <key>MUXPAD_PORT</key><string>7777</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{{HOME}}/Library/Logs/webagents/server.log</string>
  <key>StandardErrorPath</key><string>{{HOME}}/Library/Logs/webagents/error.log</string>
</dict></plist>
```

`{{HOST}}` is determined at install time from a CLI flag `--host` (default: prompt; suggest the user's Tailscale IP looked up via `tailscale ip -4`).

Commit.

---

### Task 5.3: Tailscale-only bind smoke + install on the actual mini

Manual:

```bash
tailscale ip -4
# webagents install --host 100.x.x.x
launchctl print gui/$UID/dev.muxpad | head
curl http://100.x.x.x:7777/api/health
```

Verify accessible from a laptop on the tailnet; verify NOT accessible from off-tailnet.

(No commit; this is operational.)

---

### Task 5.4: Attachments GC on startup

**Files:**
- Create: `server/src/maintenance/attachments-gc.ts`
- Modify: `server/src/index.ts`

On daemon start, list files under `dataDir/attachments/`. For each, check if (a) it's referenced in the `attachments` table AND its pane row exists; (b) its mtime is newer than 7 days. Delete if neither.

Add a small unit test using a tmp dir.

Commit.

---

### Task 5.5: 24h soak smoke harness

**Files:**
- Create: `scripts/soak.ts`
- Modify: root `package.json`

Spawns N=10 panes, runs `yes`, `top -b`, `cat /etc/services` loops. Samples RSS every 60s. Asserts < 200MB at end. Run manually before each release.

Commit.

---

## Milestone 6 — Polish

- Theme + minimal styling pass (Tailwind or hand-rolled CSS).
- Loading and error toasts.
- Keyboard shortcuts: Cmd+T new pane (shell), Cmd+Shift+P split right, Cmd+Shift+O split down, Cmd+W close pane.
- "Title" detection from xterm `OSC 0` to update pane chrome name.

Each shortcut and polish pass is its own task with a commit.

---

## Definition of done for v1

- [ ] All tests pass: `pnpm test` and `pnpm --filter @muxpad/e2e test`.
- [ ] `webagents install` succeeds on a clean Mac, daemon comes up under launchd, survives a kill -9.
- [ ] From two browsers (mini-local + laptop on Tailscale), the same workspace mirrors live.
- [ ] Image paste → file path appears in pane → Claude Code can read the image.
- [ ] OSC 52 from a TUI (e.g. `tmux`'s `set-clipboard on` test path) puts text in browser clipboard.
- [ ] Cmd+C copies selection; right-click menu works.
- [ ] Daemon restart via `launchctl kickstart -k`: workspaces re-open, panes respawn from spec.
- [ ] 24h soak under simulated load stays under RSS budget.
