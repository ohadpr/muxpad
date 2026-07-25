import { describe, expect, it } from 'vitest';
import { liveStatusLabel } from './live-status';

describe('liveStatusLabel', () => {
  it('hides when no subagents are running', () => {
    expect(liveStatusLabel({ agentCount: 0 })).toBeNull();
  });

  it('shows agent count only (parent Working lives in the transcript)', () => {
    expect(liveStatusLabel({ agentCount: 2 })).toBe('2 agents');
  });

  it('singularizes one agent', () => {
    expect(liveStatusLabel({ agentCount: 1 })).toBe('1 agent');
  });
});
