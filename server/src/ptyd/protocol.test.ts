import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  encodeErrorResponse,
  encodeEvent,
  encodeRequest,
  encodeResponse,
} from './protocol.js';

describe('ptyd control protocol', () => {
  it('round-trips a request', () => {
    const wire = encodeRequest({ id: 1, method: 'killPane', params: { id: 'p1' } });
    const msg = decodeMessage(wire);
    expect(msg).toEqual({ kind: 'request', id: 1, method: 'killPane', params: { id: 'p1' } });
  });

  it('round-trips a successful response', () => {
    const wire = encodeResponse(1, { ok: true });
    const msg = decodeMessage(wire);
    expect(msg).toEqual({ kind: 'response', id: 1, ok: true, result: { ok: true } });
  });

  it('round-trips an error response', () => {
    const wire = encodeErrorResponse(1, 'pane not found');
    const msg = decodeMessage(wire);
    expect(msg).toEqual({ kind: 'response', id: 1, ok: false, error: 'pane not found' });
  });

  it('round-trips a pushed event', () => {
    const wire = encodeEvent({ event: 'paneExit', id: 'p1', code: 0, cause: 'natural' });
    const msg = decodeMessage(wire);
    expect(msg).toEqual({
      kind: 'event',
      event: 'paneExit',
      id: 'p1',
      code: 0,
      cause: 'natural',
    });
  });

  it('rejects malformed input', () => {
    expect(() => decodeMessage('not json')).toThrow();
    expect(() => decodeMessage(JSON.stringify({ nope: 1 }))).toThrow();
  });
});
