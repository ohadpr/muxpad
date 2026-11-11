import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
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
  return { db, paneId: pane.id };
}

describe('runRebase', () => {
  const ok = { status: 'queued' as const };

  it('KEEPS the history by default — it rebases, it does not compact', () => {
    // "i want the history but I WANT IT REBASED ON THE NEW INSTRUCTIONS."
    // Nothing is summarised and the `--resume` is left exactly as it is: the
    // process is new, so the system prompt is rebuilt from today's
    // agent-instructions.md, and the conversation rides along untouched.
    const { db, paneId } = fixture('muxpad agent --resume old-sid');
    const calls: string[] = [];
    return runRebase(
      {
        db,
        respawn: async () => {
          calls.push('respawn');
        },
        submit: () => {
          calls.push('submit');
          return ok;
        },
        brief: async () => {
          calls.push('brief');
          return 'goal: ship it';
        },
      },
      paneId,
    ).then((r) => {
      expect(r.ok).toBe(true);
      // No summary written, nothing injected — just a new process.
      expect(calls).toEqual(['respawn']);
      // AND THE RESUME SURVIVES. Stripping it here would silently turn the
      // default into the thing it replaced.
      expect(new PaneStore(db).getById(paneId)?.startup_cmd).toBe('muxpad agent --resume old-sid');
    });
  });

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
      'fresh',
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
