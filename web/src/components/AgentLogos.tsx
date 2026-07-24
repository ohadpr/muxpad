// Small brand marks for the agent-backend picker. Deliberately simple,
// recognizable approximations (label always accompanies them): Claude's spark,
// OpenAI's blossom for Codex, a pointer for Cursor. Sized to sit inline in a
// chooser button.
import type { AgentBackendId } from '../lib/agent-backend';

/** Anthropic-style radial spark (the ✳ muxpad already uses for agent panes). */
export function ClaudeLogo({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        stroke="#D97757"
        strokeWidth="1.7"
        strokeLinecap="round"
        d="M12 3v7M12 14v7M3 12h7M14 12h7M5.8 5.8l4 4M14.2 14.2l4 4M18.2 5.8l-4 4M9.8 14.2l-4 4"
      />
    </svg>
  );
}

/** OpenAI-style blossom (three rotated petals → a six-fold flower) for Codex. */
export function CodexLogo({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <g stroke="#10A37F" strokeWidth="1.5">
        <ellipse cx="12" cy="12" rx="3.4" ry="8" />
        <ellipse cx="12" cy="12" rx="3.4" ry="8" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="3.4" ry="8" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

/** A classic pointer, for Cursor. */
export function CursorLogo({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 2.5l14 8.2-6.3 1.2 3.6 6.7-2.6 1.4-3.6-6.8L5 19.6z"
      />
    </svg>
  );
}

export function AgentBackendLogo({ backend, size = 15 }: { backend: AgentBackendId; size?: number }) {
  if (backend === 'codex') return <CodexLogo size={size} />;
  if (backend === 'cursor') return <CursorLogo size={size} />;
  return <ClaudeLogo size={size} />;
}
