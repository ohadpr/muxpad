import { Link } from '@tanstack/react-router';

interface BrandProps {
  /** Render as a link back to '/'. Default true. */
  asLink?: boolean;
  /** Hide the wordmark on narrow viewports (default true). */
  responsive?: boolean;
  /**
   * Show only the brand mark (logo) without the "muxpad" wordmark.
   * Used inside a workspace, where the workspace switcher takes the
   * wordmark's slot.
   */
  markOnly?: boolean;
}

export function Brand({ asLink = true, responsive = true, markOnly = false }: BrandProps) {
  const insecure = window.location.protocol !== 'https:';
  const securityLabel = insecure ? 'Muxpad — HTTP connection is not encrypted' : 'Muxpad';
  const inner = (
    <>
      <span className="brand-logo-wrap">
        <BrandMark />
        {insecure && (
          <span
            className="brand-insecure-dot"
            role="img"
            aria-label="HTTP connection is not encrypted"
          />
        )}
      </span>
      {!markOnly && (
        <span className={`brand-text${responsive ? ' brand-text-responsive' : ''}`}>muxpad</span>
      )}
    </>
  );
  const className = `brand${markOnly ? ' brand-mark-only' : ''}`;
  if (asLink) {
    return (
      <Link to="/" className={className} title={securityLabel}>
        {inner}
      </Link>
    );
  }
  return (
    <span className={`${className} brand-static`} title={securityLabel}>
      {inner}
    </span>
  );
}

/** The bare logo mark — exported for the sidebar's pinned "muxpad" row
 *  (NavTree), which doubles as the brand entry. */
export function BrandMark() {
  return (
    <svg className="brand-mark" width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="14" height="28" rx="3" fill="#334155" />
      <rect x="18" y="2" width="12" height="13" rx="3" fill="#f59e0b" />
      <rect x="18" y="17" width="12" height="13" rx="3" fill="#475569" />
    </svg>
  );
}
