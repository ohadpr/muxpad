import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaneStatusSchema } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentNotesPath, generatedBody, sha256 } from './agent-files.js';
import {
  AGENT_INSTRUCTIONS_SEED,
  INSTRUCTIONS_MIGRATION,
  SHIPPED_INSTRUCTIONS_DEFAULTS,
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

  it('generates the file at boot with muxpad capability content', () => {
    seedAgentInstructions(dataDir);
    const text = readFileSync(agentInstructionsPath(dataDir), 'utf8');
    expect(text).toBe(generatedBody(AGENT_INSTRUCTIONS_SEED));
    expect(text).toContain('muxpad search');
    expect(text).toContain('muxpad publish');
    expect(text).toContain('muxpad --help');
  });

  it('tells every agent to schedule with muxpad, NOT with its own harness cron', () => {
    // The whole point of shipping `muxpad cron` is that agents stop reaching
    // for a session-scoped scheduler that silently expires and never catches
    // up. If the seed stops SAYING so, the feature quietly stops being used.
    expect(AGENT_INSTRUCTIONS_SEED).toContain('DO NOT use');
    expect(AGENT_INSTRUCTIONS_SEED).toContain('muxpad cron new');
    expect(AGENT_INSTRUCTIONS_SEED).toContain('--pane');
    for (const verb of ['cron list', 'cron run', 'cron pause', 'cron rm'])
      expect(AGENT_INSTRUCTIONS_SEED).toContain(`muxpad ${verb}`);
  });

  it('names EVERY harness scheduling entry point it means to displace', () => {
    // Observed, not hypothetical: an agent asked "what would you use to
    // schedule activities for later?" answered `/schedule` and `/loop` and
    // only mentioned muxpad cron when pushed. The old wording forbade the
    // TOOLS (`CronCreate`/`CronList`) and said "any backend-internal
    // scheduler" — neither of which matches a SKILL or a SLASH COMMAND the
    // agent sees in its own menu, so nothing fired.
    //
    // When a harness ships a new scheduling surface, add it here AND to the
    // seed. This list failing is the reminder.
    for (const entryPoint of [
      '/schedule',
      '/loop',
      'CronCreate',
      'CronList',
      'CronDelete',
      'ScheduleWakeup',
    ])
      expect(AGENT_INSTRUCTIONS_SEED).toContain(entryPoint);

    // And the rule has to read as absolute, covering one-off as well as
    // recurring, and cover RECOMMENDING them, not just calling them.
    expect(AGENT_INSTRUCTIONS_SEED).toMatch(/ONLY scheduler/);
    expect(AGENT_INSTRUCTIONS_SEED).toMatch(/one-off|ONE-OFF/);
    expect(AGENT_INSTRUCTIONS_SEED).toMatch(/not RECOMMEND|Do not RECOMMEND/);
    // The justification is what makes it persuasive rather than arbitrary.
    for (const reason of [/catches\s+up/, /expire/, /durable/, /every backend/])
      expect(AGENT_INSTRUCTIONS_SEED).toMatch(reason);
  });

  it('rewrites the file on every boot, so a seed change can never go stale', () => {
    seedAgentInstructions(dataDir);
    writeFileSync(agentInstructionsPath(dataDir), 'a stale older default\n');
    seedAgentInstructions(dataDir); // boot again
    expect(readFileSync(agentInstructionsPath(dataDir), 'utf8')).toBe(
      generatedBody(AGENT_INSTRUCTIONS_SEED),
    );
  });

  it('the shipped-defaults list the migration reads stays sane', () => {
    // The DATA the one-shot migration leans on: a file matching one of these
    // hashes is untouched plumbing. A WRONG entry here would silently discard
    // real user edits, so it is worth pinning.
    const known = INSTRUCTIONS_MIGRATION.knownDefaults;
    expect(SHIPPED_INSTRUCTIONS_DEFAULTS.length).toBeGreaterThan(0);
    for (const hash of known) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(known).size).toBe(known.length);
    // The seed shipping TODAY has to be in there — an install already on the
    // current default has nothing to rescue.
    expect(known).toContain(sha256(AGENT_INSTRUCTIONS_SEED));
    // …and the frozen historical entries are not it.
    expect(SHIPPED_INSTRUCTIONS_DEFAULTS).not.toContain(sha256(AGENT_INSTRUCTIONS_SEED));
  });

  it('teaches EXACTLY the five statuses in PaneStatusSchema, and no retired ones', () => {
    // The seed once enumerated `done` and separately advertised `busy|idle`
    // columns; the done→ready rename slipped past this file because nothing
    // asserted the vocabulary. Bound to the schema so it cannot drift again.
    const states = PaneStatusSchema.options;
    for (const s of states) expect(AGENT_INSTRUCTIONS_SEED).toContain(`\`${s}\``);

    // The enumeration itself must list those five and nothing else.
    const from = AGENT_INSTRUCTIONS_SEED.indexOf('It is one of');
    const to = AGENT_INSTRUCTIONS_SEED.indexOf('`agents` alongside');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const enumerated = [...AGENT_INSTRUCTIONS_SEED.slice(from, to).matchAll(/`([a-z]+)`/g)].map(
      (m) => m[1],
    );
    expect(new Set(enumerated)).toEqual(new Set(states));

    // …and no surface still advertises the retired two-state column.
    expect(AGENT_INSTRUCTIONS_SEED).not.toContain('busy|idle');
    // `busy` survives only as the explicitly-labelled deprecated alias.
    for (const m of AGENT_INSTRUCTIONS_SEED.matchAll(/`busy`/g)) {
      const line = AGENT_INSTRUCTIONS_SEED.slice(0, m.index).split('\n').length;
      const text = AGENT_INSTRUCTIONS_SEED.split('\n')[line - 1] ?? '';
      expect(text).toMatch(/not `busy`|deprecated alias/);
    }
  });

  it('injects the GENERATED file and then the user’s notes, in that order', () => {
    writeFileSync(agentInstructionsPath(dataDir), 'use muxpad publish\n');
    writeFileSync(agentNotesPath(dataDir), 'projects live in ~/dev\n');
    expect(readAgentInstructions(dataDir)).toBe('use muxpad publish\n\nprojects live in ~/dev');
  });

  it('either half missing or empty contributes nothing, and is never an error', () => {
    expect(readAgentInstructions(dataDir)).toBeNull(); // neither file → nothing
    writeFileSync(agentInstructionsPath(dataDir), '   \n');
    expect(readAgentInstructions(dataDir)).toBeNull();

    writeFileSync(agentNotesPath(dataDir), 'projects live in ~/dev\n');
    expect(readAgentInstructions(dataDir)).toBe('projects live in ~/dev'); // notes only
    writeFileSync(agentInstructionsPath(dataDir), 'use muxpad publish\n');
    writeFileSync(agentNotesPath(dataDir), '\t\n');
    expect(readAgentInstructions(dataDir)).toBe('use muxpad publish'); // generated only
  });

  it('wraps fallback injections in a clearly delimited block', () => {
    expect(wrapAgentInstructions('use muxpad publish\n')).toBe(
      '<muxpad-instructions>\nuse muxpad publish\n</muxpad-instructions>',
    );
  });
});
