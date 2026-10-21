import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTIONS_SEED,
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
  it('describes Slack without a workspace capability or lookup', () => {
    const text = readAgentInstructions(dir) ?? '';
    expect(text).toContain('muxpad slack');
    expect(text).toContain('SLACK REQUIRES HUMAN APPROVAL');
    expect(text).not.toContain('SLACK IS A WORKSPACE CAPABILITY');
    expect(text).not.toContain('cap:slack');
    expect(text).toContain('muxpad publish');
  });
});
