import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type PushState, disablePush, enablePush, getPushState, sendTestPush } from '../lib/push';
import {
  SYSTEM_PAIR,
  THEME_CHOICES,
  type ThemeChoice,
  updateSettings,
  useSettings,
} from '../settings';
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
              {/* NO SECTION HEADING. It printed the selected nav item back at
                  you — "General" in the list, "General" again as an h2 three
                  centimetres to its right — which is a title for a page that
                  already has one. The nav IS the heading. */}
              <div className="settings-body">
                <section hidden={section !== 'general'} aria-label="General settings">
                  <ThemePicker chosen={settings.theme} />

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
 * THE PICKER HAS TO SHOW THE THEME, NOT NAME IT.
 *
 * It was a <select>. "System (Dracula / Alucard)" in a dropdown tells you
 * nothing about what any of them look like, and since demoscene a theme may
 * own the TYPEFACE and draw its own structure — so the thing the list was
 * hiding had grown to be most of what a theme is.
 *
 * Each tile paints itself with the real tokens. `[data-theme="x"]` is an
 * attribute selector, not a :root rule, so setting the attribute on a 96px
 * div inside the dialog gives that div the whole palette AND --ui-font. The
 * preview therefore cannot drift from the theme: there is no second copy of
 * the colours here, and a theme added later gets a correct tile for free.
 *
 * Real radio inputs rather than buttons with aria-checked: a radiogroup is one
 * tab stop with arrow keys inside it, which is the behaviour a grid of
 * mutually exclusive choices should have and the behaviour nobody writes
 * correctly by hand.
 */
export function ThemePicker({ chosen, group = 'theme' }: { chosen: ThemeChoice; group?: string }) {
  return (
    <fieldset className="settings-row settings-themes">
      <legend>Theme</legend>
      <div className="theme-grid">
        {THEME_CHOICES.map((t) => (
          <label key={t.value} className="theme-tile" data-chosen={t.value === chosen}>
            <input
              type="radio"
              name={group}
              value={t.value}
              checked={t.value === chosen}
              onChange={() => updateSettings({ theme: t.value })}
            />
            {/* System is the only choice that is two themes, so its tile is
                two previews cut on the diagonal — the light one over the dark
                one, which is the thing the label was trying to say in words. */}
            {t.value === 'system' ? (
              <span className="theme-tile-preview theme-tile-split">
                <ThemeMock theme={SYSTEM_PAIR.dark} />
                <ThemeMock theme={SYSTEM_PAIR.light} />
              </span>
            ) : (
              <span className="theme-tile-preview">
                <ThemeMock theme={t.value} />
              </span>
            )}
            <span className="theme-tile-name">{t.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A muxpad in miniature: the rail, a head, and three lines of a chat. */
function ThemeMock({ theme }: { theme: string }) {
  return (
    <span className="theme-mock" data-theme={theme} aria-hidden="true">
      <span className="theme-mock-rail">
        <i className="theme-mock-dot" />
        <i className="theme-mock-row" />
        <i className="theme-mock-row theme-mock-row--on" />
      </span>
      <span className="theme-mock-page">
        {/* "Aa" in the theme's own --ui-font: on half of these the typeface
            is the headline and the palette is the footnote. */}
        <b className="theme-mock-aa">Aa</b>
        <i className="theme-mock-line" />
        <i className="theme-mock-line theme-mock-line--short" />
      </span>
    </span>
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
