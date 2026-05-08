const enc = new TextEncoder();
const dec = new TextDecoder();

export type ClientMessage =
  | { kind: 'input'; data: string }
  | { kind: 'resize'; cols: number; rows: number };

/**
 * Why a PTY exited. The client uses this to decide whether to clean up the
 * pane (natural shell exit → user typed `exit` → remove from layout) or just
 * close the view (server initiated the kill → don't second-guess it).
 */
export type ExitCause = 'natural' | 'killed';

export type ServerMessage =
  | { kind: 'output'; data: string }
  | { kind: 'exit'; code: number; cause: ExitCause }
  | { kind: 'error'; message: string };

export const OP_INPUT = 0x01;
export const OP_RESIZE = 0x02;
export const OP_OUTPUT = 0x01;
export const OP_EXIT = 0x03;
export const OP_ERROR = 0x04;

export function encodeInput(data: string): Uint8Array {
  const body = enc.encode(data);
  const out = new Uint8Array(1 + body.length);
  out[0] = OP_INPUT;
  out.set(body, 1);
  return out;
}

export function encodeResize(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(5);
  const view = new DataView(out.buffer);
  out[0] = OP_RESIZE;
  view.setUint16(1, cols);
  view.setUint16(3, rows);
  return out;
}

export function encodeOutput(data: string): Uint8Array {
  const body = enc.encode(data);
  const out = new Uint8Array(1 + body.length);
  out[0] = OP_OUTPUT;
  out.set(body, 1);
  return out;
}

export function encodeExit(code: number, cause: ExitCause = 'natural'): Uint8Array {
  // Layout: [op:1][cause:1][code:4]
  const out = new Uint8Array(6);
  const view = new DataView(out.buffer);
  out[0] = OP_EXIT;
  out[1] = cause === 'killed' ? 1 : 0;
  view.setInt32(2, code);
  return out;
}

export function encodeError(message: string): Uint8Array {
  const body = enc.encode(message);
  const out = new Uint8Array(1 + body.length);
  out[0] = OP_ERROR;
  out.set(body, 1);
  return out;
}

export function decodeClientMessage(buf: Uint8Array): ClientMessage {
  const op = buf[0];
  if (op === OP_INPUT) return { kind: 'input', data: dec.decode(buf.subarray(1)) };
  if (op === OP_RESIZE) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { kind: 'resize', cols: view.getUint16(1), rows: view.getUint16(3) };
  }
  throw new Error(`unknown client opcode: ${op}`);
}

export function decodeServerMessage(buf: Uint8Array): ServerMessage {
  const op = buf[0];
  if (op === OP_OUTPUT) return { kind: 'output', data: dec.decode(buf.subarray(1)) };
  if (op === OP_EXIT) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const cause: ExitCause = buf[1] === 1 ? 'killed' : 'natural';
    return { kind: 'exit', code: view.getInt32(2), cause };
  }
  if (op === OP_ERROR) return { kind: 'error', message: dec.decode(buf.subarray(1)) };
  throw new Error(`unknown server opcode: ${op}`);
}
