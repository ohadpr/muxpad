/**
 * Run the transcript rebase over a real Claude transcript, OFF the server.
 *
 *   pnpm --dir server exec tsx scripts/transcript-rebase-dry.mts <file.jsonl> [--write] [--budget=N] [--briefing=TEXT]
 *
 * Prints the plan (what was dropped, the token estimate, where the cut fell)
 * and the integrity check. With --write it writes the new transcript NEXT TO
 * the source under a fresh session id and prints that id, so it can be tried
 * with `claude --resume <sid>` from the session's own cwd. The source file is
 * never modified. Without --briefing a cut history gets a placeholder briefing
 * rather than a model call — this is a structure check, not a quality one.
 */
import { randomUUID } from 'node:crypto';
import { fstatSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  checkTranscript,
  fileSource,
  planTranscriptRebase,
  renderTranscriptRebase,
} from '../src/chat/transcript-rebase.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error(
    'usage: transcript-rebase-dry.mts <file.jsonl> [--write] [--budget=N] [--briefing=TEXT]',
  );
  process.exit(2);
}
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const budget = flag('budget');

const t0 = Date.now();
const fd = openSync(file, 'r');
const size = fstatSync(fd).size;
const planned = planTranscriptRebase(
  fileSource(fd, size),
  budget ? { budgetTokens: Number(budget) } : {},
);
if (!planned.ok) {
  console.log(JSON.stringify(planned, null, 2));
  process.exit(1);
}
const { plan } = planned;
const sid = randomUUID();
const briefing = plan.dropped
  ? (flag('briefing') ?? '(placeholder briefing — the dry run does not call a model)')
  : null;
const jsonl = renderTranscriptRebase(plan, sid, briefing);
const problems = checkTranscript(jsonl, sid);
console.log(
  JSON.stringify(
    {
      sourceBytes: size,
      outputBytes: jsonl.length,
      kept: plan.kept.length,
      dropped: plan.dropped?.count ?? 0,
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      tokens: plan.tokens,
      stats: plan.stats,
      problems,
      ms: Date.now() - t0,
    },
    null,
    2,
  ),
);
if (problems.length) process.exit(1);
const outFlag = flag('out');
if (outFlag) writeFileSync(outFlag, jsonl, { mode: 0o600 });
if (args.includes('--write')) {
  const out = join(dirname(file), `${sid}.jsonl`);
  writeFileSync(out, jsonl, { flag: 'wx', mode: 0o600 });
  console.log(`wrote ${out}\nsid ${sid}`);
}
