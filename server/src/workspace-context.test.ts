import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTIONS_SEED,
  agentInstructionsPath,
  readAgentInstructions,
} from './agent-instructions.js';

/**
 * A CAPABILITY A CHAT CANNOT USE IS NOT DESCRIBED TO IT.
 *
 * `readAgentInstructions(dataDir)` took a directory and nothing else, so every
 * agent in every workspace got byte-identical text — including the Slack
 * section. A Personal chat was told it had the company Slack and found out
 * otherwise by trying. Advertising a capability to exactly the contexts that
 * must never have it is how an agent comes to attempt it.
 */
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsctx-'));
  writeFileSync(agentInstructionsPath(dir), AGENT_INSTRUCTIONS_SEED);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('per-workspace instructions', () => {
  it('omits the whole Slack section when the capability is off', () => {
    const out = readAgentInstructions(dir, { slack: false }) ?? '';
    expect(out).not.toContain('muxpad slack');
    // …and the rest survives intact.
    expect(out).toContain('muxpad publish');
    expect(out).toContain('muxpad cron');
  });

  it('includes it when the capability is on', () => {
    const out = readAgentInstructions(dir, { slack: true }) ?? '';
    expect(out).toContain('muxpad slack');
  });

  it('DEFAULTS TO OFF when nobody passed a workspace', () => {
    // "Nobody said" has to mean no for a capability gate. A caller that has
    // not been taught to pass the workspace must not silently hand out Slack.
    expect(readAgentInstructions(dir) ?? '').not.toContain('muxpad slack');
  });

  it('never leaves the fence markers in what an agent reads', () => {
    for (const slack of [true, false]) {
      const out = readAgentInstructions(dir, { slack }) ?? '';
      expect(out, `slack=${slack}`).not.toContain('cap:slack');
      expect(out, `slack=${slack}`).not.toContain('<!--');
    }
  });

  it('appends the workspace text after muxpad’s own', () => {
    const out =
      readAgentInstructions(dir, { slack: true, instructions: 'Prefer pnpm here.' }) ?? '';
    expect(out).toContain('Prefer pnpm here.');
    expect(out.indexOf('muxpad publish')).toBeLessThan(out.indexOf('Prefer pnpm here.'));
  });

  it('contributes nothing for an empty or absent workspace text', () => {
    const a = readAgentInstructions(dir, { slack: true, instructions: '   ' }) ?? '';
    const b = readAgentInstructions(dir, { slack: true }) ?? '';
    expect(a).toBe(b);
  });

  it('does not leave a hole where the section was', () => {
    // Stripping a fenced block must not leave a run of blank lines that reads
    // as a formatting bug in the prompt.
    expect(readAgentInstructions(dir, { slack: false }) ?? '').not.toMatch(/\n{3,}/);
  });
});
