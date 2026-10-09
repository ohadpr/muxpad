import type { Workspace } from '@muxpad/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { refreshWorkspaces } from '../workspaces';
import './WorkspaceSettings.css';

/**
 * WHAT EVERY AGENT IN ONE WORKSPACE IS TOLD, AND WHAT IT IS ALLOWED TO DO.
 *
 * Until this existed, `readAgentInstructions(dataDir)` took a directory and
 * nothing else, so every agent in every workspace got byte-identical text —
 * INCLUDING the Slack section. A chat full of personal files was told it had
 * the company Slack and only found out otherwise by trying.
 *
 * ── TWO HALVES, AND THEY ARE NOT THE SAME KIND OF THING ─────────────────────
 * INSTRUCTIONS are prose. An agent may usefully maintain them, so they are
 * read/write from the CLI too (`muxpad workspace instructions <id>`) and this
 * panel is simply the comfortable surface for them.
 *
 * CAPABILITIES are permission. They are writable HERE AND NOWHERE ELSE: the
 * server refuses a capability PATCH that carries no browser `Origin`, which the
 * CLI and the agent runner never send. An agent that can grant itself Slack
 * makes the Slack guard decoration, so the one surface an agent cannot drive is
 * the one that holds the switch.
 *
 * A capability that is OFF is not merely refused at the call — the whole
 * fenced section is stripped from the instructions, so an agent is never told
 * about a tool it cannot use. The preview below is composed by the server with
 * the same function the backends call, because a preview assembled here would
 * be a second place deriving one value, and this codebase has paid for that
 * about six times.
 */

export interface WorkspaceSettingsProps {
  workspace: Workspace;
  onClose: () => void;
}

export function WorkspaceSettings({ workspace, onClose }: WorkspaceSettingsProps) {
  const [text, setText] = useState(workspace.instructions ?? '');
  const [slack, setSlack] = useState(!!workspace.slack);
  const [saved, setSaved] = useState<'clean' | 'saving' | 'saved'>('clean');
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Re-fetched on open and after every save, because either half changes it.
   *
   * A CALL, not an effect with the two values in its dependency list: the
   * effect body does not read them, so they would be a dependency list used as
   * a change notification — which lint correctly objects to and which reads as
   * a mistake to anyone maintaining it.
   */
  const loadPreview = useCallback(async () => {
    try {
      const r = await api.workspaceAgentInstructions(workspace.id);
      setPreview(r.text);
    } catch {
      setPreview(null);
    }
  }, [workspace.id]);

  // Only while open — this is the whole composed prompt, tens of kilobytes.
  useEffect(() => {
    if (previewOpen) void loadPreview();
  }, [previewOpen, loadPreview]);

  const patch = async (p: { instructions?: string; slack?: boolean }) => {
    setErr(null);
    setSaved('saving');
    try {
      await api.patchWorkspace(workspace.id, p);
      await refreshWorkspaces();
      setSaved('saved');
      if (previewOpen) void loadPreview();
    } catch (e) {
      setSaved('clean');
      setErr(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  // SAVE ON BLUR, not on every keystroke. These are paragraphs being written,
  // and a PATCH per character would rewrite the row under the agent runner's
  // cache mid-sentence.
  const commitText = () => {
    if (text === (workspace.instructions ?? '')) return;
    void patch({ instructions: text }).catch(() => {});
  };

  const toggleSlack = () => {
    const next = !slack;
    setSlack(next);
    // Optimistic, then put back if the server refuses — which is exactly what
    // it does to a non-browser caller, and the message is worth reading.
    void patch({ slack: next }).catch(() => setSlack(!next));
  };

  return (
    <div
      className="ws-settings"
      role="dialog"
      aria-modal="true"
      aria-label={`${workspace.name} settings`}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is bound on the document above. */}
      <div className="ws-settings__scrim" onClick={onClose} />
      <div className="ws-settings__panel">
        <div className="ws-settings__bar">
          <span className="ws-settings__swatch" aria-hidden="true" />
          <span className="ws-settings__title">
            {workspace.name}
            <small>workspace settings</small>
          </span>
          <span className="ws-settings__state" data-state={saved}>
            {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : ''}
          </span>
          <button type="button" className="ws-settings__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="ws-settings__body">
          <section className="ws-settings__row">
            <div className="ws-settings__rh">
              <h3>Instructions for agents here</h3>
              <span className="ws-settings__hint">
                {workspace.tab_count} {workspace.tab_count === 1 ? 'chat' : 'chats'}
              </span>
            </div>
            <p className="ws-settings__desc">
              Added after muxpad's own instructions, for every agent in this workspace, on every
              backend. The per-workspace half of <code>~/.muxpad/agent-notes.md</code>. Picked up
              when a pane launches, so an already-running agent keeps what it started with.
            </p>
            <textarea
              spellCheck={false}
              value={text}
              placeholder="Where things live, house conventions, what never to point at prod…"
              onChange={(e) => {
                setText(e.target.value);
                setSaved('clean');
              }}
              onBlur={commitText}
            />
          </section>

          <section className="ws-settings__row">
            <div className="ws-settings__rh">
              <h3>Capabilities</h3>
            </div>
            <p className="ws-settings__desc">
              Off everywhere until switched on here. A capability that is off is not merely refused
              — <b>it is not mentioned in the instructions at all</b>, so an agent is never told
              about something it cannot use.
            </p>
            <button
              type="button"
              className="ws-settings__toggle"
              data-on={slack ? 'true' : undefined}
              onClick={toggleSlack}
              aria-pressed={slack}
            >
              <span className="ws-settings__track" aria-hidden="true" />
              <span className="ws-settings__tlabel">Slack — read, search and post</span>
            </button>
            <p className="ws-settings__locked">
              Changeable <b>here only</b>. The CLI cannot throw this switch, because the CLI is what
              agents drive — and an agent that can grant itself Slack makes the guard decoration.
            </p>
          </section>

          <section className="ws-settings__row">
            <button
              type="button"
              className="ws-settings__pvh"
              onClick={() => setPreviewOpen((v) => !v)}
              aria-expanded={previewOpen}
            >
              <span className="ws-settings__car" data-open={previewOpen ? 'true' : undefined}>
                ▸
              </span>
              what an agent launched here is handed
            </button>
            {previewOpen && <pre className="ws-settings__pv">{preview ?? 'loading…'}</pre>}
          </section>

          {err && <p className="ws-settings__err">{err}</p>}
        </div>
      </div>
    </div>
  );
}
