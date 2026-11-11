import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { runMigrations } from '../store/migrations.js';
import { runRebase, stripResume } from './rebase-run.js';

/**
 * REBASING MUST NOT COST A CHAT ITS CONTEXT.
 *
 * The whole feature is "keep this conversation, lose the stale instructions",
 * so the order of operations is the design: brief FIRST, and only destroy the
 * session once there is something to seed the next one with.
 */
describe('stripResume', () => {
  it('drops the resume so the next boot is a NEW conversation', () => {
    expect(stripResume('muxpad agent --resume 1a2b3c --model opus')).toBe(
      'muxpad agent --model opus',
    );
  });

  it('accepts the equals spelling, which the arg parser also takes', () => {
    expect(stripResume('muxpad agent --resume=1a2b3c')).toBe('muxpad agent');
  });

  it('leaves everything else exactly as the user wrote it', () => {
    // A rebase that quietly changed the backend, the model or the mode would
    // change what the chat IS while claiming to refresh it.
    const cmd = 'muxpad agent --backend codex --mode chat --model gpt-5 --resume abc';
    expect(stripResume(cmd)).toBe('muxpad agent --backend codex --mode chat --model gpt-5');
  });

  it('is a no-op on a command that never resumed', () => {
    expect(stripResume('muxpad agent --mode chat')).toBe('muxpad agent --mode chat');
  });
});

function fixture(startupCmd: string | null) {
  const db = new Database(':memory:');
  runMigrations(db);
  const ws = new WorkspaceStore(db).create({ name: 'w' });
  const tab = new TabStore(db).create({ workspace_id: ws.id, name: 't', layout: 'p' });
  const pane = new PaneStore(db).create({
    tab_id: tab.id,
    kind: 'shell',
    startup_cmd: startupCmd,
  });
  new AgentSessionStore(db).register({
    pane_id: pane.id,
    assistant: 'claude',
    session_id: 'old-sid',
  });
  return { db, paneId: pane.id };
}

describe('runRebase', () => {
  const ok = { status: 'queued' as const };

  it('briefs, strips the resume, respawns, and hands the briefing over', async () => {
    const { db, paneId } = fixture('muxpad agent --resume old-sid');
    const calls: string[] = [];
    let delivered = '';
    const r = await runRebase(
      {
        db,
        respawn: async () => {
          calls.push('respawn');
        },
        submit: (_p, text) => {
          calls.push('submit');
          delivered = text;
          return ok;
        },
        brief: async () => {
          calls.push('brief');
          return 'goal: ship the broker';
        },
      },
      paneId,
      'fresh',
    );
    expect(r.ok).toBe(true);
    // The briefing is written BEFORE the runner dies — see below for why.
    expect(calls).toEqual(['brief', 'respawn', 'submit']);
    expect(new PaneStore(db).getById(paneId)?.startup_cmd).toBe('muxpad agent');
    // Delivered inside its own block, which tells the fresh session that the
    // history is not in its window and its own instructions are the current ones.
    expect(delivered).toContain('<muxpad-rebase>');
    expect(delivered).toContain('goal: ship the broker');
  });

  it('REFUSES rather than destroying a chat it could not summarise', async () => {
    // The one failure that must never be partial: killing the runner and then
    // failing to brief would throw away a working conversation for nothing.
    const { db, paneId } = fixture('muxpad agent --resume old-sid');
    let respawned = false;
    const r = await runRebase(
      {
        db,
        respawn: async () => {
          respawned = true;
        },
        submit: () => ok,
        brief: async () => null,
      },
      paneId,
      'fresh',
    );
    expect(r).toMatchObject({ ok: false, code: 'no_briefing' });
    expect(respawned).toBe(false);
    expect(new PaneStore(db).getById(paneId)?.startup_cmd).toBe('muxpad agent --resume old-sid');
  });

  it('will not rebase a pane that runs no agent', async () => {
    const { db, paneId } = fixture('htop');
    let briefed = false;
    const r = await runRebase(
      {
        db,
        respawn: async () => {},
        submit: () => ok,
        brief: async () => {
          briefed = true;
          return 'x';
        },
      },
      paneId,
    );
    expect(r).toMatchObject({ ok: false, code: 'not_an_agent' });
    // Not even summarised: a terminal has no conversation to summarise.
    expect(briefed).toBe(false);
  });

  it('says so when the briefing could not be handed over', async () => {
    // The chat HAS been restarted by then. Reporting success would leave a
    // blank agent that believes it was briefed — worse than a stale one.
    const { db, paneId } = fixture('muxpad agent --resume old-sid');
    const r = await runRebase(
      {
        db,
        respawn: async () => {},
        submit: () => ({ status: 'rejected', reason: 'agent exited' }),
        brief: async () => 'goal: ship it',
      },
      paneId,
      'fresh',
    );
    expect(r).toMatchObject({ ok: false, code: 'not_delivered' });
    expect((r as { message: string }).message).toContain('agent exited');
  });
});

describe('runRebase — the transcript rebase is the default', () => {
  const ok = { status: 'queued' as const };
  const rebased = {
    ok: true as const,
    sid: 'new-sid',
    path: '/x/new-sid.jsonl',
    kept: 12,
    briefed: false,
    tokens: { total: 1, kept: 1, budget: 1, window: 1 },
    stats: {} as never,
  };

  it('keeps the history: points the pane at the rebased session and respawns', async () => {
    // "i want the history but I WANT IT REBASED ON THE NEW INSTRUCTIONS."
    const { db, paneId } = fixture('muxpad agent --mode chat --resume old-sid');
    const calls: string[] = [];
    const r = await runRebase(
      {
        db,
        transcript: async () => {
          // Written and verified BEFORE the pane is touched in any way.
          expect(new PaneStore(db).getById(paneId)?.startup_cmd).toBe(
            'muxpad agent --mode chat --resume old-sid',
          );
          calls.push('transcript');
          return rebased;
        },
        respawn: async () => {
          // …and the runner restarts INTO the rebased session.
          expect(new PaneStore(db).getById(paneId)?.startup_cmd).toBe(
            'muxpad agent --mode chat --resume new-sid',
          );
          calls.push('respawn');
        },
        submit: () => {
          calls.push('submit');
          return ok;
        },
        brief: async () => {
          calls.push('brief');
          return 'x';
        },
      },
      paneId,
    );
    expect(r).toMatchObject({ ok: true, mode: 'transcript', sid: 'new-sid' });
    // No summary, nothing injected: the conversation IS the context.
    expect(calls).toEqual(['transcript', 'respawn']);
    const sess = new AgentSessionStore(db).getByPane(paneId);
    expect(sess?.current_sid).toBe('new-sid');
    // The old session stays in the lineage — it is the way back.
    expect(sess?.lineage).toEqual(['old-sid', 'new-sid']);
  });

  it('falls back to the briefing when the transcript cannot be replayed', async () => {
    const { db, paneId } = fixture('muxpad agent --resume old-sid');
    const calls: string[] = [];
    const r = await runRebase(
      {
        db,
        transcript: async () => ({
          ok: false,
          reason: 'last_turn_too_large',
          detail: 'one huge turn',
        }),
        respawn: async () => {
          calls.push('respawn');
        },
        submit: () => {
          calls.push('submit');
          return ok;
        },
        brief: async () => {
          calls.push('brief');
          return 'goal';
        },
      },
      paneId,
    );
    expect(r).toMatchObject({ ok: true, mode: 'fresh' });
    expect((r as { fallback?: string }).fallback).toMatch(/last_turn_too_large/);
    expect(calls).toEqual(['brief', 'respawn', 'submit']);
  });

  it('refuses a chat on another machine outright — no briefing, no restart', async () => {
    const { db, paneId } = fixture('muxpad agent --resume old-sid');
    let touched = false;
    const r = await runRebase(
      {
        db,
        transcript: async () => ({ ok: false, reason: 'elsewhere', detail: 'runs on trayo' }),
        respawn: async () => {
          touched = true;
        },
        submit: () => ok,
        brief: async () => {
          touched = true;
          return 'x';
        },
      },
      paneId,
    );
    expect(r).toMatchObject({ ok: false, code: 'elsewhere' });
    expect(touched).toBe(false);
  });

  it('puts everything back when the restart fails', async () => {
    const { db, paneId } = fixture('muxpad agent --resume old-sid');
    const discarded: string[] = [];
    const r = await runRebase(
      {
        db,
        transcript: async () => rebased,
        respawn: async () => {
          throw new Error('ptyd unreachable');
        },
        discard: (p) => discarded.push(p),
        submit: () => ok,
      },
      paneId,
    );
    expect(r).toMatchObject({ ok: false, code: 'respawn_failed' });
    expect(new PaneStore(db).getById(paneId)?.startup_cmd).toBe('muxpad agent --resume old-sid');
    expect(new AgentSessionStore(db).getByPane(paneId)?.current_sid).toBe('old-sid');
    expect(discarded).toEqual(['/x/new-sid.jsonl']);
  });
});
