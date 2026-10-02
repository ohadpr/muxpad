/**
 * Everything the chat shows BEFORE (and around) a running conversation: the
 * folder and harness pickers, the no-runner and ready-to-start screens, and the
 * session bar across the top.
 *
 * Split out of ChatPane.tsx. Nothing here changed in the move.
 *
 * These are the screens a chat wears when there is no transcript to draw — and
 * the one strip that stays visible when there is. They were always separable:
 * each takes its data as props and reports back through callbacks, holding no
 * socket and no turn state, which is why several of them were already exported
 * and tested on their own.
 */
import { AGENT_MODE_LABELS, type AgentMode, type AgentSessionStatus } from '@muxpad/shared';
import { useEffect, useRef, useState } from 'react';
import { type RecentFolder, api } from '../api';
import { AGENT_BACKENDS, type AgentBackendId, backendLabel } from '../lib/agent-backend';
import { sessionModelLabel } from '../lib/live-status';
import { showFolderChip } from '../lib/nav-row-affordances';
import { useDismissable } from '../lib/use-dismissable';
import { AgentBackendLogo, backendFromAssistant } from './AgentLogos';
import { RosterSpinner } from './ChatTranscript';
import { SvgGlobe, SvgTerminalGlyph } from './PaneWebSwitch';

export function SvgFolder({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        d="M2 4.5C2 3.7 2.7 3 3.5 3h2.6c.5 0 .9.2 1.2.6l.6.8h4.6c.8 0 1.5.7 1.5 1.5v5.1c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5v-7Z"
      />
    </svg>
  );
}

/** The mode chip's glyph. Two shapes, not one shape in two colours: Chat is a
 *  speech bubble (you are talking to muxpad's assistant), Agent is a bare
 *  terminal caret (the harness, as it ships). Colour alone would be invisible
 *  to anyone who can't see the hue difference at 12px. */
export function SvgModeGlyph({ mode, size = 12 }: { mode: AgentMode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      {mode === 'chat' ? (
        <path
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h7.8c.9 0 1.6.7 1.6 1.6v4.9c0 .9-.7 1.6-1.6 1.6H6.9L3.7 13.2v-2.5h-1.2V4.2Z"
        />
      ) : (
        <>
          <path
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m3.4 5.1 2.6 2.6-2.6 2.6M7.9 11.2h4.7"
          />
          <rect
            x="1.4"
            y="2.4"
            width="13.2"
            height="11.2"
            rx="1.6"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </>
      )}
    </svg>
  );
}

/** Display name for the pane's agent backend — used in composer/working copy
 *  so a Codex/Cursor pane doesn't say "Claude". */
export function assistantLabel(a: string | null | undefined): string {
  if (a === 'codex') return 'Codex';
  if (a === 'cursor') return 'Cursor';
  return 'Claude';
}

/** Session status pushed by the agent runner — shape shared with the server
 * pipeline via @muxpad/shared so the two ends can't drift apart. */
export type AgentStatus = AgentSessionStatus;
export type StatusPanel = 'folder' | 'model' | 'live' | null;

export interface RosterAgent {
  id: string;
  label: string;
  steps: number;
  busy: boolean;
  /**
   * A CHILD CHAT rather than a harness subagent.
   *
   * Both are parallel work this chat started, which is why they share the count
   * and the panel — but they are not the same thing and the panel says so: a
   * subagent dies with the turn that launched it, a child chat outlives a runner
   * restart, has its own transcript, and is reachable (its card is below, in the
   * log). Absent = a subagent, which keeps every existing entry as it was.
   */
  chat?: { workspaceSlug: string; tabSlug: string };
}

/** Trim a trailing slash so `/a/b` and `/a/b/` compare equal. */
export const normPath = (s: string) => s.replace(/\/+$/, '') || '/';

/**
 * Choose a folder: one-tap chips for the places you've recently worked, plus a
 * field for anywhere else.
 *
 * ONE implementation, two callers — the session menu's "Switch folder" panel
 * and the launch card. They differ only in what the commit button says and what
 * it does with the value, so the *choosing* is shared: a second folder UI would
 * be the same drift that gave four "+" buttons three different meanings.
 *
 * Chips SET the field rather than committing. Both callers restart a session on
 * commit, so a chip that fired immediately would be a destructive one-tap
 * target sitting under a thumb.
 */
export function FolderChoice({
  inputId,
  value,
  onChange,
  onSubmit,
  folders,
  current,
  disabled,
  autoFocus,
}: {
  inputId: string;
  value: string;
  onChange: (next: string) => void;
  /** Enter in the field. Omitted = Enter does nothing (card has its own button). */
  onSubmit?: (() => void) | undefined;
  folders: RecentFolder[];
  /** The pane's folder right now — always offered, even if it isn't "recent". */
  current: string | null;
  disabled?: boolean;
  /** Focus the field on mount. The session-menu "Switch folder" panel opens
   *  BECAUSE you asked to type a folder, so it should not cost another tap;
   *  the launch card does not set this, since its likely answer is a chip. */
  autoFocus?: boolean;
}) {
  // The current folder leads the row: keeping things where they are is the
  // most likely answer, and it must never be the one option you can't tap.
  const chips: RecentFolder[] = [];
  const seen = new Set<string>();
  const push = (f: RecentFolder) => {
    if (seen.has(normPath(f.path))) return;
    seen.add(normPath(f.path));
    chips.push(f);
  };
  if (current) {
    const known = folders.find((f) => normPath(f.path) === normPath(current));
    push(
      known ?? {
        path: current,
        name: current.split('/').filter(Boolean).pop() || current,
        short: current,
        hasProject: true,
      },
    );
  }
  for (const f of folders) push(f);
  const selected = normPath(value.trim());
  return (
    <div className="chat-folder-choice">
      {chips.length > 0 ? (
        <div className="chat-folder-chips">
          {chips.map((f) => (
            <button
              key={f.path}
              type="button"
              className="chat-folder-chip"
              aria-pressed={normPath(f.path) === selected}
              disabled={disabled}
              title={f.path}
              onClick={() => onChange(f.path)}
            >
              <span className="chat-folder-chip-name">{f.name}</span>
              {/* The bare basename is ambiguous across worktrees — the
                  `~`-relative path underneath is what tells them apart. */}
              <span className="chat-folder-chip-path">{f.short}</span>
            </button>
          ))}
        </div>
      ) : null}
      <input
        id={inputId}
        // biome-ignore lint/a11y/noAutofocus: the panel exists to be typed in
        autoFocus={autoFocus}
        className="chat-folder-input"
        value={value}
        spellCheck={false}
        disabled={disabled}
        aria-label="Working folder path"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}

/**
 * "Start Claude here, on this model" — the setup step between tapping a harness
 * and it starting.
 *
 * WHY IT EXISTS. Tapping Claude/Codex/Cursor used to convert the pane in place
 * and instantly: same pane, same position, same greeting. Nothing visibly
 * happened, so it read as a dead button. And folder + model — the two things
 * you are obviously deciding at that exact moment — were deferred to a session
 * menu behind the model chip, discoverable only if you already knew.
 *
 * So the tap now opens this card instead of firing. It is still ONE TAP for
 * anyone who doesn't care: both fields arrive pre-answered (the pane's current
 * folder; the harness's own default model), so "Start" is immediately correct.
 */
export function HarnessLaunchCard({
  backend,
  folders,
  models,
  paneCwd,
  cwd,
  setCwd,
  model,
  setModel,
  busy,
  error,
  onCancel,
  onStart,
}: {
  backend: AgentBackendId;
  folders: RecentFolder[];
  models: Array<{ value: string; displayName: string; resolvedModel?: string }>;
  /** Where the pane is NOW — always a chip, even when it isn't "recent", so
   *  "leave it where it is" is never the one option you can't tap. */
  paneCwd: string | null;
  cwd: string;
  setCwd: (v: string) => void;
  model: string | null;
  setModel: (v: string | null) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onStart: () => void;
}) {
  const label = backendLabel(backend);
  // Only warn about missing project context when we actually KNOW — i.e. the
  // chosen path is one the server described. A typed path we haven't asked
  // about gets no warning rather than a guessed one.
  const known = folders.find((f) => normPath(f.path) === normPath(cwd.trim()));
  // Claude's own model list contains a literal `default` entry, and this card
  // already HAS a Default pill that means "pass no --model at all". Showing
  // both drew two identical buttons, one of which would have pinned the
  // string 'default' as if it were a model id.
  const pinnable = models.filter((m) => m.value !== 'default');
  return (
    // A labelled SECTION, not a dialog: the card is inline and non-modal — it
    // traps nothing and simply replaces the strip it grew out of — so the
    // semantic element carries the label rather than an ARIA role.
    <section className="chat-launch-card" aria-label={`Start ${label}`}>
      <div className="chat-launch-head">
        <AgentBackendLogo backend={backend} size={18} />
        <span className="chat-launch-title">{label}</span>
        <span className="chat-launch-sub">Agent mode — no muxpad contract</span>
        <button
          type="button"
          className="chat-launch-cancel"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel"
        >
          ✕
        </button>
      </div>

      <div className="chat-launch-section">
        <div className="chat-launch-lbl">Folder</div>
        <FolderChoice
          inputId={`launch-cwd-${backend}`}
          value={cwd}
          onChange={setCwd}
          onSubmit={onStart}
          folders={folders}
          current={paneCwd}
          disabled={busy}
        />
        {known && !known.hasProject ? (
          <div className="chat-launch-note">
            No project context here — no git repo, AGENTS.md, or .mcp.json up the tree.
          </div>
        ) : null}
      </div>

      <div className="chat-launch-section">
        <div className="chat-launch-lbl">Model</div>
        <div className="chat-launch-models">
          <button
            type="button"
            className="chat-launch-model"
            aria-pressed={model === null}
            disabled={busy}
            onClick={() => setModel(null)}
          >
            Default
          </button>
          {pinnable.map((m) => (
            <button
              key={m.value}
              type="button"
              className="chat-launch-model"
              aria-pressed={model === m.value}
              disabled={busy}
              title={m.resolvedModel ?? m.value}
              onClick={() => setModel(m.value)}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      </div>

      <button type="button" className="chat-launch-go" disabled={busy} onClick={onStart}>
        {busy ? `Starting ${label}…` : `Start ${label}`}
      </button>
      {error ? <output className="chat-open-instead-error">{error}</output> : null}
    </section>
  );
}

/** What a conversion that LANDED says about itself. Held for CONVERT_CONFIRM_MS. */
export interface ConversionReceipt {
  backend: AgentBackendId;
  cwd: string;
  model: string | null;
}

/**
 * AN AGENT-BACKED PANE WITH NOTHING RUNNING IN IT.
 *
 * This used to read "No agent session here yet — start one with `muxpad agent`
 * … in the terminal", which is wrong on both counts. It is wrong as ADVICE:
 * mobile is the primary surface and a phone has no terminal, so the one action
 * offered was unreachable on the device most likely to be showing it — and it
 * is absurd under a button whose entire job is to start an agent. It is also
 * wrong as a DIAGNOSIS: this pane is not unconfigured. Its row already carries
 * the backend, the mode, the folder and the startup command; the only missing
 * thing is a process.
 *
 * So the state offers the one verb that fits — start the thing this pane
 * already is — and when that fails it says WHY, in the server's own words
 * (`respawn` answers 503 with a reason when ptyd is unreachable). An honest
 * error is the fallback, never shell homework.
 *
 * Exported for tests; `onStart` is wired to POST /api/panes/:id/respawn.
 */
export function ChatNoRunner({
  busy,
  error,
  failed = false,
  onStart,
}: {
  busy: boolean;
  error: string | null;
  /**
   * The server knows this pane's agent FAILED to start, rather than merely not
   * being there. Changes the two lines of copy and nothing else — same verb,
   * same button, because the fix is the same.
   *
   * Why it exists: the neutral screen below describes a steady state, and the
   * bug it was masking is that creating a chat could fail silently. The user
   * tapped New chat, landed on "This chat has no agent yet", and was asked to
   * press Start agent for something they had just created — with no hint that
   * anything had gone wrong, let alone what. The neutral copy stays, because it
   * is still correct for a pane nobody has started (a converted terminal, a
   * pane whose runner was killed); this flag is what stops it standing in for a
   * failure.
   */
  failed?: boolean;
  onStart: () => void;
}) {
  // While it is coming up we show the SAME spinner the pre-grace state shows.
  // The respawn request returning is not the agent being up — the runner still
  // has to boot and hello — and flipping back to "nothing running" underneath a
  // live boot is the same lie the old copy told, just faster.
  if (busy)
    return (
      <div className="chat-empty">
        <div className="chat-empty-spinner" aria-hidden="true" />
        <p>Starting…</p>
      </div>
    );
  return (
    <div className="chat-empty">
      <div className="chat-empty-mark" aria-hidden="true">
        ✳
      </div>
      <p className="chat-empty-title">
        {failed ? 'This chat’s agent could not start' : 'Nothing running here'}
      </p>
      <p className="chat-empty-hint">
        {failed
          ? 'muxpad tried a few times and gave up. Try again:'
          : 'This chat has no agent yet.'}
      </p>
      <button type="button" className="chat-launch-go" onClick={onStart}>
        {failed ? 'Try again' : 'Start agent'}
      </button>
      {/* <output> is the live region — announced without stealing the
          composer's focus, same as the conversion refusal. */}
      {error ? <output className="chat-convert-refusal">{error}</output> : null}
    </div>
  );
}

/**
 * The empty chat's greeting — and the whole reason a conversion is visible.
 *
 * Converting a pane's harness changes nothing about WHERE it is: same pane,
 * same position, same size. So the only place the change can show is the one
 * thing the user is looking at, and this used to be a generic `✳ Ready when
 * you are` that was byte-identical before and after. It now carries the
 * harness's own mark and names it, with the folder underneath — so Claude → Codex
 * is legible at a glance, permanently, not just for the length of a toast.
 *
 * The toast is here too, because "permanently different" and "something just
 * happened" are different jobs: the identity line answers *what is this*, the
 * receipt answers *did my tap do anything*. Both are needed; neither replaces
 * the other.
 *
 * Exported for tests — this is the assertion surface for "a converted pane
 * looks different".
 */
export function ChatReadyGreeting({
  assistant,
  cwd,
  mode,
  converted,
  refusal,
}: {
  assistant: string | undefined;
  cwd: string | null;
  /** The pane's mode. Chat identifies as Chat, not as the harness under it. */
  mode: AgentMode | null;
  converted: ConversionReceipt | null;
  refusal: string | null;
}) {
  // CHAT DOES NOT NAME ITS HARNESS OR ITS FOLDER. Chat IS Claude — that is a
  // fact about the implementation, not a choice the user made, and printing
  // "Claude" here invited the reasonable question of why a thing called Chat
  // says Claude. The folder goes for the same reason: in Chat mode it is not
  // something you picked, and showing a path implies a control that isn't
  // there. Agent mode still names both, because there they ARE your choices.
  const isChat = mode === 'chat';
  return (
    <>
      <div className="chat-empty-mark -logo" aria-hidden="true">
        {isChat ? (
          <SvgModeGlyph mode="chat" />
        ) : (
          <AgentBackendLogo backend={backendFromAssistant(assistant)} size={26} />
        )}
      </div>
      <p className="chat-empty-title">Ready when you are</p>
      <p className="chat-empty-ident">
        <span className="chat-empty-ident-name">{isChat ? 'Chat' : assistantLabel(assistant)}</span>
        {!isChat && cwd ? <span className="chat-empty-ident-cwd">{cwd}</span> : null}
      </p>
      {converted ? (
        // <output> is the live region for "result of the thing you just
        // pressed" — announced without stealing focus from the composer.
        <output className="chat-convert-confirm">
          <AgentBackendLogo backend={converted.backend} size={14} />
          <span>
            Now running {backendLabel(converted.backend)}
            {converted.model ? ` · ${converted.model}` : ''}
            {converted.cwd ? ` · ${converted.cwd}` : ''}
          </span>
        </output>
      ) : null}
      {refusal ? <output className="chat-convert-refusal">{refusal}</output> : null}
    </>
  );
}

/**
 * "or open instead" — the alternatives to a new Chat, shown in the empty
 * state directly under the greeting.
 *
 * This replaced a full-screen "What do you want to open?" chooser. That
 * screen made every new tab a question before it was a place, and the answer
 * was almost always "the chat" — so the chat is now the default and the
 * question became a secondary offer. It first shipped as a tiny text strip
 * above the composer, which was too timid to find; it now sits where the eye
 * already is, with real tappable buttons.
 *
 * Still deliberately quiet — muted until touched, no accent fills — because
 * it IS the secondary path. And it exists only while the chat is empty: the
 * moment you say something, this is not a decision you're making any more.
 *
 * The three harnesses open the pane in AGENT MODE (the harness as it ships,
 * no muxpad contract). Tapping one does NOT convert on the spot — it opens the launch
 * card (folder + model, both pre-answered), and the card's button converts.
 * Terminal and Web view have nothing to configure, so they still fire directly.
 * All five are the same server-side respawn, which refuses (cleanly) on any
 * chat that already has messages.
 */
export function OpenInsteadStrip({
  busy,
  error,
  onBackend,
  onTerminal,
  onWeb,
}: {
  busy: AgentBackendId | 'terminal' | 'web' | null;
  error: string | null;
  onBackend: (b: AgentBackendId) => void;
  onTerminal: () => void;
  onWeb: () => void;
}) {
  return (
    <div className="chat-open-instead">
      {/* "Agent mode" NAMES THE THING, and that matters here more than
          anywhere: the first button is Claude, and a bare "Claude" sitting
          under a Chat that is already Claude reads as an inexplicable
          duplicate. Labelled as Agent mode it reads as what it is — the same
          harness, raw, with the folder and model yours to choose. */}
      <div className="chat-open-instead-lbl">or open in Agent mode</div>
      <div className="chat-open-instead-row">
        {AGENT_BACKENDS.map((b) => (
          <button
            key={b.id}
            type="button"
            className="chat-open-instead-btn"
            disabled={busy !== null}
            aria-busy={busy === b.id}
            title={`Open ${b.label} in Agent mode — the harness as it ships`}
            onClick={() => onBackend(b.id)}
          >
            <AgentBackendLogo backend={b.id} size={18} />
            <span>{b.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="chat-open-instead-btn"
          disabled={busy !== null}
          aria-busy={busy === 'terminal'}
          title="Turn this pane into a plain terminal"
          onClick={onTerminal}
        >
          <SvgTerminalGlyph />
          <span>Terminal</span>
        </button>
        <button
          type="button"
          className="chat-open-instead-btn"
          disabled={busy !== null}
          aria-busy={busy === 'web'}
          title="Turn this pane into a web view"
          onClick={onWeb}
        >
          <SvgGlobe />
          <span>Web view</span>
        </button>
      </div>
      {/* <output> is the semantic live region for "result of the thing you
          just pressed" — it announces without stealing focus. */}
      {error ? <output className="chat-open-instead-error">{error}</output> : null}
    </div>
  );
}

/**
 * The two modes, as the menu lists them. Description is the WHOLE pitch —
 * these two sentences are the only place the vocabulary is explained, so they
 * have to carry it.
 */
export const MODE_CHOICES: ReadonlyArray<{ id: AgentMode; label: string; desc: string }> = [
  // Chat doesn't name a harness on purpose: it IS Claude, and which engine is
  // underneath is not a choice you make here (see modeForBackend). Agent is
  // where you pick one.
  {
    id: 'chat',
    label: 'Chat',
    desc: 'muxpad’s assistant — decisive, brief, speaks only when it has something.',
  },
  { id: 'agent', label: 'Agent', desc: 'Pick the harness — as it ships, no muxpad contract.' },
];

/**
 * The SESSION LINE: one quiet strip above the composer pill, never more than one
 * line long. Each cell opens its own upward panel; only one panel at a time.
 *
 * ── WHAT EARNS PERMANENT SPACE ──────────────────────────────────────────────
 * It read `Agent · muxpad · claude-opus-5 · 25% · 2 agents`, and at 390px with
 * a real folder name that wrapped — which, because the strip sat above the input
 * INSIDE the bottom-anchored pill, shoved the composer down. Five cells was two
 * too many, so they were sorted by whether they CHANGE:
 *
 *   · LIVE (`2 agents` / `Working…`) — the persistent "something is running"
 *     indicator, asked for twice, and the only cell you can open. It is the
 *     reason the line exists, so it is the one cell excused from shrinking.
 *   · FOLDER — the fact that distinguishes two otherwise identical panes, and
 *     only when the pane actually sits in a project (showFolderChip). Truncates.
 *   · SESSION (backend logo + model) — the anchor for everything that IS a dial:
 *     the model list, the context meter, compact, clear, and the folder path when
 *     the chip is hidden. Truncates.
 *
 * And what came OFF the line, with where it went:
 *   · THE MODE WORD, in Agent mode. The model cell — logo and all — renders only
 *     in Agent mode, so its presence already states the arrangement; the word was
 *     the longest thing on the line saying nothing new. It is listed in the
 *     session menu instead. Chat mode KEEPS the word, because there the cell is
 *     the only thing on the line and has to carry it alone.
 *   · THE CONTEXT PERCENTAGE. A number that asks to be watched, in a strip you
 *     glance at. The session menu has had a labelled meter and a token count the
 *     whole time — strictly more information, one tap away, and nobody monitors
 *     a context window continuously.
 *   · THE VENDOR PREFIX of the model id (`claude-opus-5` → `Opus 5`, see
 *     sessionModelLabel). The Claude logo is rendered immediately to its left.
 *
 * WHY MODE IS HERE AT ALL. It used to be deliberately hidden — internal plumbing
 * with no UI. Once the two modes got names a person can say (Chat / Agent) that
 * stopped being defensible: the pane's arrangement is part of its identity, and
 * identity already lives in this row. It is NOT in the sidebar rail, which runs
 * on a strict one-bit (status) budget; adding a second channel there is how a
 * rail becomes a dashboard.
 */
// Exported for its test (like ChatReadyGreeting / HarnessLaunchCard below): what
// this strip claims is running is a load-bearing statement, and the defect it
// carried — "0 agents" through a dozen working children — is not visible by eye.
export function SessionBar({
  paneId,
  folder,
  status,
  assistant,
  send,
  liveLabel,
  agents,
  onOpenChat,
  mode,
}: {
  paneId: string;
  folder: { cwd: string; hasProject: boolean } | null;
  status: AgentStatus | null;
  assistant?: string;
  send: (obj: unknown) => void;
  liveLabel: string | null;
  agents: RosterAgent[];
  /** Go to a chat — only ever called for a CHILD row (see RosterAgent.chat). */
  onOpenChat?: ((chat: { workspaceSlug: string; tabSlug: string }) => void) | undefined;
  /** The pane's mode, or null when the server hasn't told us — no chip. */
  mode: AgentMode | null;
  /** Optimistic local echo + the "here is what actually just happened" notice.
   *  The authoritative value still arrives on the next session frame. */
}) {
  const [panel, setPanel] = useState<StatusPanel>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissable(panel !== null, wrapRef, () => setPanel(null));
  const toggle = (p: Exclude<StatusPanel, null>) => setPanel((cur) => (cur === p ? null : p));
  // If the open segment's data goes away (turn ends, status drop, folder
  // cleared), close the panel — otherwise it auto-reopens next time that
  // segment remounts with stale panel === 'live'|'model'|'folder'.
  useEffect(() => {
    if (panel === 'live' && !liveLabel) setPanel(null);
    else if (panel === 'model' && (!status || mode === 'chat')) setPanel(null);
    else if (panel === 'folder' && !folder) setPanel(null);
  }, [panel, liveLabel, status, folder, mode]);

  // ── Folder switcher state ────────────────────────────────────────────
  const [draft, setDraft] = useState(folder?.cwd ?? '');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  // Recent folders for the chips — the SAME list the launch card offers, from
  // the same endpoint. Fetched only when this panel is actually opened.
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const recentFetched = useRef(false);
  useEffect(() => {
    if (panel === 'folder' && folder) {
      setDraft(folder.cwd);
      setFolderErr(null);
    }
    if (panel !== 'folder' || recentFetched.current) return;
    recentFetched.current = true;
    void api
      .agentLaunchOptions()
      .then((o) => setRecent(o.folders))
      .catch(() => {
        // Chips are a shortcut; the path field is the guaranteed way in.
      });
  }, [panel, folder]);
  const norm = (s: string) => s.replace(/\/+$/, '');
  const folderBase = folder ? norm(folder.cwd).split('/').pop() || folder.cwd : '';
  const submitFolder = async () => {
    if (!folder || folderBusy) return;
    const next = draft.trim();
    if (!next || norm(next) === norm(folder.cwd)) {
      setPanel(null);
      return;
    }
    setFolderBusy(true);
    setFolderErr(null);
    try {
      await api.setPaneCwd(paneId, next);
      setPanel(null);
    } catch (e) {
      setFolderErr(e instanceof Error ? e.message : 'could not switch folder');
    } finally {
      setFolderBusy(false);
    }
  };

  // ── Model / session menu ─────────────────────────────────────────────
  const supportsSlash = assistant !== 'codex' && assistant !== 'cursor';
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (panel !== 'model') setConfirmClear(false);
  }, [panel]);
  const list = status?.models ?? [];
  const modelLc = status?.model.toLowerCase() ?? '';
  const current = status
    ? (list.find((m) => m.value === status.model) ??
      list.find((m) => m.value !== 'default' && m.resolvedModel === status.model) ??
      list.find((m) => m.resolvedModel === status.model) ??
      list.find((m) => m.value.toLowerCase() === modelLc))
    : undefined;
  const modelLabel = current?.displayName ?? status?.model ?? '';
  const ctx = status?.context;
  const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

  // Does the folder deserve a cell in the header at all?
  //
  // ONLY when the pane actually sits in a project (git repo / AGENTS.md /
  // .mcp.json up the tree — the same hasProjectContext the server computes).
  // For a plain conversation the working directory is an implementation
  // detail: showing "~" next to a red "!" told the user their chat was
  // BROKEN, when nothing was wrong — you just weren't coding. So a
  // non-project chat shows no path and no warning at all.
  //
  // The folder is not lost: it moves into the session menu (the model chip),
  // which still lists the full path and opens the same switcher.
  // Chat mode surfaces no folder control at all — see ChatReadyGreeting. The
  // path is still reachable (the session menu behind the model chip lists it),
  // it just isn't presented as a dial in the mode that doesn't have one.
  const folderChipVisible = mode !== 'chat' && showFolderChip(folder);
  const folderPanel =
    folder && panel === 'folder' ? (
      <div className="chat-status-menu chat-folder-menu" role="dialog">
        <div className="chat-folder-path">{folder.cwd}</div>
        {!folder.hasProject ? (
          <div className="chat-folder-nocontext">
            No project context here — no git repo, AGENTS.md, or .mcp.json up the tree. Fine for a
            plain conversation; switch to a project folder to give the agent its rules and MCP.
          </div>
        ) : null}
        <label className="chat-folder-lbl" htmlFor={`fld-${paneId}`}>
          Switch folder — starts a fresh agent here
        </label>
        {/* Same chooser as the launch card (see FolderChoice) — one folder UI,
            so "the places I work" are one tap from both. */}
        <FolderChoice
          inputId={`fld-${paneId}`}
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submitFolder()}
          folders={recent}
          current={folder.cwd}
          disabled={folderBusy}
          autoFocus
        />
        {folderErr ? <div className="chat-folder-error">{folderErr}</div> : null}
        <button
          type="button"
          className="chat-folder-go"
          disabled={folderBusy}
          onClick={() => void submitFolder()}
        >
          {folderBusy ? 'Switching…' : 'Switch & start fresh'}
        </button>
      </div>
    ) : null;

  return (
    <div className="chat-status-bar" ref={wrapRef}>
      {/* INDICATOR, NOT A SWITCH. This reads which mode the pane is in and
          stops there — no menu, no toggle. Switching mid-session was built and
          then removed: no harness can rewrite a live session's system prompt
          (agent-modes.ts documents the evidence backend by backend), so the new
          contract could only ever arrive as a message the conversation drifts
          from. A control that under-delivers on its own label is worse than no
          control — a new pane in the mode you want gets the real thing, and
          that is the only honest way to change it. The mode is still settable
          at creation and over the API; it just isn't a button here. */}
      {/* CHAT MODE ONLY, and that is a width decision rather than a change of
          heart. In Agent mode the model cell renders a backend logo and a model
          name — neither of which Chat mode shows — so "Agent" next to them was
          the longest cell on the line contributing nothing a reader could not
          already see. It moves into the session menu, which is one tap from the
          same spot. Chat mode has no model cell and no folder cell, so here the
          word is the only thing identifying the pane and it stays. */}
      {mode === 'chat' ? (
        <div
          className="chat-status-seg -mode -static"
          title={`${AGENT_MODE_LABELS[mode]} mode — ${
            MODE_CHOICES.find((m) => m.id === mode)?.desc ?? ''
          }`}
        >
          <SvgModeGlyph mode={mode} />
          <span className="chat-status-seg-label">{AGENT_MODE_LABELS[mode]}</span>
        </div>
      ) : null}

      {folderChipVisible && folder ? (
        // `-folder` buys it a FASTER shrink than its neighbours. Flex shrinks in
        // proportion to base size, so the longest cell keeps the most absolute
        // width — at 320px that gave `trayo-self-serve…` room while squeezing the
        // model to `Op…`, which is exactly backwards. A clipped folder name is
        // still recognisable; a clipped model name is two letters.
        <div className="chat-status-seg-wrap -folder">
          <button
            type="button"
            className={`chat-status-seg${panel === 'folder' ? ' is-open' : ''}`}
            onClick={() => toggle('folder')}
            aria-expanded={panel === 'folder'}
            title={folder.cwd}
          >
            <SvgFolder />
            <span className="chat-status-seg-label">{folderBase}</span>
          </button>
          {folderPanel}
        </div>
      ) : null}

      {/* CHAT SHOWS NO MODEL AND NO CONTEXT METER. Both are dials, and Chat
          has none: it runs the default model and compacts itself. A percentage
          is worse than merely redundant — it is a number that asks to be
          watched, in the one mode whose whole promise is that you do not have
          to. `/compact` and `/clear` are slash commands typed in the composer,
          so nothing here is the only way to reach them. Agent mode keeps the
          chip: there the model IS your choice and the meter is the budget you
          are spending. */}
      {mode !== 'chat' && (status || assistant) ? (
        <div className="chat-status-seg-wrap">
          <button
            type="button"
            className={`chat-status-seg${panel === 'model' ? ' is-open' : ''}`}
            onClick={() => (status ? toggle('model') : undefined)}
            aria-haspopup={status ? 'menu' : undefined}
            aria-expanded={status ? panel === 'model' : undefined}
            // The tooltip is where the full, exact id lives, alongside the mode
            // the cell no longer spells out and a list of what the menu holds.
            title={
              status
                ? `${AGENT_MODE_LABELS[mode ?? 'agent']} mode · ${assistantLabel(assistant)}${
                    status.activeModel || status.model
                      ? ` · ${status.activeModel ?? status.model}`
                      : ''
                  } — model, context, folder, compact, clear`
                : assistantLabel(assistant)
            }
          >
            <AgentBackendLogo backend={backendFromAssistant(assistant)} size={12} />
            {/* NO CONTEXT PERCENTAGE. It was the second-longest cell on a line
                that could not afford five, and it is the one nobody watches
                continuously — the menu below has a labelled meter AND the token
                counts, which is more information in the place you go when you
                actually want to know. The model id loses its vendor prefix for
                the same reason the mode word went: the logo to its left is
                already saying "Claude". */}
            <span className="chat-status-seg-label">
              {status ? sessionModelLabel(modelLabel) : assistantLabel(assistant)}
            </span>
          </button>
          {/* When the folder chip is hidden (a plain, non-project chat) the
              switcher still has to be reachable — it opens from the session
              menu's "Working folder" row instead, anchored here. */}
          {!folderChipVisible ? folderPanel : null}
          {panel === 'model' && status ? (
            <div className="chat-status-menu chat-session-menu" role="menu">
              {/* THE MODE, since the bar no longer spells it out in this mode.
                  Read-only for the same reason the chip was: no harness can
                  rewrite a live session's system prompt, so a switch here could
                  only ever deliver the new contract as a message the
                  conversation drifts from. A new pane in the mode you want is
                  the only honest way to change it. */}
              {mode ? (
                <>
                  <div className="chat-session-head">Mode</div>
                  <div className="chat-session-item -static">
                    <span className="chat-session-item-label">{AGENT_MODE_LABELS[mode]}</span>
                    <span className="chat-session-item-desc">
                      {MODE_CHOICES.find((m) => m.id === mode)?.desc ?? ''}
                    </span>
                  </div>
                </>
              ) : null}
              {/* Working folder — only listed when it isn't already its own
                  cell in the bar, so the two never both show the path. */}
              {folder && !folderChipVisible ? (
                <>
                  <div className="chat-session-head">Folder</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-session-item"
                    onClick={() => setPanel('folder')}
                  >
                    <span className="chat-session-item-label">Working folder…</span>
                    <span className="chat-session-item-desc chat-model-id">{folder.cwd}</span>
                  </button>
                </>
              ) : null}
              {ctx ? (
                <>
                  <div className="chat-session-head">Context</div>
                  <div className="chat-session-context">
                    <div className="chat-session-bar">
                      <div
                        className="chat-session-bar-fill"
                        style={{ width: `${Math.min(100, ctx.pct)}%` }}
                      />
                    </div>
                    <span className="chat-session-context-label">
                      {ctx.pct}% · {kTokens(ctx.tokens)} / {kTokens(ctx.max)} tokens
                    </span>
                  </div>
                </>
              ) : null}
              {status.models?.length ? <div className="chat-session-head">Model</div> : null}
              {status.models?.map((m) => {
                // Show the CONCRETE id an alias resolves to (e.g. Opus →
                // claude-opus-4-8) so "which model exactly" is unambiguous. For
                // the active row prefer the live model the last turn actually ran
                // (status.model) over the alias's advertised resolution.
                const concrete =
                  m === current ? (status.activeModel ?? m.resolvedModel) : m.resolvedModel;
                const showConcrete = concrete && concrete !== m.value && concrete !== m.displayName;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="menuitem"
                    className={`chat-session-item${m === current ? ' is-active' : ''}`}
                    onClick={() => {
                      if (m !== current) send({ t: 'set-model', model: m.value });
                      setPanel(null);
                    }}
                  >
                    <span className="chat-session-item-label">{m.displayName}</span>
                    {showConcrete ? (
                      <span className="chat-session-item-desc chat-model-id">{concrete}</span>
                    ) : null}
                  </button>
                );
              })}
              {supportsSlash ? (
                <>
                  <div className="chat-session-head">Session</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-session-item"
                    onClick={() => {
                      send({ t: 'slash', cmd: 'compact' });
                      setPanel(null);
                    }}
                  >
                    <span className="chat-session-item-label">Compact conversation</span>
                    <span className="chat-session-item-desc">
                      Summarize history to free context
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`chat-session-item${confirmClear ? ' is-danger' : ''}`}
                    onClick={() => {
                      if (!confirmClear) {
                        setConfirmClear(true);
                        return;
                      }
                      send({ t: 'slash', cmd: 'clear' });
                      setPanel(null);
                    }}
                  >
                    <span className="chat-session-item-label">
                      {confirmClear ? 'Tap again to clear everything' : 'Clear conversation'}
                    </span>
                    {!confirmClear ? (
                      <span className="chat-session-item-desc">
                        Wipes the conversation — starts fresh
                      </span>
                    ) : null}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {liveLabel ? (
        // `-live` on the WRAPPER, not just the button: the wrapper is the bar's
        // flex item, so this is where "never shrink" has to be declared for
        // "12 agents" to survive 320px whole.
        <div className="chat-status-seg-wrap -live">
          {/* A BUTTON only when there is a roster to open. With no subagents the
              label is "Working…", and the panel below renders nothing for an
              empty roster — so a button there would be a control that visibly
              does nothing. Same static chip the mode indicator uses. */}
          {agents.length > 0 ? (
            <button
              type="button"
              className={`chat-status-seg -live${panel === 'live' ? ' is-open' : ''}`}
              onClick={() => toggle('live')}
              aria-expanded={panel === 'live'}
              aria-label={liveLabel}
              title={liveLabel}
            >
              <span className="chat-roster-spin -head" aria-hidden="true">
                <RosterSpinner />
              </span>
              <span className="chat-status-seg-label">{liveLabel}</span>
            </button>
          ) : (
            <div className="chat-status-seg -live -static" aria-label={liveLabel} title={liveLabel}>
              <span className="chat-roster-spin -head" aria-hidden="true">
                <RosterSpinner />
              </span>
              <span className="chat-status-seg-label">{liveLabel}</span>
            </div>
          )}
          {panel === 'live' && agents.length > 0 ? (
            <div className="chat-status-menu chat-live-menu" role="dialog">
              {/* "Subagents" only while that is all there is. A child chat in
                  this list is not a subagent, and calling it one would teach the
                  wrong thing about the only one of the two you can open. */}
              <div className="chat-session-head">
                {agents.every((a) => !a.chat)
                  ? `Subagent${agents.length === 1 ? '' : 's'}`
                  : 'Running'}
              </div>
              <ul className="chat-roster-list">
                {agents.map((a) => {
                  // Captured so the handler closes over a value TypeScript has
                  // already narrowed — `a.chat` inside the closure has not been.
                  const target = a.chat;
                  return (
                    <li key={a.id} className="chat-roster-item" data-busy={a.busy || undefined}>
                      <span className="chat-roster-spin" aria-hidden="true">
                        <RosterSpinner />
                      </span>
                      {/* A child chat is somewhere you can GO; a subagent is not. */}
                      {target ? (
                        <button
                          type="button"
                          className="chat-roster-name chat-roster-link"
                          onClick={() => onOpenChat?.(target)}
                        >
                          {a.label}
                        </button>
                      ) : (
                        <span className="chat-roster-name">{a.label}</span>
                      )}
                      {a.steps > 0 ? (
                        <span className="chat-roster-meta">
                          {a.steps} step{a.steps === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
