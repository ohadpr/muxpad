/**
 * Dictation cleanup: rewrite a phone-dictated message so the domain words are
 * the ones the speaker actually said.
 *
 * iOS's keyboard mic has no way to learn vocabulary, so a developer dictating
 * into muxpad gets "Max pad" for muxpad, "crown schedule" for cron schedule,
 * "Ohio" for ohados, "Heart effect life cycle" for artifact lifecycle. Every
 * one of those is a homophone-level miss that a model holding the right
 * glossary fixes trivially and that no amount of client-side regex can.
 *
 * The contract is deliberately narrow, and the prompt says so three ways:
 * TRANSCRIPTION ERRORS ONLY. This runs on text the user is about to send to an
 * agent that executes tool calls — a "helpful" rewrite that changes what was
 * asked is not a cosmetic bug, it's the model editing an instruction. When in
 * doubt the correct output is the input, unchanged.
 *
 * Nothing here decides to send anything. The cleaned text goes back to the
 * composer for the user to look at; review before send is the safety property
 * (see web/src/lib/dictation-cleanup.ts).
 */

/**
 * Longest dictated message we'll clean. A phone dictation is a paragraph, not a
 * document — past this it's a paste, and pasted text has no transcription
 * errors to fix. Bounding here is what keeps the per-call cost fixed and small.
 */
export const MAX_TRANSCRIPT_CHARS = 2000;

/**
 * Wall-clock ceiling for the model call.
 *
 * Generous on purpose: the Agent SDK spawns its bundled CLI per call, and a
 * cold spawn measured ~18s on the author's machine against ~4s warm. A ceiling
 * tuned to the warm case would make the affordance fail exactly when it is
 * first reached for. 30s matches chat/summarize.ts's ceiling for the same
 * reason.
 */
export const CLEANUP_TIMEOUT_MS = 30_000;

/**
 * A cleanup failure the route can turn into an honest status.
 *
 * Every failure mode here is VISIBLE by design: this endpoint never falls back
 * to echoing the input. A silent no-op would teach the user that cleanup ran
 * and found nothing wrong, which is exactly the wrong belief to hold about
 * text they're about to send to an agent.
 */
export class CleanupError extends Error {
  readonly code: 'bad_request' | 'too_large' | 'unavailable';
  constructor(code: CleanupError['code'], message: string) {
    super(message);
    this.name = 'CleanupError';
    this.code = code;
  }
}

/** The seam the model sits behind. One function, so tests inject a fake and
 *  NEVER reach the network — and so the auth path is swappable in one place. */
export type CleanupModel = (prompt: string, signal: AbortSignal) => Promise<string>;

/**
 * Build the cleanup prompt.
 *
 * Structure is load-bearing: rules BEFORE the glossary and the glossary before
 * the text, so the narrowest instruction ("only fix mishearings") is read
 * before the model sees a list of words it could be tempted to insert.
 */
export function buildCleanupPrompt(text: string, glossary: readonly string[]): string {
  const terms = glossary.length > 0 ? glossary.join(', ') : '(none)';
  return [
    'You are a speech-to-text correction pass. The text below was dictated into a phone',
    'keyboard by a software developer. Phone dictation cannot learn domain vocabulary, so',
    'technical terms and proper nouns come out as ordinary-sounding words.',
    '',
    'Your ONLY job is to repair mis-transcribed words.',
    '',
    'Rules:',
    '- Fix misheard words and mangled proper nouns. Nothing else.',
    '- Never change meaning, tone, structure, phrasing, or word order.',
    '- Never add, remove, reorder, summarize, answer, translate, or comment on the content.',
    '- Never fix grammar, spelling, punctuation or capitalization that dictation got right.',
    '- Preserve line breaks and spacing exactly.',
    '- If you are not confident a word is a transcription error, LEAVE IT EXACTLY AS IT IS.',
    '- Returning the text completely unchanged is a correct and expected answer.',
    '',
    'Names and terms from this speaker’s world. Dictation frequently mangles them, so when a',
    'word or phrase plausibly SOUNDS like one of these, it probably is one:',
    terms,
    '',
    // Real misses from this user, kept as examples because the failure mode is
    // specifically MULTI-WORD: "Max pad" and "heart effect" are each perfectly
    // ordinary English, and only look wrong once you know the vocabulary. A
    // model shown single-word examples reliably misses those.
    'The mishearings are often several ordinary words standing in for one term —',
    'for example "Max pad" for a product name, "crown schedule" for "cron schedule",',
    '"heart effect" for "artifact". Read suspicious phrases aloud against the list above.',
    '',
    'Reply with the corrected text and nothing else: no preamble, no explanation, no quotes,',
    'no code fences, no XML tags.',
    '',
    'Dictated text:',
    text,
  ].join('\n');
}

/** Strip the wrappers a chatty model adds even when told not to. */
function unwrap(reply: string): string {
  let out = reply.trim();
  // ```…``` (optionally language-tagged) around the whole reply.
  const fence = out.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1] !== undefined) out = fence[1].trim();
  // <text>…</text> — we don't ask for tags, but we name them in the prompt.
  const tagged = out.match(
    /^<(?:text|corrected(?:_text)?)>\n?([\s\S]*?)\n?<\/(?:text|corrected(?:_text)?)>$/i,
  );
  if (tagged?.[1] !== undefined) out = tagged[1].trim();
  return out;
}

/**
 * Turn a raw model reply into the text to hand back — or refuse.
 *
 * The length guard is the cheap proxy for "the model did something other than
 * what it was asked". A correction pass returns something within spitting
 * distance of its input; a reply that is half the length has dropped content
 * and one that is triple has answered the message instead of fixing it. Both
 * are refusals, not results: better a visible "cleanup failed" than silently
 * putting a different message in the user's composer.
 */
export function parseCleanupReply(raw: string, original: string): string {
  const out = unwrap(raw ?? '');
  if (!out) throw new CleanupError('unavailable', 'cleanup returned nothing');
  // `unwrap` trims, and the model is told to preserve spacing exactly. If the
  // only difference is the surrounding whitespace we ate, hand back the user's
  // string untouched — otherwise a verbatim echo is reported as a change and
  // the composer silently loses a trailing newline.
  if (out === original.trim()) return original;
  // The bounds are a proxy for "the model did something other than what it was
  // asked": half the length means content was dropped, triple means it answered
  // the message. Both are refusals, not results.
  //
  // The floor is proportional with a few characters of slack, NOT an absolute
  // minimum: "Max pad" → "muxpad" and "Ohio" → "ohados" are the motivating
  // corrections, and any fixed floor above ~4 rejects them.
  const lo = Math.max(1, Math.floor(original.length * 0.5) - 4);
  const hi = Math.ceil(original.length * 2) + 40;
  if (out.length < lo || out.length > hi) {
    throw new CleanupError('unavailable', 'cleanup returned an implausible rewrite');
  }
  return out;
}

/** Reject before spending anything. Empty text has nothing to fix; oversized
 *  text isn't dictation. */
export function assertCleanable(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) {
    throw new CleanupError('bad_request', 'text is required');
  }
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new CleanupError('too_large', `text exceeds ${MAX_TRANSCRIPT_CHARS} characters`);
  }
  return text;
}

/**
 * Clean one dictated message. Throws `CleanupError` on every failure path —
 * there is no success-shaped failure.
 */
export async function cleanTranscript(opts: {
  text: unknown;
  glossary: readonly string[];
  model: CleanupModel;
  timeoutMs?: number;
}): Promise<string> {
  const text = assertCleanable(opts.text);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? CLEANUP_TIMEOUT_MS);
  try {
    const reply = await opts.model(buildCleanupPrompt(text, opts.glossary), abort.signal);
    return parseCleanupReply(reply, text);
  } catch (err) {
    if (err instanceof CleanupError) throw err;
    // The cause verbatim — the UI already frames it ("Couldn't clean that up —
    // …"), so prefixing it here just makes the phone read the same word twice.
    throw new CleanupError('unavailable', errText(err));
  } finally {
    clearTimeout(timer);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The production model: a one-shot Haiku completion through the Claude Agent
 * SDK — the same bare-completion shape chat/summarize.ts and the runner's
 * self-titling use.
 *
 * Why the Agent SDK and not `@anthropic-ai/sdk`: this machine has no
 * ANTHROPIC_API_KEY, no `ant` profile and no ANTHROPIC_AUTH_TOKEN. What it has
 * is the Claude Code login the agent panes already run on, and the Agent SDK
 * (bundled CLI) picks that up with no configuration. Choosing the raw Messages
 * API would mean asking the user to mint and store a brand-new API key to fix
 * dictation — a worse trade than reusing the credential that is already there
 * and already working.
 *
 * `settingSources: []` + `allowedTools: []` keep it a completion: no CLAUDE.md,
 * no skills, no MCP, no filesystem. Dynamic import so a server that never
 * cleans a transcript doesn't pay the SDK's load at boot.
 */
export const agentSdkModel: CleanupModel = async (prompt, signal) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  else signal.addEventListener('abort', () => abort.abort(), { once: true });
  let out = '';
  let failure = '';
  for await (const m of query({
    prompt,
    options: {
      model: 'haiku',
      maxTurns: 1,
      settingSources: [],
      allowedTools: [],
      abortController: abort,
    },
  })) {
    if (m.type !== 'result') continue;
    if (m.subtype === 'success') out = m.result;
    // An error result is a completed stream with no text — without this the
    // caller would see "returned nothing" and never learn the real reason.
    else failure = m.subtype;
  }
  if (!out && failure) throw new Error(failure);
  return out;
};
