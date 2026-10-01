// Turning a `reply` tool call into SPEECH, the moment it starts existing.
//
// Why this file exists — the latency budget of a spoken turn.
//
// A reply reaches an open chat exactly one way today: it lands in the
// transcript and TranscriptReader's 250 ms poll picks it up. For text that is
// fine; nobody perceives a quarter second of a bubble. For VOICE it is the
// whole problem, and not because of the 250 ms: the reply is only IN the
// transcript once the model has finished generating the entire tool_use block.
// A four-sentence reply is several seconds of generation, and a voice turn that
// waits for the last token before its first phoneme sounds broken.
//
// The tokens are already on the wire. `includePartialMessages` makes the SDK
// forward the raw Anthropic stream, and the backend's loop already reads it —
// but it filters to `text_delta` and throws the rest away. A reply's text does
// NOT arrive as `text_delta`; it is a TOOL ARGUMENT, so it arrives as
// `input_json_delta` chunks of the JSON `{"text": "…"}`. Discarded, every time.
//
// This module is the decoder that makes those chunks speakable: feed it the
// `partial_json` fragments of a reply block and it hands back the plain text as
// it becomes known, so a consumer can start speaking mid-reply.
//
// SHAPES ARE LIVE-PROBED, not guessed (SDK 0.3.220, 2026-09-11 — the same
// discipline sdkScript.ts follows, and for the same reason: hand-written frames
// have hidden three bugs in this neighbourhood already). The observed sequence
// for one `reply` call, verbatim:
//
//   content_block_start  index:1  content_block:{type:'tool_use',
//                                 id:'toolu_01FF…', name:'mcp__muxpad__reply',
//                                 input:{}, caller:{type:'direct'}}
//   content_block_delta  index:1  delta:{type:'input_json_delta',
//                                 partial_json:''}
//   content_block_delta  index:1  delta:{…, partial_json:'{"text": "Landed in'}
//   content_block_delta  index:1  delta:{…, partial_json:' ~/Documents/'}
//   …
//   content_block_delta  index:1  delta:{…, partial_json:'pdf — \\"quoted'}
//   content_block_delta  index:1  delta:{…, partial_json:'\\nhere."}'}
//   content_block_stop   index:1
//
// Two details in there are exactly why this is a state machine and not a
// regex. The key is emitted as `{"text": "` — with a SPACE after the colon, so
// anything matching a literal `"text":"` finds nothing. And the value's JSON
// escapes (`\"`, `\n`) are split across chunk boundaries at the model's whim,
// so a decoder that treats each chunk independently will either emit a stray
// backslash or drop a character.

import { REPLY_TOOL_NAME } from '@muxpad/shared';

/**
 * The tool_use id of the reply whose handler is running.
 *
 * The in-process MCP handler's second argument is MCP's RequestHandlerExtra,
 * typed `unknown` by the SDK. Live-probed, it carries the Claude tool_use id
 * under `_meta['claudecode/toolUseId']` — which is the reply's TRANSCRIPT
 * identity, the same id `normalizeTranscriptLine` derives a chat event's id
 * from. That correspondence is the point: it lets a consumer tie a spoken
 * reply to the bubble that will render for it (to stop speaking something the
 * user has already scrolled past, or to dedupe if it reads both paths).
 *
 * Returns null rather than throwing on any shape it does not recognise: an SDK
 * that renames the meta key must cost the caller its id, never its reply.
 */
export function replyToolUseId(extra: unknown): string | null {
  const meta = (extra as { _meta?: Record<string, unknown> } | null | undefined)?._meta;
  const id = meta?.['claudecode/toolUseId'];
  return typeof id === 'string' && id ? id : null;
}

/** Is this streamed content block a `reply` tool call? */
export function isReplyBlock(contentBlock: unknown): boolean {
  const b = contentBlock as { type?: string; name?: string } | null | undefined;
  return b?.type === 'tool_use' && b?.name === REPLY_TOOL_NAME;
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Incremental decoder for ONE reply block's `input_json_delta` stream.
 *
 * Feed it `partial_json` chunks in order; each `push` returns the plain text
 * that became known from THAT chunk — never re-returning anything, so a
 * consumer can append blindly.
 *
 * The hard part is that a chunk boundary can fall anywhere, including the
 * middle of a `\uXXXX`. Anything not yet decodable is held back until the next
 * chunk completes it, which is why a caller must never treat "push returned ''"
 * as "the model paused".
 *
 * Deliberately decodes only the `text` field and stops at its closing quote:
 * the reply tool has exactly one argument, and a decoder that tried to be a
 * general JSON parser would be a much larger thing to trust with speech.
 */
export class ReplyArgStreamer {
  /** Text not yet scanned for the `"text":` key (pre-value phase only). */
  private prelude = '';
  /** An escape sequence straddling a chunk boundary ('\\' or '\\u0e'). */
  private partialEscape = '';
  private state: 'before' | 'in' | 'done' = 'before';
  /** Everything decoded so far, for the caller that wants the whole value. */
  private decoded = '';

  /** The plain text decoded so far across every chunk. */
  get text(): string {
    return this.decoded;
  }

  /** True once the `text` value's closing quote has been seen. */
  get complete(): boolean {
    return this.state === 'done';
  }

  /**
   * Consume one `partial_json` chunk; return only the NEWLY decoded text.
   */
  push(chunk: string): string {
    if (this.state === 'done' || !chunk) return '';
    let rest = chunk;

    if (this.state === 'before') {
      this.prelude += rest;
      // `{"text": "` — the whitespace is real (live-probed), and the key may
      // not be first if the schema ever grows a second argument.
      const m = this.prelude.match(/"text"\s*:\s*"/);
      if (!m || m.index === undefined) {
        // Keep the tail only: a partial key can straddle chunks, but the
        // buffer must not grow without bound on a long `{"other": "…"` prefix.
        if (this.prelude.length > 4096) this.prelude = this.prelude.slice(-64);
        return '';
      }
      rest = this.prelude.slice(m.index + m[0].length);
      this.prelude = '';
      this.state = 'in';
    }

    // Re-attach whatever escape prefix was held back from the previous chunk.
    const s = this.partialEscape + rest;
    this.partialEscape = '';
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i] as string;
      if (c === '"') {
        this.state = 'done';
        break;
      }
      if (c !== '\\') {
        out += c;
        i++;
        continue;
      }
      // An escape. Everything from here may be incomplete.
      const next = s[i + 1];
      if (next === undefined) {
        this.partialEscape = s.slice(i);
        break;
      }
      if (next === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4) {
          this.partialEscape = s.slice(i);
          break;
        }
        // Surrogate halves decode independently and concatenate correctly.
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      const lit = ESCAPES[next];
      // An unknown escape is not ours to repair — pass the character through,
      // which is what every lenient JSON reader does and what keeps a novel
      // escape from silently eating a word.
      out += lit ?? next;
      i += 2;
    }
    this.decoded += out;
    return out;
  }
}

/**
 * Every reply block in flight on the main thread, keyed by the stream's block
 * INDEX — which is the only correlation the delta events carry (they have no
 * tool_use id of their own; only `content_block_start` does).
 *
 * A single assistant message can open several reply blocks (the contract
 * actively asks for two to four short replies), so this is a map and not a
 * single slot. Indices are reused across messages, hence the overwrite on
 * start and the delete on stop.
 */
export class ReplyBlockTracker {
  private readonly open = new Map<number, { id: string; streamer: ReplyArgStreamer }>();

  /** A `content_block_start`. Returns the tool_use id if it is a reply. */
  start(index: number, contentBlock: unknown): string | null {
    if (!isReplyBlock(contentBlock)) {
      // Not a reply — but the index may be a stale reply from a previous
      // message, and leaving it open would misattribute this block's deltas.
      this.open.delete(index);
      return null;
    }
    const id = (contentBlock as { id?: string }).id;
    if (typeof id !== 'string' || !id) return null;
    this.open.set(index, { id, streamer: new ReplyArgStreamer() });
    return id;
  }

  /** An `input_json_delta`. Returns the newly decoded text, or null if this
   *  index is not a reply block. */
  delta(index: number, partialJson: string): { id: string; delta: string } | null {
    const entry = this.open.get(index);
    if (!entry) return null;
    const delta = entry.streamer.push(partialJson);
    return delta ? { id: entry.id, delta } : null;
  }

  /** A `content_block_stop`. */
  stop(index: number): void {
    this.open.delete(index);
  }

  /** Drop everything (turn boundaries, interrupts). */
  clear(): void {
    this.open.clear();
  }
}
