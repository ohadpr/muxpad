/**
 * The viewport width below which muxpad uses its mobile layout. Shared by the
 * JS readers (`isMobileLayout` here + `useMediaQuery(MOBILE_BREAKPOINT)` in
 * AppLayout/TabView) so they can't drift apart. The CSS `@media` blocks
 * (styles.css, TabBar.css, WorkspaceSwitcher.css) necessarily duplicate the
 * literal — keep them in sync by hand.
 */
export const MOBILE_BREAKPOINT = '(max-width: 720px)';

export function isMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_BREAKPOINT).matches;
}
