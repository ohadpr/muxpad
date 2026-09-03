// The Claude backend spawns a real Agent SDK session at construction, so —
// unlike codex/cursor, whose fake-spawner tests exercise the whole backend —
// the universal-instructions injection is tested at its seam:
// claudeSystemPromptOption builds the exact `systemPrompt` option the backend
// spreads into the SDK query() Options.
import type { SubagentProgress } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { SubagentRoster } from '../subagent-roster.js';
import { applyTaskLifecycle, claudeSystemPromptOption, isTaskLifecycle } from './claude.js';

describe('claude backend — universal muxpad instructions', () => {
  it('appends the instructions to the default claude_code preset (native SDK mechanism)', () => {
    expect(claudeSystemPromptOption('use muxpad publish')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'use muxpad publish',
    });
  });

  it('missing file → no systemPrompt option at all (inject nothing, no error)', () => {
    expect(claudeSystemPromptOption(null)).toBeUndefined();
  });
});

describe('claude backend — ⚡ Do-mode overlay (same native preset+append seam)', () => {
  it('appends the mode overlay AFTER the universal instructions', () => {
    // Order is load-bearing: capabilities first, behavior last, so the
    // behavioral contract reads as the most recent (governing) instruction.
    expect(claudeSystemPromptOption('use muxpad publish', '# Do mode\nbe terse')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'use muxpad publish\n\n# Do mode\nbe terse',
    });
  });

  it('deep mode (null overlay) is byte-for-byte the pre-mode option', () => {
    expect(claudeSystemPromptOption('use muxpad publish', null)).toEqual(
      claudeSystemPromptOption('use muxpad publish'),
    );
  });

  it('overlay alone still injects (a user who deleted agent-instructions.md)', () => {
    expect(claudeSystemPromptOption(null, '# Do mode')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: '# Do mode',
    });
  });

  it('both missing → no systemPrompt option at all', () => {
    expect(claudeSystemPromptOption(null, null)).toBeUndefined();
  });

  it('whitespace-only inputs count as absent (no empty append block)', () => {
    expect(claudeSystemPromptOption('  \n ', '\t')).toBeUndefined();
  });
});

// The SDK's task channel is the roster's source of truth, and every id field
// on those messages is OPTIONAL in the declarations. These pin the shapes —
// the session loop itself can't be tested (constructing the backend spawns a
// real SDK session), which is exactly why the dispatch is split out.
describe('claude backend — SDK task lifecycle → roster', () => {
  function make() {
    const sent: SubagentProgress[] = [];
    const roster = new SubagentRoster((p) => sent.push(p));
    return { roster, sent };
  }
  const ids = (r: SubagentRoster) => r.values().map((p) => p.toolUseId);

  it('recognises exactly the four task subtypes', () => {
    for (const s of [
      'task_started',
      'task_notification',
      'task_updated',
      'background_tasks_changed',
    ])
      expect(isTaskLifecycle(s)).toBe(true);
    for (const s of ['init', 'compact_boundary', 'commands_changed'])
      expect(isTaskLifecycle(s)).toBe(false);
  });

  it('task_started binds, task_notification retires — the happy path', () => {
    const { roster } = make();
    roster.launch('tu_1', 'worker');
    applyTaskLifecycle(roster, {
      subtype: 'task_started',
      task_id: 'task_1',
      tool_use_id: 'tu_1',
    });
    applyTaskLifecycle(roster, {
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'task_1' }],
    });
    expect(ids(roster)).toEqual(['tu_1']);
    applyTaskLifecycle(roster, {
      subtype: 'task_notification',
      task_id: 'task_1',
      tool_use_id: 'tu_1',
    });
    expect(roster.size).toBe(0);
  });

  it('retires on a task_notification that OMITS tool_use_id (it is optional)', () => {
    // Keying only on tool_use_id would leave this entry with no edge end-path.
    const { roster } = make();
    roster.launch('tu_1', 'worker');
    applyTaskLifecycle(roster, { subtype: 'task_started', task_id: 'task_1', tool_use_id: 'tu_1' });
    applyTaskLifecycle(roster, { subtype: 'task_notification', task_id: 'task_1' });
    expect(roster.size).toBe(0);
  });

  it('retires on a terminal task_updated, which carries no tool_use_id at all', () => {
    for (const status of ['completed', 'failed', 'killed']) {
      const { roster } = make();
      roster.launch('tu_1', 'worker');
      applyTaskLifecycle(roster, {
        subtype: 'task_started',
        task_id: 'task_1',
        tool_use_id: 'tu_1',
      });
      applyTaskLifecycle(roster, { subtype: 'task_updated', task_id: 'task_1', patch: { status } });
      expect(roster.size).toBe(0);
    }
  });

  it('a PAUSED task is not swept by the level signal (pause is a live agent)', () => {
    // The worst failure mode is evicting a live agent. The level payload's
    // documented membership changes don't mention pause, so a paused-but-live
    // task dropping out of it must not read as an end.
    const { roster } = make();
    roster.launch('tu_1', 'worker');
    applyTaskLifecycle(roster, { subtype: 'task_started', task_id: 'task_1', tool_use_id: 'tu_1' });
    applyTaskLifecycle(roster, {
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'task_1' }],
    });
    applyTaskLifecycle(roster, {
      subtype: 'task_updated',
      task_id: 'task_1',
      patch: { status: 'paused' },
    });
    applyTaskLifecycle(roster, { subtype: 'background_tasks_changed', tasks: [] });
    expect(ids(roster)).toEqual(['tu_1']);
    // Resumed and live again → eligible once more, and its real end lands.
    applyTaskLifecycle(roster, {
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'task_1' }],
    });
    applyTaskLifecycle(roster, { subtype: 'background_tasks_changed', tasks: [] });
    expect(roster.size).toBe(0);
  });

  it('a task_started with no tool_use_id binds nothing rather than mis-binding', () => {
    const { roster } = make();
    roster.launch('tu_1', 'worker');
    applyTaskLifecycle(roster, { subtype: 'task_started', task_id: 'task_1' });
    // Unbound, so the level signal leaves it alone (only tool_result /
    // retireAll can end it) — never mis-attached to the wrong row.
    applyTaskLifecycle(roster, { subtype: 'background_tasks_changed', tasks: [] });
    expect(ids(roster)).toEqual(['tu_1']);
  });

  it('nested agents and background Bash cannot create rows', () => {
    const { roster, sent } = make();
    applyTaskLifecycle(roster, {
      subtype: 'task_started',
      task_id: 'task_nested',
      tool_use_id: 'tu_nested',
    });
    applyTaskLifecycle(roster, {
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'task_nested' }, { task_id: 'bash_task' }],
    });
    applyTaskLifecycle(roster, { subtype: 'task_notification', task_id: 'task_nested' });
    expect(roster.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a level payload with no tasks field is an empty set, not a crash', () => {
    const { roster } = make();
    roster.launch('tu_1', 'worker');
    applyTaskLifecycle(roster, { subtype: 'background_tasks_changed' });
    expect(roster.size).toBe(1); // unbound, so untouched
  });
});
