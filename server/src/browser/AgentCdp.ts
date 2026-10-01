import { WebSocket } from 'ws';

/** Permission is checked on EVERY command, including an already-open socket.
 * The generation fences checks that were in flight when takeover began. */
export class AgentCdpGate {
  private generation = 0;
  private active = new Set<Promise<unknown>>();
  constructor(private readonly allowed: () => Promise<boolean>) {}

  private admission: Promise<void> = Promise.resolve();
  async run<T>(send: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    let pending!: Promise<T>;
    const admitted = this.admission.then(async () => {
      if (!(await this.allowed()) || generation !== this.generation)
        throw new Error('a human has the wheel — wait, do not retry');
      pending = send();
      // A response can reject before the caller below gets its await turn.
      void pending.catch(() => {});
      this.active.add(pending);
    });
    this.admission = admitted.catch(() => {});
    await admitted;
    try {
      return await pending;
    } finally {
      this.active.delete(pending);
    }
  }

  async quiesce(): Promise<void> {
    this.generation++;
    await Promise.allSettled([...this.active]);
  }
}

/** One agent connection, with the original CDP ids/sessions preserved. */
export function bridgeAgentCdp(
  client: WebSocket,
  upstreamUrl: string,
  gate: AgentCdpGate,
  selected: (targetId: string | undefined) => void,
): void {
  const upstream = new WebSocket(upstreamUrl);
  const pending = new Map<
    number,
    {
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      resolve(): void;
      reject(error: Error): void;
    }
  >();
  const sessions = new Map<string, string>();
  let ready = false;
  let dead = false;
  const queue: string[] = [];
  const close = () => {
    if (dead) return;
    dead = true;
    for (const item of pending.values()) item.reject(new Error('agent CDP disconnected'));
    pending.clear();
    client.close();
    upstream.close();
  };
  const forward = async (raw: string) => {
    let message: {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      await gate.run(
        () =>
          new Promise<void>((resolve, reject) => {
            if (dead) {
              reject(new Error('agent CDP disconnected'));
              return;
            }
            pending.set(message.id, { ...message, resolve, reject });
            upstream.send(raw);
          }),
      );
    } catch (error) {
      if (client.readyState === WebSocket.OPEN)
        client.send(
          JSON.stringify({
            id: message.id,
            sessionId: message.sessionId,
            error: { code: -32000, message: String(error) },
          }),
        );
    }
  };
  client.on('message', (data) => {
    if (ready) void forward(String(data));
    else queue.push(String(data));
  });
  upstream.on('open', () => {
    ready = true;
    for (const raw of queue.splice(0)) void forward(raw);
  });
  upstream.on('message', (data) => {
    const raw = String(data);
    try {
      const message = JSON.parse(raw);
      // A popup can become the agent's page without another bringToFront.
      // Do not hand its opener to a person based on a stale selection.
      if (message.method === 'Target.targetCreated' && message.params?.targetInfo?.type === 'page')
        selected(undefined);
      if (message.method === 'Target.attachedToTarget')
        sessions.set(message.params.sessionId, message.params.targetInfo.targetId);
      const request = pending.get(message.id);
      if (request) {
        if (!message.error) {
          if (request.method === 'Target.attachToTarget' && message.result?.sessionId)
            sessions.set(message.result.sessionId, String(request.params?.targetId));
          if (request.method === 'Target.activateTarget')
            selected(String(request.params?.targetId));
          if (request.method === 'Page.bringToFront' && request.sessionId) {
            const target = sessions.get(request.sessionId);
            if (target) selected(target);
          }
        }
        pending.delete(message.id);
        request.resolve();
      }
    } catch {
      /* Chrome owns the protocol; preserve its reply below. */
    }
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  });
  client.on('close', close);
  client.on('error', close);
  upstream.on('close', close);
  upstream.on('error', close);
}
