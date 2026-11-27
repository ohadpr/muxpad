import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { isEmbedded } from '../lib/embed';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import { rootLanding } from '../lib/mobile-nav';
import { useMediaQuery } from '../use-media-query';

/**
 * `/chats` where the list is not a destination — desktop, or an embed. On a
 * phone AppLayout renders the list itself and this never mounts. Anywhere else
 * the URL still has to go somewhere (a link copied off a phone, a window
 * widened past the breakpoint), and `/` is the place that knows where.
 */
export function ChatListFallback() {
  const navigate = useNavigate();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  useEffect(() => {
    if (rootLanding({ isMobile, embedded: isEmbedded() }) === 'chat-list') return;
    void navigate({ to: '/', replace: true });
  }, [isMobile, navigate]);
  return null;
}
