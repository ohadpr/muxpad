import { useEffect, useRef, useState } from 'react';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import {
  FONT_FAMILIES,
  FONT_FAMILY_LABELS,
  THEMES,
  type Theme,
  updateSettings,
  useSettings,
} from '../settings';
import { useMediaQuery } from '../use-media-query';
import './SettingsMenu.css';

export function SettingsMenu() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // navLayout only matters on desktop — mobile always uses the bottom
  // sheet — so hide the row there instead of showing a dead control.
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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

          <div className="settings-row">
            <label htmlFor="font-family">Font</label>
            <select
              id="font-family"
              value={settings.fontFamily}
              onChange={(e) => updateSettings({ fontFamily: e.target.value })}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f} value={f}>
                  {FONT_FAMILY_LABELS[f] ?? f}
                </option>
              ))}
            </select>
          </div>

          {!isMobile && (
            <div className="settings-row">
              <span className="settings-label">Navigation</span>
              <div className="settings-segmented">
                <button
                  type="button"
                  data-active={settings.navLayout === 'top' ? 'true' : undefined}
                  onClick={() => updateSettings({ navLayout: 'top' })}
                >
                  Top bar
                </button>
                <button
                  type="button"
                  data-active={settings.navLayout === 'sidebar' ? 'true' : undefined}
                  onClick={() => updateSettings({ navLayout: 'sidebar' })}
                >
                  Sidebar
                </button>
              </div>
            </div>
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
