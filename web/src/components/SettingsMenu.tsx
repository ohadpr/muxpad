import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type PushState, disablePush, enablePush, getPushState, sendTestPush } from '../lib/push';
import { THEME_CHOICES, type ThemeChoice, updateSettings, useSettings } from '../settings';
import { SlackPasskeySettings } from './SlackPasskeySettings';
import './SettingsMenu.css';

export function SettingsMenu() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const [openedOnce, setOpenedOnce] = useState(false);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [section, setSection] = useState<'general' | 'integrations'>('general');
  useEffect(() => {
    if (!open) return;
    const el = dialog.current;
    el?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      el?.close();
      document.body.style.overflow = previousOverflow;
      trigger.current?.focus();
    };
  }, [open]);

  return (
    <div className="settings-wrap">
      <button
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        type="button"
        className="icon-btn"
        title="Settings"
        aria-label="Settings"
        onClick={() => {
          setOpenedOnce(true);
          setOpen((v) => !v);
        }}
      >
        <SvgGear />
      </button>
      {openedOnce &&
        createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: Native dialog provides Escape; this click only dismisses its backdrop.
          <dialog
            ref={dialog}
            className="settings-dialog"
            aria-labelledby="settings-title"
            onCancel={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                const bounds = event.currentTarget.getBoundingClientRect();
                if (
                  event.clientX < bounds.left ||
                  event.clientX > bounds.right ||
                  event.clientY < bounds.top ||
                  event.clientY > bounds.bottom
                )
                  setOpen(false);
              }
            }}
          >
            <header className="settings-chrome">
              <h2 id="settings-title">Settings</h2>
              {/* TWO LABELS, ONE CONTROL. On a pointer device the × is obvious
                  and Escape works. On a phone there is no Escape key, and the
                  dialog covers the screen to within 8px — so the backdrop tap
                  that dismisses it on desktop has no target worth aiming at,
                  and a muted 1.5rem glyph in the corner was the only way out.
                  Reported as "I can't close it". The word is the affordance;
                  the glyph stays for the pointer case. */}
              <button
                type="button"
                className="settings-close"
                aria-label="Close settings"
                onClick={() => setOpen(false)}
              >
                <span className="settings-close-word" aria-hidden="true">
                  Done
                </span>
                <span className="settings-close-x" aria-hidden="true">
                  ×
                </span>
              </button>
            </header>
            <div className="settings-layout">
              <aside className="settings-sidebar">
                <nav aria-label="Settings sections">
                  {(['general', 'integrations'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-current={section === item ? 'page' : undefined}
                      onClick={() => setSection(item)}
                    >
                      {item.charAt(0).toUpperCase() + item.slice(1)}
                    </button>
                  ))}
                </nav>
              </aside>
              <div className="settings-body">
                <header className="settings-heading">
                  <h2>{section.charAt(0).toUpperCase() + section.slice(1)}</h2>
                </header>
                <section hidden={section !== 'general'} aria-label="General settings">
                  <div className="settings-row">
                    <label htmlFor="theme">Theme</label>
                    <select
                      id="theme"
                      value={settings.theme}
                      onChange={(e) => updateSettings({ theme: e.target.value as ThemeChoice })}
                    >
                      {THEME_CHOICES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <PushRow />
                </section>
                <SlackPasskeySettings active={open} section={section} />
              </div>
            </div>
          </dialog>,
          document.body,
        )}
    </div>
  );
}

/**
 * Push-notification toggle. Web Push needs https + (on iOS) the installed
 * PWA; where those don't hold the row says why instead of offering a
 * button that can't work. Enable must run inside the click handler —
 * iOS auto-denies permission prompts that don't come from a gesture.
 */
function PushRow() {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPushState().then(setState);
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      setState(state === 'enabled' ? await disablePush() : await enablePush());
    } catch (err) {
      console.error('push toggle failed', err);
      setState(await getPushState());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-row">
      <label htmlFor="push-toggle">Notifications</label>
      {state === 'unsupported' ? (
        <span className="settings-note">needs https</span>
      ) : state === 'denied' ? (
        <span className="settings-note">denied in browser settings</span>
      ) : (
        <div className="settings-push-actions">
          <button
            id="push-toggle"
            type="button"
            disabled={busy || state === 'loading'}
            onClick={() => void toggle()}
          >
            {state === 'enabled' ? 'Disable' : 'Enable'}
          </button>
          {state === 'enabled' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendTestPush().catch((err) => console.error(err))}
            >
              Test
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SvgGear() {
  // Lucide-style gear — clean, geometric, eight teeth.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
