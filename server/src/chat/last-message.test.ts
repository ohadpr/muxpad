// The phone's Activity list shows each chat's LAST MESSAGE under its name.
// What counts as "the last message" is a pure question about events, and the
// route that serves it must answer for exactly the ids asked, capped.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';
import { PREVIEW_MAX_CHARS, lastMessageOf, resetLastMessageMemo } from './last-message.js';

const user = (text: string, extra: Partial<ChatEvent> = {}): ChatEvent =>
  ({ kind: 'user', id: text, ts: 1, text, ...extra }) as ChatEvent;
const said = (text: string, extra: Partial<ChatEvent> = {}): ChatEvent =>
  ({ kind: 'assistant', id: text, ts: 1, text, ...extra }) as ChatEvent;
const tool = (): ChatEvent =>
  ({ kind: 'tool_use', id: 't', ts: 1, name: 'Bash', input: {} }) as unknown as ChatEvent;

describe('lastMessageOf', () => {
  it('is the last thing said, by either side', () => {
    expect(lastMessageOf([user('hi'), said('hello there')])).toEqual({
      text: 'hello there',
      by: 'assistant',
    });
    expect(lastMessageOf([said('done'), user('thanks, now ship it')])).toEqual({
      text: 'thanks, now ship it',
      by: 'user',
    });
  });

  it('looks past a tool-only tail to the last words', () => {
    expect(lastMessageOf([said('running the suite'), tool(), tool()])?.text).toBe(
      'running the suite',
    );
  });

  it('skips folded plumbing — a cron prompt nobody typed is not a message', () => {
    expect(lastMessageOf([said('real answer'), user('cron prompt', { folded: true })])?.text).toBe(
      'real answer',
    );
  });

  it('in Chat mode, never leaks the private scratchpad — only `reply` reached the person', () => {
    const events = [said('the answer', { voice: 'reply' }), said('my private notes on it')];
    expect(lastMessageOf(events)).toEqual({ text: 'the answer', by: 'assistant' });
  });

  it('flattens to one line and truncates with an ellipsis', () => {
    const long = `first\n\nsecond   line ${'x'.repeat(400)}`;
    const out = lastMessageOf([said(long)])?.text ?? '';
    expect(out.startsWith('first second line x')).toBe(true);
    expect(out).toHaveLength(PREVIEW_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is null for a chat that has said nothing yet', () => {
    expect(lastMessageOf([])).toBeNull();
    expect(lastMessageOf([tool(), said('   ')])).toBeNull();
  });
});

describe('GET /api/tabs/previews', () => {
  let test: TestApp;
  let db: Database.Database;
  let tmp: string;
  let a: string;

  beforeEach(async () => {
    resetLastMessageMemo();
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-previews-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
    const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
    a = new TabStore(db).create({ name: 'a', layout: '', workspace_id: ws }).id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('answers for the ids asked — null for a chat with no transcript, absent for no tab', async () => {
    const res = await test.app.request(`/api/tabs/previews?ids=${a},nope`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { previews: Record<string, unknown> };
    expect(body.previews).toEqual({ [a]: null });
  });

  it('is routed ahead of `/:id` — "previews" is not a tab id', async () => {
    const res = await test.app.request('/api/tabs/previews');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ previews: {} });
  });
});
