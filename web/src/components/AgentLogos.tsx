// Small brand marks for the agent-backend picker / status bar. Claude's
// radial spark, OpenAI's blossom for Codex, and Cursor's official geometric
// mark (Simple Icons / cursor.com brand path — not a mouse pointer).
import type { AgentBackendId } from '../lib/agent-backend';

/** Anthropic-style radial spark — brand orange, not theme-ink. */
export function ClaudeLogo({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        stroke="#D97757"
        strokeWidth="1.9"
        strokeLinecap="round"
        d="M12 3v7M12 14v7M3 12h7M14 12h7M5.8 5.8l4 4M14.2 14.2l4 4M18.2 5.8l-4 4M9.8 14.2l-4 4"
      />
    </svg>
  );
}

/** OpenAI-style blossom — brand green for Codex. */
export function CodexLogo({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <g stroke="#10A37F" strokeWidth="1.7">
        <ellipse cx="12" cy="12" rx="3.4" ry="8" />
        <ellipse cx="12" cy="12" rx="3.4" ry="8" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="3.4" ry="8" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

/** Cursor brand mark — the cut geometric prism from cursor.com / Simple Icons.
 *  Uses currentColor so it reads on light and dark chrome. */
export function CursorLogo({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
      />
    </svg>
  );
}

export function AgentBackendLogo({
  backend,
  size = 15,
}: { backend: AgentBackendId; size?: number }) {
  if (backend === 'codex') return <CodexLogo size={size} />;
  if (backend === 'cursor') return <CursorLogo size={size} />;
  return <ClaudeLogo size={size} />;
}

/** Map a session.assistant wire value onto a known backend id. */
export function backendFromAssistant(a: string | null | undefined): AgentBackendId {
  if (a === 'codex' || a === 'cursor') return a;
  return 'claude';
}
