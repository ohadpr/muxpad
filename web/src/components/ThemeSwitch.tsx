import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../settings';
import { ThemePicker } from './SettingsMenu';
import './SettingsMenu.css';

/**
 * THE THEME PICKER, WITHOUT THE TRIP THROUGH SETTINGS.
 *
 * Settings is where a preference you set once lives. A theme is not that: it
 * is tried, compared, abandoned and tried again — eleven of them now — and
 * every one of those comparisons was costing a modal, a section and a close.
 *
 * So the same picker, in a popover on the rail's foot beside the gear. It
 * mounts the very same `<ThemePicker>` the dialog does rather than a second
 * copy of the tiles, which is the whole reason the tiles paint themselves from
 * `data-theme` in the first place: one component, two places, no drift.
 */
export function ThemeSwitch() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // `click`, not `mousedown`: a radio inside the popover must get its own
    // event before the dismissal runs, or picking a theme closes the thing you
    // were comparing in and never registers the pick.
    document.addEventListener('click', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="themeswitch" ref={wrap}>
      <button
        type="button"
        className="icon-btn"
        title="Theme"
        aria-label="Theme"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SvgSwatch />
      </button>
      {/* A GROUP, not a dialog. It traps nothing, it is dismissed by a click
          anywhere, and the picker inside is already a labelled radiogroup —
          `role="dialog"` would promise a modal that does not exist. */}
      {open && (
        <div className="themeswitch-pop" aria-label="Theme">
          {/* Its own radio GROUP. Two pickers sharing `name="theme"` are one
              group to the browser, so the dialog's checked radio and this
              one's fight over a single selection and arrow-keys walk between
              surfaces. */}
          <ThemePicker chosen={settings.theme} group="theme-rail" />
        </div>
      )}
    </div>
  );
}

/** Three overlapping chips — the one icon that means "palette" without
 *  needing a legend, and it reads at 16px, which a paint-palette outline does
 *  not. */
function SvgSwatch() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6" cy="6" r="4" fill="currentColor" opacity="0.45" />
      <circle cx="10" cy="6" r="4" fill="currentColor" opacity="0.7" />
      <circle cx="8" cy="10" r="4" fill="currentColor" />
    </svg>
  );
}
