// THE OTHER THING THAT ARRIVES AS ORDINARY PROSE — running out of quota.
//
// `auth-heal.ts` exists because a dead credential is reported by the CLI as an
// assistant message and then the turn closes as a SUCCESS: no error subtype, no
// throw, one line of text as the only signal on the wire. A usage limit has the
// same shape and the same consequence, and muxpad classified neither until now.
//
// WHY THIS IS WORSE THAN THE AUTH CASE, which is the reason it is worth its own
// module. A dead credential breaks every pane at once, loudly, in front of a
// person who is sitting there — it gets noticed within a turn. A usage limit
// breaks the UNATTENDED work specifically, and the whole point of that work is
// that nobody is watching it:
//
//   · a cron fires, `submitSend` answers `sent`, and `CronScheduler` records
//     `ok: true` and RESETS THE FAILURE STREAK — because its verdict is about
//     whether the message reached the pane, not about whether the agent did
//     anything with it;
//   · the agent then says "you have run out of usage" and ends the turn
//     cleanly, so nothing downstream disagrees;
//   · `cron list` shows green, `last_status` says `sent`, and the weekday job
//     has quietly done nothing for however long the window lasts.
//
// So the fix is not a retry and it is CERTAINLY not auth-heal's re-exec ladder:
// re-execing a session does not refill a quota, and four re-execs against a
// limit that resets in six hours is just a louder way to do nothing. What a
// usage limit needs is the opposite of self-healing — to be believed the first
// time, reported as the failure it is, and put in front of a human.
//
// ── WHY NOT JUST READ THE ERROR ──────────────────────────────────────────────
// Because there is not one. This is the lesson auth-heal paid for, transcribed
// from its own incident log: the turn `result` says success. Anything keyed on
// an exception, an `errors` array or a result subtype sees a healthy turn. The
// text is the signal, which is why this file is a careful classifier and not a
// substring match.

/**
 * The openings. A usage-limit message names the limit at the START — these are
 * refusals, and a refusal leads with what it is refusing.
 *
 * Deliberately NOT anchored on a provider's exact wording. The auth classifier
 * could be, because its three variants were transcribed verbatim from a live
 * incident; this one is written ahead of the incident rather than after it, so
 * it keys on the shape the family shares. The asymmetry that justifies the
 * looser net is the same one auth-heal argued: a missed variant is the silent
 * failure this module exists to end, while a false positive costs one turn
 * marked failed and one push — annoying, visible, and self-correcting.
 */
/**
 * An optional vendor word in front of the refusal.
 *
 * This is the one that would have made the whole module dead on arrival. The
 * likeliest real wording opens with the PRODUCT — "Claude usage limit reached.
 * Your limit will reset at 3pm" — and an earlier draft of the openings, written
 * to start at the noun, missed exactly that and therefore missed the only
 * message that matters. Caught by probing the classifier with the real string
 * rather than by reading it.
 */
const VENDOR = '(claude |anthropic |openai |codex |cursor |api )?';

const USAGE_LIMIT_OPENINGS: readonly RegExp[] = [
  new RegExp(`^${VENDOR}(you('ve| have)? )?(reached|hit|exceeded)\\b`),
  new RegExp(`^${VENDOR}(your )?(usage|rate|quota|spend|credit)( limits?)?\\b`),
  // The noun phrase is consumed WHOLE — `usage limit`, not `usage`. If the
  // opening stopped at the noun, the word `limit` sitting right behind it would
  // satisfy the tail on its own and prove nothing, which is how
  // `Usage limit — that is the bug.` classified as a refusal on the first pass
  // of this file. The tests pin both halves of that.
  /^(out of|no more) (quota|credits?|usage|tokens)\b/,
  /^insufficient (quota|credits?|balance)\b/,
  /^api (quota|credit|usage)( limits?)?\b/,
];

/**
 * …and what the rest has to look like. Same two-part test as the auth
 * classifier and for the same reason: in THIS repository the agents write about
 * quotas, limits and rate windows for a living, and `Usage is the thing to
 * check.` must not cost somebody a push saying their subscription is spent.
 *
 * An opening only counts if the message goes on to name the MECHANISM (a limit,
 * a plan, a quota) or the RESOLUTION (a reset time, an upgrade, an API key).
 * That is what a refusal does and what a passing thought does not.
 */
const USAGE_LIMIT_TAIL =
  /\blimit\b|\bquota\b|\bcredits?\b|\bplan\b|\bsubscription\b|\bbilling\b|\bupgrade\b|\bresets?\b|\bresume[sd]?\b|\btry again\b|\bapi key\b|\buntil\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b/;

/**
 * Longer than the auth ceiling (200) on purpose: a usage message routinely
 * carries a reset time and a suggestion ("…resets at 4:00 PM. You can continue
 * with the API or wait until then."), which is still one short refusal and not
 * prose about one. Still bounded, and still single-line — an agent EXPLAINING a
 * limit writes paragraphs, and paragraphs are rejected outright below.
 */
const MAX_USAGE_MESSAGE_LEN = 320;

/**
 * Is this assistant message the harness saying there is no quota left?
 *
 * Matched against the WHOLE message, not searched within it. Four conditions,
 * all load-bearing against the false positive: one line, bounded length,
 * STARTING with a refusal opening, and CONTINUING like a refusal rather than
 * like a note about one.
 *
 * The caller supplies the fifth, which text alone cannot: the turn made no tool
 * calls. A turn that was refused for quota never reached a model, while any
 * real turn — certainly any Chat turn, whose closing `reply` is itself a tool
 * call — has called something. See the turn-result branch in backends/claude.ts,
 * which applies the identical guard to the auth classifier.
 */
export function isUsageLimitText(text: string): boolean {
  const s = text.trim();
  if (!s || s.length > MAX_USAGE_MESSAGE_LEN || s.includes('\n')) return false;
  const lower = s.toLowerCase();
  for (const re of USAGE_LIMIT_OPENINGS) {
    const m = lower.match(re);
    // The tail is searched AFTER the opening, so `usage limit` cannot satisfy
    // its own tail requirement and prove nothing — auth-heal's bug, avoided.
    if (m && USAGE_LIMIT_TAIL.test(lower.slice(m[0].length))) return true;
  }
  return false;
}

/**
 * What a human is told, on their phone, when a turn dies of quota.
 *
 * Says WHERE (this pane's folder) and WHAT IT SAID, because the reset time is
 * usually in the message and is the single most useful fact in it. No advice:
 * there is nothing muxpad can do and nothing the user needs to do except know.
 *
 * Deliberately NOT routed through the ordinary turn-done notify path, which is
 * suppressed inside the interactive window — a person chatting when their quota
 * runs out is exactly who most needs to be told, and immediately.
 */
export function usageLimitNotice(where: string, message: string): string {
  const said = message.length > 140 ? `${message.slice(0, 137)}…` : message;
  return `${where}: out of usage — ${said}`;
}
