import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTIONS_SEED,
  INSTRUCTION_TOPICS,
  agentInstructionsPath,
  readAgentInstructions,
} from './agent-instructions.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsctx-'));
  writeFileSync(agentInstructionsPath(dir), AGENT_INSTRUCTIONS_SEED);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('shared agent instructions', () => {
  it('names Slack without a workspace capability or lookup', () => {
    // Slack is scoped by MACHINE, by the broker, not by a per-workspace flag
    // nobody could see. What the resident page owes a chat is that the
    // capability EXISTS; the manual itself is one `muxpad help slack` away
    // (INSTRUCTION_TOPICS), which is what took a session's opening cost from
    // ~12,900 tokens to ~1,200.
    const text = readAgentInstructions(dir) ?? '';
    expect(text).toContain('slack');
    expect(text).toContain('muxpad help <topic>');
    expect(text).not.toContain('SLACK IS A WORKSPACE CAPABILITY');
    // The markers are machinery, never injected.
    expect(text).not.toContain('cap:slack');
    expect(INSTRUCTION_TOPICS.slack).toContain('SLACK REQUIRES HUMAN APPROVAL');
  });

  it('drops the row entirely on a machine the broker refuses', () => {
    const text = readAgentInstructions(dir, (c) => c !== 'slack') ?? '';
    expect(text).not.toContain('sent AS THE USER');
    expect(text).toContain('msgvault');
  });
});
