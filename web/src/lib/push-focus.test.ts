import { beforeEach, describe, expect, it } from 'vitest';
import {
  PUSH_FOCUS_TTL_MS,
  consumePushFocusPane,
  resetPushFocusPane,
  setPushFocusPane,
} from './push-focus';

beforeEach(() => resetPushFocusPane());

describe('push focus slot', () => {
  it('hands the pane to the tab that owns it, exactly once', () => {
    setPushFocusPane('T1', 'P1', 1_000);
    expect(consumePushFocusPane('T2', 1_010)).toBeNull();
    expect(consumePushFocusPane('T1', 1_010)).toBe('P1');
    expect(consumePushFocusPane('T1', 1_010)).toBeNull();
  });

  it('expires an entry the target tab never came to collect', () => {
    // The slot is only ever read by the ONE tab it names, and that tab may
    // never render — deleted from another device, or living in a workspace the
    // navigator refuses to show. Without an expiry, opening it days later for
    // ordinary reasons silently jumps to a pane from a forgotten notification.
    setPushFocusPane('T1', 'P1', 1_000);
    expect(consumePushFocusPane('T1', 1_000 + PUSH_FOCUS_TTL_MS + 1)).toBeNull();
  });

  it('drops a stale entry even when a DIFFERENT tab asks', () => {
    // The expiry has to happen on any read, not only on a matching one:
    // the tab it names is exactly the tab that never asks.
    setPushFocusPane('T1', 'P1', 1_000);
    expect(consumePushFocusPane('T2', 1_000 + PUSH_FOCUS_TTL_MS + 1)).toBeNull();
    expect(consumePushFocusPane('T1', 1_000 + PUSH_FOCUS_TTL_MS + 2)).toBeNull();
  });

  it('honours an entry right up to the deadline', () => {
    setPushFocusPane('T1', 'P1', 1_000);
    expect(consumePushFocusPane('T1', 1_000 + PUSH_FOCUS_TTL_MS)).toBe('P1');
  });

  it('a newer tap replaces an uncollected older one', () => {
    setPushFocusPane('T1', 'P1', 1_000);
    setPushFocusPane('T2', 'P2', 2_000);
    expect(consumePushFocusPane('T1', 2_010)).toBeNull();
    expect(consumePushFocusPane('T2', 2_010)).toBe('P2');
  });
});
