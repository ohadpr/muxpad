import { parseDirectMarker, parseReportMarker } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { reportTargetPane, spawnBrief } from './spawn-brief.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { runMigrations } from './store/migrations.js';

/**
 * WHERE THE ANSWER IS ADDRESSED, which is the only thing this file can get
 * wrong — and the way it gets wrong is silent. A briefing pointed at a pane that
 * cannot take a message is a command that fails in the worker's face, which is
 * worse than no instruction at all: the worker learns that reporting does not
 * work here.
 */
describe('spawnBrief — the report-back contract a spawned chat is born with', () => {
  let db: Database.Database;
  let tabs: TabStore;
  let panes: PaneStore;
  let workspaceId: string;

  /** A chat with one AGENT pane — the `muxpad agent` startup command is the
   *  durable marker submitSend itself gates on. */
  function chat(name: string, parent?: string): { tab: string; pane: string } {
    const t = tabs.create({
      name,
      layout: '',
      workspace_id: workspaceId,
      ...(parent ? { spawned_by: parent } : {}),
    });
    const p = panes.create({
      tab_id: t.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent --mode chat',
      face: 'chat',
    });
    return { tab: t.id, pane: p.id };
  }

  /** A tab with a plain shell in it — `muxpad agent new` run from a terminal. */
  function terminal(name: string): { tab: string; pane: string } {
    const t = tabs.create({ name, layout: '', workspace_id: workspaceId });
    const p = panes.create({ tab_id: t.id, shell: '/bin/zsh', cwd: '/tmp' });
    return { tab: t.id, pane: p.id };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tabs = new TabStore(db);
    panes = new PaneStore(db);
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  it('addresses the report at the pane the spawn CAME FROM', () => {
    const parent = chat('Sidebar work');
    const child = chat('build-a2', parent.tab);
    const brief = spawnBrief(db, {
      parentTabId: parent.tab,
      spawnedByPane: parent.pane,
      childTabId: child.tab,
      childPane: child.pane,
    });
    expect(parseDirectMarker(brief ?? '')?.marker).toEqual({
      id: child.tab,
      from: 'Sidebar work',
      pane: parent.pane,
    });
  });

  it('pre-fills the answer with the CHILD’s name and pane', () => {
    const parent = chat('Sidebar work');
    const child = chat('build-a2', parent.tab);
    const brief = spawnBrief(db, {
      parentTabId: parent.tab,
      spawnedByPane: parent.pane,
      childTabId: child.tab,
      childPane: child.pane,
    });
    const template = (brief ?? '').slice((brief ?? '').indexOf('<muxpad-report'));
    expect(parseReportMarker(template)?.marker).toEqual({
      id: child.tab,
      from: 'build-a2',
      pane: child.pane,
    });
  });

  it('ends with a blank line, so the caller’s task simply follows it', () => {
    // The division of labour: the server owns the half that must not be
    // improvised, the spawner owns the task. `brief + task` has to be the string
    // a one-shot compose would have produced.
    const parent = chat('Sidebar work');
    const child = chat('kid', parent.tab);
    const brief =
      spawnBrief(db, { parentTabId: parent.tab, childTabId: child.tab, childPane: child.pane }) ??
      '';
    expect(brief.endsWith('\n\n')).toBe(true);
    expect(parseDirectMarker(`${brief}do the thing`)?.body).toBe('do the thing');
  });

  it('falls back to the parent tab’s own agent pane when the spawning pane is a terminal', () => {
    // A chat with a terminal beside its agent: `muxpad agent new` run in the
    // terminal carries THAT pane id, and it cannot receive a send. The answer
    // still belongs in this chat's conversation.
    const parent = chat('Sidebar work');
    const shell = panes.create({ tab_id: parent.tab, shell: '/bin/zsh', cwd: '/tmp' });
    const child = chat('kid', parent.tab);
    const brief = spawnBrief(db, {
      parentTabId: parent.tab,
      spawnedByPane: shell.id,
      childTabId: child.tab,
      childPane: child.pane,
    });
    expect(parseDirectMarker(brief ?? '')?.marker.pane).toBe(parent.pane);
  });

  it('is NULL when the parent has no pane that could accept a send', () => {
    // Spawned from a plain terminal tab. There is no conversation to report
    // into, and an instruction naming that pane would be a command whose failure
    // the worker has to interpret.
    const parent = terminal('just a shell');
    const child = chat('kid', parent.tab);
    expect(
      spawnBrief(db, {
        parentTabId: parent.tab,
        spawnedByPane: parent.pane,
        childTabId: child.tab,
        childPane: child.pane,
      }),
    ).toBeNull();
  });

  it('is NULL when the parent row is gone', () => {
    // Nothing is cascaded in this model, so a dangling parent is an expected
    // state — and a spawn must not fail over provenance.
    const child = chat('orphan');
    expect(spawnBrief(db, { parentTabId: 'no-such-tab', childTabId: child.tab })).toBeNull();
  });

  describe('reportTargetPane', () => {
    it('refuses a preferred pane that belongs to another tab', () => {
      // A pane id from somewhere else is not the parent's conversation, whatever
      // the caller meant by passing it.
      const parent = chat('parent');
      const other = chat('unrelated');
      expect(reportTargetPane(db, parent.tab, other.pane)).toBe(parent.pane);
    });

    it('ignores a CONVERTED pane that renders as a chat but has no runner', () => {
      // `isAgentPane` counts the `chat` face; submitSend does not. This has to
      // agree with the thing that will actually accept the message.
      const t = tabs.create({ name: 'converted', layout: '', workspace_id: workspaceId });
      panes.create({ tab_id: t.id, shell: '/bin/zsh', cwd: '/tmp', face: 'chat' });
      expect(reportTargetPane(db, t.id)).toBeNull();
    });
  });
});
