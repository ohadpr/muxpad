// THE HALF-STARTED SESSION — a paid call nobody is on, and nobody knows about.
//
// `useVoice.start()` does two things that cost money, in this order:
//
//   1. POST /api/voice/session — the server calls OpenAI, a session EXISTS, and
//      the meter is running. `remoteId` is set from the answer.
//   2. Everything after: `setRemoteDescription` with OpenAI's answer, building
//      the `VoiceSession`, starting it.
//
// Step 2 can throw. A browser that refuses the answer SDP (an m-line it won't
// take, a codec it can't do, a mangled body) rejects `setRemoteDescription`,
// and that rejection lands in the one `catch` at the bottom of `start()`.
//
// That catch used to stop the microphone tracks and render an error — and
// nothing else. It did NOT hang up. So:
//
//   · the server session stayed live for its whole TTL (ten minutes, billed),
//   · the RTCPeerConnection stayed open, still talking to OpenAI,
//   · and because the manager allows ONE live session per install, every retry
//     the user made for the next ten minutes came back 409 "a voice session is
//     already live" — pointing at a session that had never worked.
//
// No server log, no upstream error, nothing in the console: the only symptom is
// a mic button that refuses for ten minutes and a bill for a call that never
// connected. Exactly the shape of failure this feature keeps shipping.
//
// These tests drive the REAL hook through a real React root, with a fake peer
// connection and a recording `fetch`, and assert the two things that make a
// failed start free: the DELETE goes out, and the peer connection is closed.

import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentLink } from './session';
import { type UseVoiceResult, useVoice } from './use-voice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── the fakes ───────────────────────────────────────────────────────────────

interface FakeChannel {
  readyState: string;
  close(): void;
  send(data: string): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
}

/** Enough RTCPeerConnection to get through `createRtcTransport`. */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  /** Make `setRemoteDescription` reject, the way a browser does when it can't
   *  use the answer it was handed. */
  static rejectRemote = false;

  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: { sdp: string } | null = { sdp: 'v=0\r\no=- local' };
  closed = false;
  channel: FakeChannel | null = null;
  ontrack: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }
  createDataChannel(): FakeChannel {
    this.channel = {
      readyState: 'connecting',
      close() {},
      send() {},
      onmessage: null,
      onopen: null,
      onclose: null,
    };
    return this.channel;
  }
  addTrack() {}
  addEventListener() {}
  removeEventListener() {}
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=- local' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    if (FakePeerConnection.rejectRemote) {
      throw new Error('Failed to set remote answer sdp: Called in wrong state');
    }
    // The model's audio arrives the moment the answer is applied. `ev.streams`
    // is deliberately EMPTY — that is what OpenAI actually sends, and what the
    // transport is built to survive.
    this.ontrack?.({ streams: [], track: { kind: 'audio' } });
  }
  close() {
    this.closed = true;
  }
}

interface Call {
  method: string;
  url: string;
}

const calls: Call[] = [];
const SESSION_ID = 'sess_leaky';

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ method, url });
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  if (url.startsWith('/api/voice/status')) {
    return json({ configured: true, live: false, minutesToday: 0, capMinutes: 60 });
  }
  if (url === '/api/voice/session' && method === 'POST') {
    return json({
      sessionId: SESSION_ID,
      sdp: 'v=0\r\no=- answer',
      expiresAt: Date.now() + 600_000,
      voice: 'marin',
    });
  }
  if (url.startsWith('/api/voice/session/') && method === 'DELETE') {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  return Promise.resolve(new Response('{}', { status: 200 }));
}

/** A microphone stream with a track we can watch get stopped. */
function fakeMicStream() {
  const track = {
    kind: 'audio',
    stopped: false,
    stop() {
      track.stopped = true;
    },
  };
  return {
    track,
    stream: {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream,
  };
}

const noopAgent: AgentLink = {
  send: () => true,
  stop: () => {},
  onFrame: () => () => {},
};

// ── harness ─────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: UseVoiceResult | null = null;

function Probe() {
  latest = useVoice({ paneId: 'pane-1', enabled: true, agent: noopAgent });
  return null;
}

/** Let every queued microtask and the `void (async () => …)` in `start()` run. */
async function settle() {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let mic: ReturnType<typeof fakeMicStream>;

beforeEach(() => {
  calls.length = 0;
  FakePeerConnection.instances = [];
  FakePeerConnection.rejectRemote = false;
  mic = fakeMicStream();

  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePeerConnection;
  (globalThis as { MediaStream?: unknown }).MediaStream = class {};
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => mic.stream },
  });
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  // jsdom's HTMLMediaElement throws "Not implemented" on play(); the element
  // behaviour itself is pinned in lifecycle.test.ts.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
});

async function mount() {
  await act(async () => {
    root?.render(<Probe />);
  });
  await settle();
}

const deletes = () =>
  calls.filter((c) => c.method === 'DELETE' && c.url.includes(`/api/voice/session/${SESSION_ID}`));

describe('useVoice: a start that fails AFTER the session was paid for', () => {
  it('hangs the server session up — otherwise it bills for its whole TTL', async () => {
    FakePeerConnection.rejectRemote = true;
    await mount();
    await act(async () => {
      latest?.start();
    });
    await settle();

    // The POST happened, so a session exists at OpenAI and the meter is on.
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/voice/session')).toBe(true);
    expect(latest?.state).toBe('error');
    // ...and the only thing that stops the meter must have gone out.
    expect(deletes().length).toBe(1);
  });

  it('closes the peer connection — the server is not in the media path', async () => {
    FakePeerConnection.rejectRemote = true;
    await mount();
    await act(async () => {
      latest?.start();
    });
    await settle();

    expect(FakePeerConnection.instances).toHaveLength(1);
    // A peer connection left open is a live WebRTC session to OpenAI that
    // muxpad's DELETE is only ASKING to stop. Close our end too.
    expect(FakePeerConnection.instances[0]?.closed).toBe(true);
    expect(mic.track.stopped).toBe(true);
  });

  it('lets the user try again — a leaked session 409s every retry', async () => {
    FakePeerConnection.rejectRemote = true;
    await mount();
    await act(async () => {
      latest?.start();
    });
    await settle();

    // Nothing is holding the slot: no session object, and the id released.
    FakePeerConnection.rejectRemote = false;
    await act(async () => {
      latest?.start();
    });
    await settle();
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/voice/session');
    expect(posts).toHaveLength(2);
    expect(latest?.state).not.toBe('error');
  });
});

// ═══ THE ELEMENT THE NEXT SESSION HAS TO USE ═══
//
// `voiceAudioElement()` is a SINGLETON on purpose: iOS blesses an ELEMENT, not
// a page, so a fresh element per session means the second session is silent.
// The consequence nobody handled is that everything left on it also survives —
// and what a session leaves on it is `srcObject`, a MediaStream whose peer
// connection we just closed and whose tracks are all ended.
//
// Two things go wrong with a dead stream still attached, both silent:
//
//   · `isSilentlyBlocked(el)` keys off `srcObject`, so it stays true after the
//     session is over. The 2.5s sound check fires into a stopped session and
//     raises "tap to hear sound" on a call that no longer exists.
//   · `unlockPlayback` branches on `srcObject`. With one attached it takes the
//     `await el.play()` path on a stream with no live tracks instead of the
//     silent-WAV path that actually obtains the blessing — which is the exact
//     shape of the pending-forever play() that made voice silent in the first
//     place (see lifecycle.ts).
//
// Teardown owns the element it borrowed.
describe('useVoice: what a finished session leaves behind', () => {
  it('detaches the dead stream from the shared audio element', async () => {
    await mount();
    await act(async () => {
      latest?.start();
    });
    await settle();
    const el = document.querySelector('audio') as HTMLAudioElement;
    expect(el.srcObject).not.toBeNull(); // the track arrived

    await act(async () => {
      latest?.stop();
    });
    await settle();
    expect(el.srcObject).toBeNull();
  });

  it('does not raise "tap to hear" 2.5s after the session was stopped', async () => {
    await mount();
    await act(async () => {
      latest?.start();
    });
    await settle();
    await act(async () => {
      latest?.stop();
    });
    await settle();
    expect(latest?.muted).toBe(false);

    // The sound check was armed inside start() and nothing cancelled it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2600));
    });
    expect(latest?.state).toBe('off');
    expect(latest?.muted).toBe(false);
  });
});

describe('useVoice: a start that fails BEFORE anything was paid for', () => {
  it('does not DELETE a session that was never created', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const e = new Error('denied');
          e.name = 'NotAllowedError';
          throw e;
        },
      },
    });
    await mount();
    await act(async () => {
      latest?.start();
    });
    await settle();

    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(deletes()).toHaveLength(0);
    expect(latest?.state).toBe('error');
  });
});
