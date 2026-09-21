// THE ARGV SCAN, AND EVERY WAY A FLAG CAN FALL THROUGH IT.
//
// `muxpad agent --help` minting a fresh session in a pane that already had one
// (see help.test.ts and agent-resume-repair.ts) was not a bug about `--help`.
// It was a bug about a parser that looked for the four flags it knew with
// `indexOf` and had NO OPINION about anything else: whatever it failed to
// understand simply became "no --resume, no --backend" — a brand-new Claude
// session, hello'd to the server, which dutifully re-pointed `current_sid` and
// `startup_cmd` at it and stranded three days of conversation.
//
// `--help` was merely the first token anyone happened to type. The rest of the
// muxpad CLI is written in `--flag=value` (`muxpad agent new --model=x
// --mode=chat`, `muxpad cron new --tz=…`, `muxpad agent respawn --all
// --backend=claude`), so `muxpad agent --resume=<sid>` is the form the tool
// itself teaches — and under the old scan it was silently the same disaster.
//
// So this file is the table of fall-throughs, and the contract is narrow: the
// runner starts a session only on argv it fully understood. Anything else is a
// LOUD refusal, never a quiet fresh session.
import { describe, expect, it } from 'vitest';
import { parseRunnerArgs } from './args.js';

/** The parsed shape, or a failure message — assertions read better this way. */
function parse(...argv: string[]) {
  return parseRunnerArgs(argv);
}

function ok(...argv: string[]) {
  const r = parse(...argv);
  if (r.kind !== 'run') throw new Error(`expected a run, got ${r.kind}: ${JSON.stringify(r)}`);
  return r.args;
}

function err(...argv: string[]): string {
  const r = parse(...argv);
  if (r.kind !== 'error') throw new Error(`expected an error, got ${r.kind}`);
  return r.message;
}

describe('parseRunnerArgs — the shapes the server writes', () => {
  it('a bare `muxpad agent` is a fresh claude session in the baseline mode', () => {
    const a = ok();
    expect(a).toMatchObject({
      requestedSid: null,
      requestedModel: null,
      requestedBackend: 'claude',
      requestedMode: 'agent',
      pick: false,
    });
  });

  it('reads the self-heal command verbatim', () => {
    // The exact string ws.ts composes: backend, mode, quoted model, resume.
    const a = ok('--backend', 'codex', '--mode', 'chat', '--model', 'gpt-5', '--resume', 'abc-123');
    expect(a.requestedBackend).toBe('codex');
    expect(a.requestedMode).toBe('chat');
    expect(a.requestedModel).toBe('gpt-5');
    expect(a.requestedSid).toBe('abc-123');
  });

  it('reads the harness-picker command', () => {
    expect(ok('--pick').pick).toBe(true);
  });

  it('keeps the pre-rename --mode spellings working (version skew, both ways)', () => {
    expect(ok('--mode', 'do').requestedMode).toBe('chat');
    expect(ok('--mode', 'deep').requestedMode).toBe('agent');
  });

  it('tolerates a --mode spelling from the future rather than refusing to boot', () => {
    // A mode word this build has never heard of must NOT brick the pane: the
    // pane row is the source of truth and the server converges the runner with
    // a `mode` frame right after hello. Warn, keep the baseline, boot.
    const a = ok('--mode', 'telepathy', '--resume', 'abc');
    expect(a.requestedMode).toBe('agent');
    expect(a.requestedSid).toBe('abc');
    expect(a.warnings.join(' ')).toMatch(/telepathy/);
  });
});

describe('parseRunnerArgs — the fall-throughs', () => {
  it('accepts --flag=value, the form the rest of the CLI teaches', () => {
    // THE BUG. `--resume=<sid>` used to mean "no --resume" — a fresh session in
    // a pane that already had one, which is how a conversation gets stranded.
    const a = ok('--resume=abc-123', '--backend=codex', '--mode=chat', '--model=gpt-5');
    expect(a.requestedSid).toBe('abc-123');
    expect(a.requestedBackend).toBe('codex');
    expect(a.requestedMode).toBe('chat');
    expect(a.requestedModel).toBe('gpt-5');
  });

  it('refuses an unknown flag instead of starting a session without it', () => {
    // A typo'd resume is the worst case of all: the flag that would have SAVED
    // the conversation is the one that got misspelt.
    expect(err('--resme', 'abc-123')).toMatch(/--resme/);
    expect(err('--verbose')).toMatch(/--verbose/);
    expect(err('-x')).toMatch(/-x/);
  });

  it('refuses a stray positional', () => {
    // `muxpad agent abc-123` — someone remembering the sid but not the flag.
    expect(err('abc-123')).toMatch(/abc-123/);
    expect(err('--resume', 'abc', 'chat')).toMatch(/chat/);
  });

  it('refuses `--` rather than silently ignoring everything after it', () => {
    expect(err('--', '--resume', 'abc')).toMatch(/--/);
  });

  it('refuses a flag whose value is missing', () => {
    // `--resume` with nothing after it used to be exactly "no --resume".
    expect(err('--resume')).toMatch(/--resume/);
    expect(err('--backend')).toMatch(/--backend/);
    expect(err('--model')).toMatch(/--model/);
    expect(err('--mode')).toMatch(/--mode/);
    expect(err('--resume=')).toMatch(/--resume/);
  });

  it('refuses a value that is really the next flag', () => {
    // `muxpad agent --resume --backend codex` used to resume a session called
    // "--backend" — a sid the server's hello guard then rejects outright, so
    // the pane attaches to nothing at all.
    const a = parse('--resume', '--backend', 'codex');
    expect(a.kind).toBe('error');
    expect(err('--resume', '--backend', 'codex')).toMatch(/--resume/);
    expect(err('--model', '--resume', 'abc')).toMatch(/--model/);
  });

  it('refuses an unknown --backend instead of quietly running claude', () => {
    // Silently falling back to claude is not a small wrong: the runner hellos
    // `backend: claude`, the self-heal rewrite DROPS the pane's `--backend
    // codex`, and the pane converts harness permanently while its codex thread
    // is left behind.
    expect(err('--backend', 'codx', '--resume', 'abc')).toMatch(/codx/);
    expect(err('--backend=gpt')).toMatch(/gpt/);
  });

  it('refuses a repeated flag instead of picking one and hoping', () => {
    // `--resume A --resume B` is the shape a buggy rewrite leaves behind, and
    // first-wins quietly resumes whichever one is stale.
    expect(err('--resume', 'a', '--resume', 'b')).toMatch(/--resume/);
    expect(err('--mode', 'chat', '--mode=agent')).toMatch(/--mode/);
    expect(err('--pick', '--pick')).toMatch(/--pick/);
  });

  it('refuses --pick with a value', () => {
    expect(err('--pick=1')).toMatch(/--pick/);
  });

  it('refuses --pick alongside a session flag', () => {
    // `--pick` starts NO session, so a `--resume` next to it is a resume that
    // will never happen — silently. (rewriteResumeCmd appends `--resume <sid>`
    // to whatever a pane's command is, `muxpad agent --pick` included.)
    expect(err('--pick', '--resume', 'abc')).toMatch(/--pick/);
  });

  it('still answers --help before anything else', () => {
    expect(parse('--help').kind).toBe('help');
    expect(parse('-h').kind).toBe('help');
    // Even next to junk: asking for usage is never a destructive act.
    expect(parse('--resume', 'abc', '--help').kind).toBe('help');
    expect(parse('--nonsense', '--help').kind).toBe('help');
  });
});
