// Work handed from one chat to another, and the answer coming back — the
// MARKERS, and the instruction that makes the round trip happen.
//
// ── Why this is in `shared` ─────────────────────────────────────────────────
// It started in the web client (lib/chat-mention), because the only thing that
// ever wrote a directive was the composer: you typed `@Investing do X`, the
// client wrapped it, and the client parsed the answer back into a card. Then the
// SERVER acquired a reason to write one. A chat spawned by `muxpad agent new` is
// a direction in every sense — another chat's agent asked for work to be done
// and is waiting on the answer — and it was the one kind that was never told to
// report. The result: a worker finished, delivered nothing, and retired with
// `done_reason = 'delivered'` while the parent conversation said nothing at all.
// That is the bug the user described as "I got a push about A2 completing their
// work and I can't find anything about that subject".
//
// So this file sits where `cron.ts` sits, for exactly the reason stated there:
// the SERVER writes the marker and the CHAT CLIENT renders it, so the two must
// agree byte-for-byte, and a hand-kept second copy of the grammar is how a
// marker starts leaking into a conversation as raw XML. There is ONE builder and
// ONE parser for both doors — the `@` composer and a spawn.
//
// A directed message and its answer are REAL delivered messages: muxpad never
// writes an agent's transcript, it tails the file the harness owns. So each one
// carries a delimited block that is at once a genuine instruction to the agent
// receiving it ("this came from another chat") and the render hook the client
// keys on to draw a card instead of a wall of XML. Same shape, and the same
// reasoning, as the cron fire marker (cron.ts) — read that first if you are
// changing this.

const DIRECT_OPEN = /^\s*<muxpad-direct\b([^>]*)>([\s\S]*?)<\/muxpad-direct>\s*/;
const REPORT_TAG = /^\s*<muxpad-report\b([^>]*)>/;
const REPORT_CLOSE = '</muxpad-report>';

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? (m[1] as string) : null;
}

/** Attribute values are interpolated into a `"`-quoted attribute. */
function esc(v: string): string {
  return v.replace(/[<>"&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&amp;',
  );
}

/**
 * A value as LITERAL TEXT inside a `'…'` shell word.
 *
 * XML escaping is not shell quoting, and `esc` above is XML escaping. It leaves
 * the apostrophe alone — correctly, for an attribute in a `"`-quoted slot — and
 * the report-back command interpolates those same attributes into a
 * single-quoted shell argument. So a chat called `Ohad's project` produced a
 * ready-to-copy command whose quote ended in the middle of its own name:
 *
 *   muxpad agent send p1 '<muxpad-report … from="Ohad's project" …>
 *
 * `/bin/sh -n` rejects it with an unterminated quote, and the round trip then
 * depended on the receiving agent noticing and repairing our command. Review 3
 * named the real hole here: "shell quoting" was a boundary nobody's territory
 * claimed, in a file otherwise concerned with XML.
 *
 * `'\''` is the POSIX idiom — close the quote, an escaped literal apostrophe,
 * reopen — and it is the whole trick, because inside `'…'` nothing else has any
 * meaning at all.
 */
function shq(v: string): string {
  return v.replace(/'/g, `'\\''`);
}

function unesc(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export interface DirectMarker {
  /** Correlates the report with the card the sending chat is already showing. */
  id: string;
  /** Name of the chat that asked, for the receiving agent to say out loud. */
  from: string;
  /** Pane of the chat that asked — where the report has to be sent back to. */
  pane: string;
  /** The chat RECEIVING this. Pre-filled into the report template it copies, so
   *  the answer identifies itself without the agent having to know its own
   *  chat's name (it doesn't, reliably). */
  to?: string | undefined;
  /** …and its pane, so a device with no local record of the request can still
   *  resolve which chat the report came from. */
  toPane?: string | undefined;
}

/**
 * HOW the work arrived, which is the one line of the instruction that differs.
 *
 * 'directed' — the user typed `@Name do this` in another chat's composer.
 * 'spawned'  — this whole chat was created to do it (`muxpad agent new`). The
 *              distinction is worth stating to the agent because it changes what
 *              "report back" means: a directed chat has its own life to return
 *              to, a spawned one exists for this and nothing else.
 */
export type DirectOrigin = 'directed' | 'spawned';

/**
 * Wrap a directed request with its marker AND the instruction that makes the
 * round trip actually happen.
 *
 * The report-back line is a CLI invocation on purpose. `muxpad agent send` is
 * already the supported way one session talks to another (it queues if the
 * target is mid-turn), it needs no new server surface, and an agent that can
 * run a command can run this one. What it must not do is improvise the marker:
 * the first line is quoted here verbatim so that `parseReportMarker` on the
 * other side is matching a string this file also wrote.
 */
export function renderDirectMarker(
  marker: DirectMarker,
  body: string,
  origin: DirectOrigin = 'directed',
): string {
  // Fully pre-filled: the receiving agent copies a line, it does not compose
  // one. Every attribute in it is something this side already knows, and an
  // agent asked to invent `from` would invent something wrong.
  const report = `<muxpad-report id="${esc(marker.id)}" from="${esc(
    marker.to ?? '',
  )}" pane="${esc(marker.toPane ?? '')}"></muxpad-report>`;
  // Line by line, joined: the exact shape of these lines is the contract with
  // the agent reading them, so they are worth being able to see.
  //
  // Both interpolations into the COMMAND go through `shq` — see it for the
  // apostrophe that broke the template. The last line is the other half of the
  // same problem and cannot be escaped from here: the agent writes its own
  // prose, and "it's done" would end the quote just as a name did. So the marker
  // is stated as the contract and the delivery is explicitly not — an agent that
  // would rather POST, or quote differently, is doing the right thing as long as
  // the first line is the marker. (The durable fix is a stdin form of
  // `muxpad agent send`, which is the CLI's to add, not this file's.)
  const opening =
    origin === 'spawned'
      ? // A spawned worker is told THREE things a directed chat already knows:
        // that it exists for this task, that a human is not sitting here, and
        // that the answer has somewhere to be. The last one is the fix — a
        // worker that reports nothing leaves its parent with a card that says
        // `done` and not one word about what it found.
        `You were SPAWNED for this by the muxpad chat "${marker.from}" — this chat exists to do this work, and that chat is where the answer has to land. Nobody is reading this conversation.`
      : `Directed here from the muxpad chat "${marker.from}" — another chat's user, not this chat's.`;
  const note = [
    opening,
    'Do the work in THIS chat, then report back once, in one message:',
    `  muxpad agent send '${shq(marker.pane)}' '${shq(report)}`,
    "  <two or three sentences: what you did and what the answer is>'",
    "The single quotes are the shell's, so an apostrophe inside your sentences has",
    "to be written '\\'' — or send the message any other way you like. What matters",
    'is only that its FIRST LINE is exactly the marker above.',
    'Nothing else is needed — the chat that asked renders that message as a card.',
  ].join('\n');
  return `<muxpad-direct id="${esc(marker.id)}" from="${esc(marker.from)}" pane="${esc(
    marker.pane,
  )}">\n${note}\n</muxpad-direct>\n\n${body}`;
}

/**
 * The first message of a SPAWNED chat: the task, plus the contract that its
 * answer comes back.
 *
 * Deliberately a thin wrapper rather than a second format — it exists to fix the
 * argument mapping in ONE place, because `from`/`pane` are the PARENT's and
 * `to`/`toPane` are this chat's, and getting that backwards points the report at
 * the chat that is supposed to receive it.
 *
 * The correlation `id` is the CHILD'S TAB ID, not a fresh random one. It is the
 * durable handle both sides already have: the parent's spawn card is derived
 * from that very row (web/src/lib/chat-mention `spawnCards`), so a report can be
 * matched to the card that announced the spawn without anything storing a
 * mapping. No ledger is created here, on either side — the report is a real
 * message in a real transcript, which is the whole reason it beats a local echo.
 */
export function renderSpawnBriefing(input: {
  /** The child's tab id — the correlation handle. */
  childTabId: string;
  /** The child chat's name, for the report to identify itself by. */
  childName?: string | undefined;
  /** The child's own agent pane, so a device with no local record can resolve
   *  which chat answered. */
  childPane?: string | undefined;
  /** The spawning chat's name. */
  parentName: string;
  /** The spawning chat's AGENT pane — it must be one that can receive a send. */
  parentPane: string;
  /** The task, as the spawner wrote it. */
  task: string;
}): string {
  return renderDirectMarker(
    {
      id: input.childTabId,
      from: input.parentName,
      pane: input.parentPane,
      ...(input.childName ? { to: input.childName } : {}),
      ...(input.childPane ? { toPane: input.childPane } : {}),
    },
    input.task,
    'spawned',
  );
}

/** Split a delivered directed message back into its marker and the request. */
export function parseDirectMarker(text: string): { marker: DirectMarker; body: string } | null {
  const m = text.match(DIRECT_OPEN);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const id = attr(attrs, 'id');
  const from = attr(attrs, 'from');
  const pane = attr(attrs, 'pane');
  if (!id || !from || !pane) return null;
  return {
    marker: { id, from: unesc(from), pane: unesc(pane) },
    body: text.slice(m[0].length),
  };
}

export interface ReportMarker {
  /** The directive this answers. Empty when the agent omitted it. */
  id: string;
  /** The chat that is answering. Empty when the agent dropped the attribute. */
  from: string;
  /** Its pane — the fallback way to resolve which chat the report came from. */
  pane: string;
}

/** The answer's marker — written by the OTHER agent, parsed here. */
export function renderReportMarker(marker: ReportMarker, body: string): string {
  return `<muxpad-report id="${esc(marker.id)}" from="${esc(marker.from)}" pane="${esc(
    marker.pane,
  )}"></muxpad-report>\n${body}`;
}

/**
 * Recognise a report coming back from a directed chat.
 *
 * TOLERANT BY CONSTRUCTION, and this is the half of the round trip that needs
 * it: the string was typed by ANOTHER agent from an instruction, so a missing
 * `id`, an attribute it invented, a closing tag it forgot, or the answer written
 * INSIDE the element instead of after it must all still render as a report. The
 * failure mode being avoided is a bubble of raw XML where a card should be. The
 * only hard requirement is a leading tag — text that merely mentions one
 * mid-message is ordinary prose (same rule as the cron marker).
 */
export function parseReportMarker(text: string): { marker: ReportMarker; body: string } | null {
  const m = text.match(REPORT_TAG);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const close = rest.indexOf(REPORT_CLOSE);
  const inner = close >= 0 ? rest.slice(0, close) : '';
  const after = close >= 0 ? rest.slice(close + REPORT_CLOSE.length) : rest;
  const attrs = m[1] ?? '';
  return {
    marker: {
      id: unesc(attr(attrs, 'id') ?? ''),
      from: unesc(attr(attrs, 'from') ?? ''),
      pane: unesc(attr(attrs, 'pane') ?? ''),
    },
    // After the tag is the form we asked for; inside it is the form a model
    // writes anyway. Prefer the first, fall back to the second, lose neither.
    body: after.trim() || inner.trim(),
  };
}
