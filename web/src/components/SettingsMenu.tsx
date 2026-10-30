import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useActiveTab } from '../lib/chat-theme';
import { type PushState, disablePush, enablePush, getPushState, sendTestPush } from '../lib/push';
import {
  SYSTEM_PAIR,
  THEME_CHOICES,
  type ThemeChoice,
  getChatTheme,
  setChatTheme,
  themeInForce,
  updateSettings,
  useSettings,
} from '../settings';
import { patchTabRow } from '../tabs';
import { SlackPasskeySettings } from './SlackPasskeySettings';
import './SettingsMenu.css';

export function SettingsMenu() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const [openedOnce, setOpenedOnce] = useState(false);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  // ── NOTIFICATIONS IS ITS OWN SECTION ──────────────────────────────────
  // It was the last row of General, directly under the theme grid, and that
  // is where it read as part of the grid: "move the notifications thing to
  // another tab/place, they feel like the action button for picking a theme."
  // A lone "Enable" button on the right of a row, six pixels under a row of
  // theme tiles, is a button a reader will reasonably attach to the thing
  // above it — the proximity says so louder than the label does.
  //
  // It is not a General setting anyway: General is what this app LOOKS like,
  // and this is a permission the browser grants to a device. Its own section
  // also gives the push state somewhere to explain itself (see PushSection),
  // which a one-line row never had room for.
  const [section, setSection] = useState<'general' | 'notifications' | 'integrations'>('general');
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
                  {(['general', 'notifications', 'integrations'] as const).map((item) => (
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
                  <ThemePicker chosen={themeInForce(settings)} />
                </section>
                <section hidden={section !== 'notifications'} aria-label="Notification settings">
                  <PushSection />
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
/**
 * THE GRID SETS THE CHAT YOU ARE IN, NOT THE DEVICE.
 *
 * A theme is two facts now: the device's default, and the chat's own (on the
 * tab row, so it follows you to every device — see lib/chat-theme). This
 * picker writes the CHAT's, because that is what you are looking at while you
 * use it; "Use for every chat" writes the default and clears the override, so
 * the way back is one press rather than a second control.
 *
 * With no chat open — the workspace picker — there is nothing to override, so
 * it writes the default directly and the button does not render.
 */
export function ThemePicker({ chosen, group = 'theme' }: { chosen: ThemeChoice; group?: string }) {
  const tab = useActiveTab();
  const [failed, setFailed] = useState(false);
  /**
   * Optimistic, and it UNDOES ITSELF when the write fails.
   *
   * The repaint has to happen on the press — a theme that waited for a round
   * trip feels like a toggle that sticks. But the first version swallowed the
   * error, so a server that could not store the value (one running from
   * before the migration that adds the column, which is every server until it
   * restarts) produced the worst possible shape: the window repainted, the
   * next poll delivered the unchanged row, and the theme snapped back with no
   * explanation. Reported as "tried to change the theme on a chat and it just
   * didn't work, flickered and returned to the theme it was on".
   *
   * Reverting here makes the failure immediate and legible instead of
   * arriving 5 seconds later as a flicker, and the line under the grid says
   * what to do about it.
   */
  const write = (value: ThemeChoice | null, chat: { id: string; workspaceId: string }) => {
    const before = getChatTheme();
    setFailed(false);
    setChatTheme(value);
    patchTabRow(chat.workspaceId, chat.id, { theme: value });
    void api.patchTab(chat.id, { theme: value }).catch((err) => {
      console.error('could not store the chat theme', err);
      setChatTheme(before);
      patchTabRow(chat.workspaceId, chat.id, { theme: before });
      setFailed(true);
    });
  };
  const pick = (value: ThemeChoice) => {
    if (!tab) {
      updateSettings({ theme: value });
      return;
    }
    write(value, tab);
  };
  const useEverywhere = () => {
    if (!tab) return;
    // `chosen` is the theme in force — the chat's own if it has one. That is
    // the whole point of the button: take what this chat is wearing and make
    // it the default, then clear the chat's override so it follows along.
    //
    // It used to be the DEVICE DEFAULT, because that is what the caller
    // passed, so pressing it saved the value that was already the default and
    // then cleared the pick you had just made — the button did the opposite
    // of its label, silently.
    updateSettings({ theme: chosen });
    write(null, tab);
  };
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
              onChange={() => pick(t.value)}
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
      {/* The way back. Without it a chat that has been given a theme can never
          be handed back to the default, and the default itself would be
          unreachable from the only grid in the app. */}
      {tab ? (
        <button type="button" className="settings-theme-default" onClick={useEverywhere}>
          Use for every chat
        </button>
      ) : null}
      {failed ? (
        <p className="settings-note" role="alert">
          Couldn’t save this chat’s theme — the server is running a build without the column it
          lives in. Restart muxpad and try again.
        </p>
      ) : null}
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
 * PUSH NOTIFICATIONS, as a section rather than a row.
 *
 * Web Push needs https and, on iOS, the installed PWA; where those do not
 * hold this says why instead of offering a button that cannot work. Enable
 * must run inside the click handler — iOS auto-denies a permission prompt
 * that does not come from a gesture.
 *
 * It was one row at the foot of General, under the theme grid, where its lone
 * Enable button read as an action on the tiles above it. With a section of
 * its own there is room to say what the thing actually does, which a row
 * never had: a reader deciding whether to grant a permission is the one
 * reader in this dialog who needs a sentence.
 */
function PushSection() {
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
    <>
      <h3 className="settings-heading">Notifications</h3>
      <p className="settings-blurb">
        A push on your phone and your desktop when a chat needs you — a question, a finished run, a
        watch you asked for. Nothing routine: a turn that ends while you are looking at it sends
        nothing.
      </p>
      {state === 'unsupported' ? (
        <p className="settings-note">
          Not available here — web push needs https, and on iOS it needs muxpad added to the home
          screen.
        </p>
      ) : state === 'denied' ? (
        <p className="settings-note">
          Blocked in your browser settings for this site. Allow notifications there and reopen this
          dialog.
        </p>
      ) : (
        <div className="settings-push-actions">
          <button
            id="push-toggle"
            type="button"
            disabled={busy || state === 'loading'}
            onClick={() => void toggle()}
          >
            {state === 'enabled' ? 'Disable notifications' : 'Enable notifications'}
          </button>
          {state === 'enabled' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendTestPush().catch((err) => console.error(err))}
            >
              Send a test
            </button>
          )}
        </div>
      )}
    </>
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
