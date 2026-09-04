import { useEffect, useRef, useState } from 'react';
import { type PushState, disablePush, enablePush, getPushState, sendTestPush } from '../lib/push';
import { useDismissable } from '../lib/use-dismissable';
import {
  DARK_THEME_CHOICES,
  LIGHT_THEME_CHOICES,
  THEMES,
  type Theme,
  updateSettings,
  useSettings,
} from '../settings';
import './SettingsMenu.css';

export function SettingsMenu() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useDismissable(open, ref, () => setOpen(false));

  return (
    <div className="settings-wrap" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        title="Settings"
        aria-label="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        <SvgGear />
      </button>
      {open && (
        <div className="settings-popover">
          <div className="settings-row">
            <label htmlFor="theme-auto">Match system</label>
            <input
              id="theme-auto"
              type="checkbox"
              checked={settings.followSystem}
              onChange={(e) => updateSettings({ followSystem: e.target.checked })}
            />
          </div>

          {/* Two pickers rather than one, because "follow the system" cannot be
              a sixth theme id: with no 1:1 light/dark pairing across the five,
              any fixed mapping would be arbitrary — a Dracula user would be
              handed GitHub Light at sunrise. */}
          {settings.followSystem ? (
            <>
              <div className="settings-row">
                <label htmlFor="theme-light">When light</label>
                <select
                  id="theme-light"
                  value={settings.themeLight}
                  onChange={(e) => updateSettings({ themeLight: e.target.value as Theme })}
                >
                  {LIGHT_THEME_CHOICES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <label htmlFor="theme-dark">When dark</label>
                <select
                  id="theme-dark"
                  value={settings.themeDark}
                  onChange={(e) => updateSettings({ themeDark: e.target.value as Theme })}
                >
                  {DARK_THEME_CHOICES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div className="settings-row">
              <label htmlFor="theme">Theme</label>
              <select
                id="theme"
                value={settings.theme}
                onChange={(e) => updateSettings({ theme: e.target.value as Theme })}
              >
                {THEMES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="settings-row">
            <label htmlFor="font-size">Font size</label>
            <div className="settings-stepper">
              <button
                type="button"
                onClick={() => updateSettings({ fontSize: Math.max(8, settings.fontSize - 1) })}
              >
                −
              </button>
              <input
                id="font-size"
                type="number"
                min={8}
                max={32}
                value={settings.fontSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 8 && n <= 32) {
                    updateSettings({ fontSize: n });
                  }
                }}
              />
              <button
                type="button"
                onClick={() => updateSettings({ fontSize: Math.min(32, settings.fontSize + 1) })}
              >
                +
              </button>
            </div>
          </div>

          <PushRow />
        </div>
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
