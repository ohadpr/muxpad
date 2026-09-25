import { describe, expect, it } from 'vitest';
import { liveStatusLabel } from './live-status';

describe('liveStatusLabel', () => {
  it('hides when nothing is running at all', () => {
    expect(liveStatusLabel({ agentCount: 0, turnActive: false })).toBeNull();
  });

  // The reported bug. The bar showed something running ONLY when subagents
  // happened to exist, so an ordinary turn — the common case — left it looking
  // idle while the sidebar row for the same pane said `working`.
  it('says Working for a turn with no subagents', () => {
    expect(liveStatusLabel({ agentCount: 0, turnActive: true })).toBe('Working…');
  });

  it('prefers the agent count when subagents exist — it is more informative', () => {
    expect(liveStatusLabel({ agentCount: 2, turnActive: true })).toBe('2 agents');
  });

  it('singularizes one agent', () => {
    expect(liveStatusLabel({ agentCount: 1, turnActive: true })).toBe('1 agent');
  });

  // A subagent can outlive the turn that launched it, which is why the roster
  // is checked first and independently of `turnActive`.
  it('still reports subagents running after their turn ended', () => {
    expect(liveStatusLabel({ agentCount: 3, turnActive: false })).toBe('3 agents');
  });

  it('treats a missing turnActive as not running, so old callers are unchanged', () => {
    expect(liveStatusLabel({ agentCount: 0 })).toBeNull();
    expect(liveStatusLabel({ agentCount: 2 })).toBe('2 agents');
  });
});
