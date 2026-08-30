import { describe, expect, it } from 'vitest';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeError,
  encodeExit,
  encodeInput,
  encodeOutput,
  encodePing,
  encodePong,
  encodeResize,
} from './ws-protocol';

describe('ws-protocol', () => {
  it('round-trips input', () => {
    const buf = encodeInput('hello');
    expect(decodeClientMessage(buf)).toEqual({ kind: 'input', data: 'hello' });
  });

  it('round-trips utf-8 input', () => {
    const buf = encodeInput('héllo 🌟');
    expect(decodeClientMessage(buf)).toEqual({ kind: 'input', data: 'héllo 🌟' });
  });

  it('round-trips resize', () => {
    const buf = encodeResize(120, 40);
    expect(decodeClientMessage(buf)).toEqual({ kind: 'resize', cols: 120, rows: 40 });
  });

  it('round-trips output', () => {
    expect(decodeServerMessage(encodeOutput('world'))).toEqual({ kind: 'output', data: 'world' });
  });

  it('round-trips exit including cause and negative codes', () => {
    expect(decodeServerMessage(encodeExit(127))).toEqual({
      kind: 'exit',
      code: 127,
      cause: 'natural',
    });
    expect(decodeServerMessage(encodeExit(-1, 'killed'))).toEqual({
      kind: 'exit',
      code: -1,
      cause: 'killed',
    });
  });

  it('round-trips error', () => {
    expect(decodeServerMessage(encodeError('boom'))).toEqual({ kind: 'error', message: 'boom' });
  });

  it('rejects unknown client opcode', () => {
    const buf = new Uint8Array([0xff, 1, 2, 3]);
    expect(() => decodeClientMessage(buf)).toThrow();
  });

  it('rejects unknown server opcode', () => {
    const buf = new Uint8Array([0xff, 1, 2, 3]);
    expect(() => decodeServerMessage(buf)).toThrow();
  });
});

describe('ping/pong', () => {
  it('roundtrips a client ping', () => {
    const buf = encodePing();
    expect(decodeClientMessage(buf)).toEqual({ kind: 'ping' });
  });
  it('roundtrips a server pong', () => {
    const buf = encodePong();
    expect(decodeServerMessage(buf)).toEqual({ kind: 'pong' });
  });
});
