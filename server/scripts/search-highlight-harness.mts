/**
 * A throwaway, fully ISOLATED muxpad instance for verifying the search-hit
 * highlight end to end. Same shape as shot-harness.mts (own temp data dir, own
 * ptyd socket, in-memory db, 127.0.0.1 on an ephemeral port, fake runner) plus:
 *
 *   · a real muxpad-format transcript on disk, long enough that the archive's
 *     oldest hit is NOT in the 128 KB tail the chat opens on;
 *   · an ArchiveDb seeded from that transcript, so `GET /api/search` answers
 *     with real hits pointing at this pane.
 *
 * Nothing here touches ~/.muxpad, the launchd daemon, or any port but the
 * ephemeral one it prints.
 *
 * Run:  npx tsx scripts/search-highlight-harness.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { ChatEvent, Tab } from '@muxpad/shared';
import { WebSocket } from 'ws';
import { createAgentBridge } from '../src/agent-bridge.js';
import { ArchiveDb } from '../src/archive/ArchiveDb.js';
import { EventBus } from '../src/events.js';
import { PtydCache } from '../src/ptyd-cache.js';
import { createApp } from '../src/server.js';
import { mountStaticWeb } from '../src/static-assets.js';
import { WorkspaceStore } from '../src/store/WorkspaceStore.js';
import { openDb } from '../src/store/db.js';
import { spawnPtyd } from '../src/test-helpers/spawnPtyd.js';
import { attachWsServer } from '../src/ws.js';

const tmp = mkdtempSync(join(tmpdir(), 'muxpad-searchhl-'));
process.env.MUXPAD_DATA_DIR = tmp;
process.env.MUXPAD_NO_FUNNEL = '1';

const db = openDb(':memory:');
const events = new EventBus();
const agentBridge = createAgentBridge();
const archive = new ArchiveDb(join(tmp, 'archive.sqlite'));
const ptyd = await spawnPtyd();
const cache = new PtydCache();
cache.attach(ptyd.client);

const app = createApp({
  db,
  ptyd: ptyd.client,
  cache,
  dataDir: tmp,
  events,
  agentBridge,
  archive,
});
mountStaticWeb(app, join(import.meta.dirname, '..', '..', 'web', 'dist'));
const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((r) => server.once('listening', () => r()));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no address');
const port = addr.port;
const wsServer = attachWsServer({
  http: server as unknown as Server,
  db,
  ptyd: ptyd.client,
  cache,
  events,
  agentBridge,
});

const base = `http://127.0.0.1:${port}`;
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

const wsId = new WorkspaceStore(db).create({ name: 'Search' }).id;
const tab = await api<Tab>('/api/tabs', {
  method: 'POST',
  body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', backend: 'codex', mode: 'do' }),
});
const detail = await api<Tab & { panes: Array<{ id: string }> }>(`/api/tabs/${tab.id}`);
const paneId = detail.panes[0]?.id as string;

// ── The transcript ──────────────────────────────────────────────────────────
// `codex` is a non-Claude backend, so ws.ts tails
// $MUXPAD_DATA_DIR/agent-transcripts/<sid>.jsonl with the IDENTITY normalizer:
// each line is a ChatEvent verbatim. That makes seeding a realistic conversation
// a matter of writing the events we want to see.
const SID = 'sid-search-highlight-0001';
const T0 = Date.UTC(2026, 7, 20, 9, 0, 0);
const evs: ChatEvent[] = [];
let n = 0;
const at = (i: number) => T0 + i * 60_000;
const push = (e: ChatEvent) => {
  evs.push(e);
  n++;
};

const filler = (count: number, tag: string) => {
  for (let i = 0; i < count; i++) {
    push({ id: `e${n}`, ts: at(n), kind: 'user', text: `${tag} question number ${i}.` });
    push({
      id: `e${n}`,
      ts: at(n),
      kind: 'assistant',
      text: `${tag} answer number ${i}. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}`,
    });
  }
};

// (1) The UNREACHABLE hit, at the very head of a ~3 MB transcript — about 24
// older pages back, well past the 8-page seek budget. This is the case that
// must SAY it cannot get there rather than silently doing nothing.
push({ id: `e${n}`, ts: at(n), kind: 'user', text: 'Remember: the quince recipe is secret.' });
push({ id: `e${n}`, ts: at(n), kind: 'assistant', text: 'Noted — the quince stays between us.' });

filler(2000, 'Ancient');

// (2) The SEEKABLE hit — a few pages back, so reaching it exercises the
// page-backwards loop and lands on a message the opening window did not hold.
push({ id: `e${n}`, ts: at(n), kind: 'user', text: 'And what about the kumquat plan?' });
push({
  id: `e${n}`,
  ts: at(n),
  kind: 'assistant',
  text: 'The kumquat plan is fine. Ship the kumquat.',
});

filler(220, 'Filler');

// (3) The NEAR hits, inside the opening window. One plain, one Hebrew, one
// with the term inside a fenced code block, and one that says it repeatedly.
const NEAR_START = n;
push({
  id: `e${n}`,
  ts: at(n),
  kind: 'user',
  text: 'Where did we land on the marmalade thing?',
});
push({
  id: `e${n}`,
  ts: at(n),
  kind: 'assistant',
  text: [
    'Short answer: **marmalade** three times over, so the highlight has something to repeat on.',
    '',
    'The marmalade is stored under `MARMALADE_KEY`, and the loader reads it once:',
    '',
    '```ts',
    'const marmalade = await load("marmalade");',
    'if (!marmalade) throw new Error("no marmalade");',
    '```',
    '',
    'See [the marmalade docs](https://example.invalid/marmalade) for the rest.',
  ].join('\n'),
});
push({
  id: `e${n}`,
  ts: at(n),
  kind: 'user',
  text: 'המרמלדה הזאת היא הסוד הכי טוב שיש, ואני רוצה עוד marmalade בבקשה.',
});
push({
  id: `e${n}`,
  ts: at(n),
  kind: 'assistant',
  text: 'בסדר גמור — עוד marmalade בדרך. גם בעברית וגם באנגלית, marmalade היא marmalade.',
});
for (let i = 0; i < 6; i++) {
  push({ id: `e${n}`, ts: at(n), kind: 'user', text: `Tail chatter ${i}.` });
  push({ id: `e${n}`, ts: at(n), kind: 'assistant', text: `Tail reply ${i}.` });
}

mkdirSync(join(tmp, 'agent-transcripts'), { recursive: true });
writeFileSync(
  join(tmp, 'agent-transcripts', `${SID}.jsonl`),
  `${evs.map((e) => JSON.stringify(e)).join('\n')}\n`,
);

// ── The archive ─────────────────────────────────────────────────────────────
// Exactly what the Archiver would have written for that file: one FTS row per
// indexed event, plus the session row that resolves a hit back to this pane.
const indexed = evs.filter(
  (e): e is Extract<ChatEvent, { text: string }> =>
    (e.kind === 'user' || e.kind === 'assistant') && !!(e as { text?: string }).text,
);
archive.insertMessages(indexed.map((e) => ({ text: e.text, sid: SID, ts: e.ts, role: e.kind })));
archive.upsertSession({
  sid: SID,
  assistant: 'codex',
  cwd: tmp,
  pane_id: paneId,
  project_dir: null,
  first_ts: evs[0]?.ts ?? null,
  last_ts: evs[evs.length - 1]?.ts ?? null,
});
db.prepare(
  'INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
).run(SID, paneId, 'codex', tmp, evs[0]?.ts ?? 0, evs[evs.length - 1]?.ts ?? 0);

// ── The fake runner ─────────────────────────────────────────────────────────
const runner = new WebSocket(`${base.replace('http', 'ws')}/ws/agent-runner/${paneId}`);
await new Promise<void>((res, rej) => {
  runner.once('open', () => res());
  runner.once('error', rej);
});
runner.send(
  JSON.stringify({ t: 'hello', sid: SID, cwd: tmp, pid: 1, backend: 'codex', turnActive: false }),
);

// The ts of the deep hit and of the first near hit, so the driver can assert
// which message the jump chose.
process.stdout.write(
  `${JSON.stringify({
    port,
    wsId,
    tabId: tab.id,
    tabSlug: tab.slug,
    paneId,
    sid: SID,
    tmp,
    unreachableHitTs: evs[1]?.ts,
    nearHitTs: evs[NEAR_START + 1]?.ts,
    events: evs.length,
  })}\n`,
);

const shutdown = async () => {
  try {
    runner.close();
  } catch {
    // already gone
  }
  await wsServer.close();
  await ptyd.cleanup();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
