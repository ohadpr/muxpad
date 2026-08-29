import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTIONS_SEED,
  agentInstructionsPath,
  readAgentInstructions,
  seedAgentInstructions,
  wrapAgentInstructions,
} from './agent-instructions.js';

describe('agent-instructions', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-instr-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('seeds the file once at boot with muxpad capability content', () => {
    seedAgentInstructions(dataDir);
    const text = readFileSync(agentInstructionsPath(dataDir), 'utf8');
    expect(text).toBe(AGENT_INSTRUCTIONS_SEED);
    expect(text).toContain('muxpad search');
    expect(text).toContain('muxpad publish');
    expect(text).toContain('muxpad --help');
  });

  it('never overwrites a user-owned file on re-seed', () => {
    seedAgentInstructions(dataDir);
    writeFileSync(agentInstructionsPath(dataDir), 'my own rules\n');
    seedAgentInstructions(dataDir); // boot again
    expect(readFileSync(agentInstructionsPath(dataDir), 'utf8')).toBe('my own rules\n');
  });

  it('read returns the file content, and null for missing/empty (no error)', () => {
    expect(readAgentInstructions(dataDir)).toBeNull(); // missing → inject nothing
    writeFileSync(agentInstructionsPath(dataDir), '   \n'); // emptied by the user
    expect(readAgentInstructions(dataDir)).toBeNull();
    writeFileSync(agentInstructionsPath(dataDir), 'use muxpad publish\n');
    expect(readAgentInstructions(dataDir)).toBe('use muxpad publish\n');
  });

  it('wraps fallback injections in a clearly delimited block', () => {
    expect(wrapAgentInstructions('use muxpad publish\n')).toBe(
      '<muxpad-instructions>\nuse muxpad publish\n</muxpad-instructions>',
    );
  });
});
