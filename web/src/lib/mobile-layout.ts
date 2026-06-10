/** Matches TabView / AppLayout mobile breakpoint. */
export function isMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
}
