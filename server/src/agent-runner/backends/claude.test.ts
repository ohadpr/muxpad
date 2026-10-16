// The Claude backend spawns a real Agent SDK session at construction, so —
// unlike codex/cursor, whose fake-spawner tests exercise the whole backend —
// the universal-instructions injection is tested at its seam:
// claudeSystemPromptOption builds the exact `systemPrompt` option the backend
// spreads into the SDK query() Options.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_LAUNCH_TOOLS, type SubagentProgress, isAgentLaunchTool } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { SubagentRoster } from '../subagent-roster.js';
import {
  applyTaskLifecycle,
  claudeSystemPromptOption,
  isTaskLifecycle,
  reportToolDescription,
} from './claude.js';

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

describe('claude backend — Chat-mode overlay (same native preset+append seam)', () => {
  it('appends the mode overlay AFTER the universal instructions', () => {
    // Order is load-bearing: capabilities first, behavior last, so the
    // behavioral contract reads as the most recent (governing) instruction.
    expect(claudeSystemPromptOption('use muxpad publish', '# Chat mode\nbe terse')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'use muxpad publish\n\n# Chat mode\nbe terse',
    });
  });

  it('deep mode (null overlay) is byte-for-byte the pre-mode option', () => {
    expect(claudeSystemPromptOption('use muxpad publish', null)).toEqual(
      claudeSystemPromptOption('use muxpad publish'),
    );
  });

  it('overlay alone still injects (a user who deleted agent-instructions.md)', () => {
    expect(claudeSystemPromptOption(null, '# Chat mode')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: '# Chat mode',
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

describe('claude backend — one delegation primitive', () => {
  // The SDK session is built at construction, so the OPTION itself cannot be
  // read back without spawning one. What can be asserted is the wiring: the
  // disallow list and the transcript's recogniser must be THE SAME LIST, or a
  // tool is removed under one name and rendered under another — a launch that
  // becomes a bare tool row in the log it already occupies.
  const SRC = readFileSync(join(__dirname, 'claude.ts'), 'utf8');

  it('hands the SDK the shared launch-tool list, not a second copy', () => {
    expect(SRC).toContain('disallowedTools: [...AGENT_LAUNCH_TOOLS]');
    expect(AGENT_LAUNCH_TOOLS).toEqual(['Agent', 'Task']);
  });

  it('still RECOGNISES a historical launch — the past is not deleted with it', () => {
    // Every transcript on this machine predates the removal and contains
    // these. They must keep rendering as launches.
    for (const name of AGENT_LAUNCH_TOOLS) expect(isAgentLaunchTool(name)).toBe(true);
    expect(isAgentLaunchTool('Bash')).toBe(false);
  });

  it('tells the model there is no second way, rather than letting it hunt', () => {
    // A tool removed from context with no instruction to match reads, from the
    // inside, as a harness that lost a capability — and the model plans around
    // it by shelling out, which is the invisible-work failure this exists to
    // stop.
    const instructions = readFileSync(join(__dirname, '..', '..', 'agent-instructions.ts'), 'utf8');
    expect(instructions).toContain('There is no second way to delegate');
    // A phrase that does not wrap: the file is prose at 80 columns, and a
    // substring that happens to straddle a line break asserts the margin
    // rather than the sentence.
    expect(instructions).toContain('do not look for them');
  });
});

describe('the report tool says what it is for', () => {
  // Its description is the whole instruction: there is deliberately nothing
  // about this tool in the universal agent instructions, because a sentence
  // there is read by every chat in the install and most of them have nobody to
  // report to.
  const d = reportToolDescription();

  it('names the audience as the chat that spawned you, not a person', () => {
    // The generator this replaces needed a rejection pass for reports written
    // to a reader ("as you can see…"), which read as nonsense in an
    // orchestrator's log.
    expect(d).toMatch(/spawned you/);
    expect(d).toMatch(/not by a person|read by the agent/);
  });

  it('says it does NOT end the turn, and that the last statement wins', () => {
    // A worker that treats this as a goodbye stops working; one held to its
    // first answer cannot correct itself.
    expect(d).toMatch(/does not end your turn/);
    expect(d).toMatch(/last statement/);
  });

  it('says NOT calling it is survivable', () => {
    // A tool whose description implies data loss gets called defensively on
    // every turn. muxpad still summarises a worker that said nothing.
    expect(d).toMatch(/If you never call it/);
    expect(d).toMatch(/summarises your transcript/);
  });

  it('is offered in BOTH modes, like notify and unlike reply', () => {
    // Sub-chats are spawned in agent mode at least as often as in chat mode; a
    // worker whose MODE decided whether it could state its own result is the
    // kind of surprise this removes.
    const SRC = readFileSync(join(__dirname, 'claude.ts'), 'utf8');
    const block = SRC.slice(SRC.indexOf('tools:'), SRC.indexOf('alwaysLoad: true'));
    const arms = block.split('?')[1] ?? '';
    const [chatArm, agentArm] = arms.split(':');
    expect(chatArm).toContain('reportTool');
    expect(agentArm).toContain('reportTool');
  });

  it('is NOT taught in the universal instructions', () => {
    // The constraint this was designed under: the tool's own description is
    // read at the moment of relevance; an instruction is read by everyone.
    const instructions = readFileSync(join(__dirname, '..', '..', 'agent-instructions.ts'), 'utf8');
    expect(instructions).not.toMatch(/muxpad report|`report` tool/);
  });
});
