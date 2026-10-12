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
  const [token, setToken] = useState<{ set: boolean; hint: string | null } | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
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

  // Whether a credential exists is a property of the INSTALL, not of this
  // workspace — one Slack identity, N workspaces allowed to use it. Loaded
  // whenever the panel opens so the switch can say what turning it on will
  // actually get you.
  const loadToken = useCallback(async () => {
    try {
      setToken(await api.slackToken());
    } catch {
      setToken(null);
    }
  }, []);
  useEffect(() => {
    void loadToken();
  }, [loadToken]);

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
      // biome-ignore lint/a11y/useSemanticElements: <dialog> would trap focus and own the top layer; this panel is dismissed by Escape (bound on the document) or by its scrim, and must not steal focus from the field being typed into.
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
            <small>workspace</small>
          </span>
          <span className="ws-settings__state" data-state={saved}>
            {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : ''}
          </span>
          <button type="button" className="ws-settings__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* FOUR LINES OF TEXT IN THE WHOLE PANEL, and that is the spec.
            It had three sentences under the textarea explaining where the text
            goes and which file it is the other half of, a paragraph under
            Capabilities arguing its own design, and a note explaining why the
            CLI cannot throw the switch. "The contents of this dialog are some
            of the most confusing things i've ever read" — and the reason is
            not that any one sentence was wrong, it is that a settings panel
            was answering questions nobody standing in front of it is asking.

            What a person needs here: what this box does, what the switch does.
            Both fit on one line. Why the switch is UI-only belongs in the
            CLI's refusal, where somebody actually hits it, and what the
            instructions compose into belongs in the preview, which shows the
            real text instead of describing it. */}
        <div className="ws-settings__body">
          <section className="ws-settings__row">
            <h3>Agent instructions</h3>
            <textarea
              spellCheck={false}
              value={text}
              placeholder="Where things live, house conventions, what never to touch…"
              onChange={(e) => {
                setText(e.target.value);
                setSaved('clean');
              }}
              onBlur={commitText}
            />
            <p className="ws-settings__desc">Every agent in this workspace starts with these.</p>
          </section>

          <section className="ws-settings__row">
            <h3>Tools</h3>
            <button
              type="button"
              className="ws-settings__toggle"
              data-on={slack ? 'true' : undefined}
              onClick={toggleSlack}
              aria-pressed={slack}
            >
              <span className="ws-settings__track" aria-hidden="true" />
              <span className="ws-settings__tlabel">
                Slack
                <small>read, search and post as you</small>
              </span>
            </button>

            {/* THE CREDENTIAL, and it is write-only.
                It used to be a line in ~/.claude/secrets/slack.env that the
                CLI sourced into whichever pane asked — so a refused chat could
                read it and go round muxpad entirely. The server holds it now;
                this field is the only way in and there is no way back out. The
                tail is shown because somebody rotating a token needs to tell
                two apart, and that is all it is for. */}
            {slack && (
              <div className="ws-settings__cred">
                {token?.set ? (
                  <>
                    <code>{token.hint}</code>
                    <span className="ws-settings__credok">stored on the server</span>
                    <button
                      type="button"
                      onClick={() => {
                        void api
                          .clearSlackToken()
                          .then(loadToken)
                          .catch((e) => setErr(String(e)));
                      }}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      type="password"
                      spellCheck={false}
                      placeholder="xoxp-… user token"
                      value={tokenDraft}
                      onChange={(e) => setTokenDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!tokenDraft.trim()}
                      onClick={() => {
                        setErr(null);
                        void api
                          .setSlackToken(tokenDraft.trim())
                          .then(() => {
                            setTokenDraft('');
                            return loadToken();
                          })
                          .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
                      }}
                    >
                      Save
                    </button>
                  </>
                )}
              </div>
            )}
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
              Preview what agents are told
            </button>
            {previewOpen && <pre className="ws-settings__pv">{preview ?? 'loading…'}</pre>}
          </section>

          {err && <p className="ws-settings__err">{err}</p>}
        </div>
      </div>
    </div>
  );
}
