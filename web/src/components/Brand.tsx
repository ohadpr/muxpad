import { Link } from '@tanstack/react-router';

interface BrandProps {
  /** Render as a link back to '/'. Default true. */
  asLink?: boolean;
  /** Hide the wordmark on narrow viewports (default true). */
  responsive?: boolean;
}

export function Brand({ asLink = true, responsive = true }: BrandProps) {
  const inner = (
    <>
      <BrandMark />
      <span className={`brand-text${responsive ? ' brand-text-responsive' : ''}`}>
        muxpad
      </span>
    </>
  );
  if (asLink) {
    return (
      <Link to="/" className="brand" title="Dashboard">
        {inner}
      </Link>
    );
  }
  return <span className="brand brand-static">{inner}</span>;
}

function BrandMark() {
  return (
    <svg
      className="brand-mark"
      width="18"
      height="18"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="14" height="28" rx="3" fill="#89b4fa" />
      <rect x="18" y="2" width="12" height="13" rx="3" fill="#a6e3a1" />
      <rect x="18" y="17" width="12" height="13" rx="3" fill="#f38ba8" />
    </svg>
  );
}
