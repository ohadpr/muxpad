import { STATUS_ORDER, rollupStatus } from '@muxpad/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusMark } from './StatusMark';

/**
 * The rail's geometry IS the specification — an 18px box on a 2.2px stroke,
 * one family, four marks — so it is pinned here rather than left to be
 * eyeballed in a screenshot. Rendered to static markup: no DOM library, no
 * jsdom, and the assertions are about the SVG the browser will actually get.
 */
const html = (status: Parameters<typeof StatusMark>[0]['status']) =>
  renderToStaticMarkup(<StatusMark status={status} />);

describe('one family — 18px box, 2.2px stroke', () => {
  it('every drawn mark is an 18px box', () => {
    for (const s of ['blocked', 'working', 'ready', 'dead'] as const) {
      expect(html(s)).toContain('width="18"');
      expect(html(s)).toContain('viewBox="0 0 18 18"');
    }
  });

  it('every STROKED mark is 2.2px with round caps', () => {
    for (const s of ['working', 'dead'] as const) {
      expect(html(s)).toContain('stroke-width="2.2"');
      expect(html(s)).toContain('stroke-linecap="round"');
    }
  });

  it('blocked and ready are both SOLID DISCS at r=5.5', () => {
    // Filled-vs-ring is the primary distinction — it survives red/green
    // colour-blindness, which colour alone does not.
    for (const s of ['blocked', 'ready'] as const) {
      expect(html(s)).toContain('r="5.5"');
      expect(html(s)).toContain('fill="currentColor"');
    }
  });

  it('working is a RING at r=6.5 with a 90° arc over a faint track', () => {
    const h = html('working');
    expect(h).toContain('r="6.5"');
    expect(h).toContain('navtree-status-track');
    expect(h).toContain('navtree-status-arc');
    expect(h).toContain('a6.5 6.5 0 0 1 6.5 6.5');
  });

  it('dead is the only mark that BREAKS the circle', () => {
    const h = html('dead');
    expect(h).toContain('M4.5 4.5 L13.5 13.5 M13.5 4.5 L4.5 13.5');
    expect(h).not.toContain('<circle');
  });
});

describe('motion is what separates red from green', () => {
  it('ONLY blocked carries the breath', () => {
    expect(html('blocked')).toContain('navtree-status-breath');
    for (const s of ['ready', 'dead', 'idle'] as const) {
      expect(html(s)).not.toContain('navtree-status-breath');
    }
  });

  it('ready is perfectly still — no animated class at all', () => {
    const h = html('ready');
    expect(h).not.toContain('breath');
    expect(h).not.toContain('arc');
  });
});

describe('the column is always reserved', () => {
  it('idle draws nothing but still renders its box', () => {
    const h = html('idle');
    expect(h).toContain('navtree-status');
    expect(h).toContain('data-status="idle"');
    expect(h).not.toContain('<svg');
  });

  it('an UNDEFINED status is idle, not a crash and not a gap', () => {
    expect(html(undefined)).toContain('data-status="idle"');
  });

  it('every state carries the same wrapper, so no row can shift', () => {
    for (const s of ['blocked', 'working', 'ready', 'dead', 'idle'] as const) {
      expect(html(s)).toMatch(/^<span class="navtree-status"/);
    }
  });
});

describe('accessibility', () => {
  it('the consequential states are announced', () => {
    expect(html('blocked')).toContain('aria-label="Waiting on you"');
    expect(html('ready')).toContain('aria-label="Ready for you"');
    expect(html('dead')).toContain('aria-label="Agent exited"');
  });

  it('working is hidden — it toggles too fast to announce', () => {
    // Announcing it would churn the enclosing link's accessible name at
    // whatever rate the agent starts and stops.
    expect(html('working')).toContain('aria-hidden="true"');
    expect(html('working')).not.toContain('aria-label');
  });

  it('idle is silent AND unlabelled', () => {
    expect(html('idle')).toContain('aria-hidden="true"');
  });
});

describe('precedence, after the done → ready rename', () => {
  it('is blocked > working > dead > ready > idle', () => {
    expect([...STATUS_ORDER]).toEqual(['blocked', 'working', 'dead', 'ready', 'idle']);
  });

  it('dead still outranks ready — a crash must not be masked by a finish', () => {
    expect(rollupStatus(['ready', 'dead'])).toBe('dead');
  });

  it('blocked wins over everything', () => {
    expect(rollupStatus(['idle', 'ready', 'dead', 'working', 'blocked'])).toBe('blocked');
  });

  it('the renamed state has a mark, and the old name does not', () => {
    expect(html('ready')).toContain('data-status="ready"');
    // A stale cached client sending the old value clamps to a blank reserved
    // column rather than throwing — the documented cross-version behaviour.
    expect(html('done' as never)).not.toContain('<svg');
  });
});
