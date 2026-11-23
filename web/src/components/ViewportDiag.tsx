/**
 * A TEMPORARY READOUT, for a bug that only exists where we cannot look.
 *
 * The installed iOS app shows its status-bar strip in the PAGE's background
 * and its bottom bar off the end of the screen. Headless reports a 0 safe-area
 * inset and jsdom does no layout, so every number that would explain it is
 * unavailable to us and available to him. Rendered only behind `?diag=1`, so
 * it costs nothing to anybody who does not ask for it.
 *
 * Delete this file once the numbers have been read.
 */
export function ViewportDiag() {
  if (typeof window === 'undefined') return null;
  if (!new URLSearchParams(window.location.search).has('diag')) return null;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insetTop = cs.paddingTop;
  const insetBottom = cs.paddingBottom;
  probe.remove();
  const layout = document.querySelector('.app-layout');
  const lb = layout?.getBoundingClientRect();
  const rows: Array<[string, string]> = [
    ['innerHeight', String(window.innerHeight)],
    ['screen.height', String(window.screen.height)],
    ['inset top/bottom', `${insetTop} / ${insetBottom}`],
    ['layout h', lb ? String(Math.round(lb.height)) : '—'],
    ['layout top/bottom', lb ? `${Math.round(lb.top)} / ${Math.round(lb.bottom)}` : '—'],
    ['box-sizing', layout ? getComputedStyle(layout).boxSizing : '—'],
    [
      'display-mode',
      window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
    ],
    [
      'theme-color',
      document.querySelector<HTMLMetaElement>('meta[name=theme-color]')?.content ?? '—',
    ],
  ];
  return (
    <div
      style={{
        position: 'fixed',
        inset: 'auto 0 0 0',
        zIndex: 9999,
        background: '#000',
        color: '#0f0',
        font: '11px ui-monospace, monospace',
        padding: '6px 8px',
        lineHeight: 1.35,
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k}>
          {k}: {v}
        </div>
      ))}
    </div>
  );
}
