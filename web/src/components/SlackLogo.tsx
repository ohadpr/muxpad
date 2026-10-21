/** Inert local brand vector. Never loads third-party content. */
export function SlackLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 128 128" role="img" aria-label="Slack">
      <g fill="#36c5f0">
        <circle cx="20" cy="52" r="12" />
        <rect x="40" y="8" width="24" height="56" rx="12" />
      </g>
      <g fill="#2eb67d">
        <circle cx="76" cy="20" r="12" />
        <rect x="72" y="40" width="56" height="24" rx="12" />
      </g>
      <g fill="#ecb22e">
        <circle cx="108" cy="76" r="12" />
        <rect x="64" y="72" width="24" height="56" rx="12" />
      </g>
      <g fill="#e01e5a">
        <circle cx="52" cy="108" r="12" />
        <rect x="8" y="64" width="56" height="24" rx="12" />
      </g>
    </svg>
  );
}
