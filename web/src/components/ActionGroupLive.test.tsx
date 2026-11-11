import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEvent } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionGroup, ChatLiveContext } from './ChatTranscript';

/**
 * ONE ROW FOR A RUNNING TURN, NOT TWO.
 *
 * The log ended in a fold of the turn's own actions — `27 actions · Bash ×26`
 * — and then a SECOND row underneath it said `Running Bash…`. Two lines of
 * chrome for one turn, the lower one restating the tool the upper one had
 * just counted. Reported as "the 'running bash' and collapsed bash commands
 * still take up two lines of text".
 *
 * The live line rides the trailing fold's own head now. Everything here is
 * about the two rules that keeps honest: only the LAST fold may wear it, and
 * it must never make the header grow.
 */
let n = 0;
const tool = (): ChatEvent => ({
  kind: 'tool_use',
  id: `e${++n}`,
  ts: 0,
  toolUseId: `t${n}`,
  name: 'Bash',
  input: {},
});

function render(opts: { tail?: boolean; live?: React.ReactNode }): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <ChatLiveContext.Provider value={opts.live ?? null}>
        <ActionGroup
          events={[tool(), tool()]}
          expanded={false}
          tail={opts.tail}
          onToggle={() => {}}
          renderEvent={() => null}
        />
      </ChatLiveContext.Provider>,
    );
  });
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the trailing fold carries the running turn', () => {
  it('shows the live line on the last fold', () => {
    const host = render({ tail: true, live: <span className="chat-working-say">reading CI</span> });
    const live = host.querySelector('.chat-action-group-live');
    expect(live?.textContent).toBe('reading CI');
  });

  it('is on the HEAD, so it shares the row with the count', () => {
    // Inside the header button or it is a second line again — which is the
    // entire defect.
    const host = render({ tail: true, live: <span>reading CI</span> });
    const head = host.querySelector('.chat-action-group-head');
    expect(head?.querySelector('.chat-action-group-live')).not.toBeNull();
  });

  it('leaves every EARLIER fold alone', () => {
    // A finished run is a record. Painting a spinner on one would say the
    // turn from twenty minutes ago is still going.
    const host = render({ tail: false, live: <span>reading CI</span> });
    expect(host.querySelector('.chat-action-group-live')).toBeNull();
  });

  it('goes quiet the moment the turn ends', () => {
    // Null context is what ChatPane provides when nothing is running — the
    // fold must not keep a stale spinner after the reply lands.
    const host = render({ tail: true, live: null });
    expect(host.querySelector('.chat-action-group-live')).toBeNull();
  });
});

describe('the second row is gone', () => {
  const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
  const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

  it('ChatPane stops drawing its own working row once a fold has it', () => {
    // The guard, not the markup: `tailFolded` is the whole decision.
    expect(SRC).toMatch(/\) : tailFolded \? null : \(/);
  });

  it('clamps the live line instead of letting it wrap the header', () => {
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = stripped.indexOf('.chat-action-group-live {');
    expect(at, '.chat-action-group-live has no rule — the fold would grow').toBeGreaterThan(-1);
    const body = stripped.slice(at, stripped.indexOf('}', at));
    // Without `min-width: 0` a flex child refuses to shrink below its content
    // and the ellipsis never arrives — the header wraps instead.
    expect(body).toContain('min-width: 0');
    expect(body).toContain('overflow: hidden');
  });
});
