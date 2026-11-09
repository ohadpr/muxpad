import { type ChatAction, actionIsOpen, actionIsRead } from '@muxpad/shared';

/**
 * CONSECUTIVE READS ARE ONE ROW.
 *
 * One question to the mail vault produced fifteen full-width cards, each
 * saying it had searched for something, and the answer to the question was
 * below all of them. Reported as "this can easily become overwhelming" — and
 * the right comparison was already on screen: the tool calls above them were
 * folded into `5 actions · Bash ×5`.
 *
 * A write never folds. The card exists because an outbound effect needs a
 * durable record — the transcript holds the agent SAYING it posted, written
 * before the approval was answered — and burying that in a fold would delete
 * the only reason the card was built.
 *
 * Two more rules, both learned from what a fold hides:
 *   · a run of ONE is not a run. Folding a single read behind a disclosure
 *     costs a click and saves nothing.
 *   · anything still WAITING on a person stays out. A pending approval is the
 *     one card in this family you might need to act on, and a fold is where
 *     a reader stops looking.
 */
export interface ActionRun {
  /** The actions in this run, in order. One of them when it is not a run. */
  actions: ChatAction[];
  /** Folded runs get a stable key and a header; a lone action renders bare. */
  folded: boolean;
}

export function actionRuns(actions: readonly ChatAction[]): ActionRun[] {
  const out: ActionRun[] = [];
  for (const a of actions) {
    const last = out[out.length - 1];
    const foldable = actionIsRead(a) && !actionIsOpen(a);
    if (foldable && last && last.actions.every((x) => actionIsRead(x) && !actionIsOpen(x))) {
      last.actions.push(a);
      last.folded = true;
      continue;
    }
    out.push({ actions: [a], folded: false });
  }
  return out;
}

/** `12 reads · your mail`, or `3 reads · Slack` — what the folded row says. */
export function runSummary(run: ActionRun): string {
  const n = run.actions.length;
  const systems = [...new Set(run.actions.map((a) => systemName(a.kind)))];
  // Two systems in one run is possible and the header must not pick one.
  const where = systems.length === 1 ? systems[0] : systems.join(' · ');
  return `${n} ${n === 1 ? 'read' : 'reads'} · ${where}`;
}

function systemName(kind: string): string {
  // `your archive` was muxpad's word for the component and said nothing about
  // what was touched. It is mail.
  if (kind.startsWith('msgvault.')) return 'your mail';
  if (kind.startsWith('slack.')) return 'Slack';
  return kind.split('.')[0] ?? kind;
}
