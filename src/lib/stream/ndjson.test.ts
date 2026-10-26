import { describe, expect, it, vi } from 'vitest';
import { consumeNdjson } from './ndjson';

/* The bug this guards against: the previous reader split the whole buffer,
 * dispatched every line, and cleared the buffer only if nothing threw. A
 * network chunk almost always ends mid-line, so JSON.parse threw on the
 * trailing fragment *after* the earlier lines had been dispatched, and the
 * buffer was never cleared -- so every later read re-dispatched everything
 * seen so far. One answer streamed 558 events, i.e. ~155,000 dispatches. */
describe('consumeNdjson', () => {
  it('dispatches complete lines and returns the trailing fragment', () => {
    const seen: any[] = [];
    const rest = consumeNdjson('{"a":1}\n{"b":2}\n{"c":', (e) => seen.push(e));

    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('{"c":');
  });

  it('returns an empty remainder when the chunk ends on a newline', () => {
    const seen: any[] = [];
    const rest = consumeNdjson('{"a":1}\n', (e) => seen.push(e));

    expect(seen).toEqual([{ a: 1 }]);
    expect(rest).toBe('');
  });

  it('does not re-dispatch earlier events across successive chunks', () => {
    const seen: any[] = [];
    const onEvent = (e: any) => seen.push(e);

    /* Three reads, each ending mid-line -- the exact shape that broke. */
    let buffer = '';
    buffer = consumeNdjson((buffer += '{"n":1}\n{"n":2'), onEvent);
    buffer = consumeNdjson((buffer += '}\n{"n":3'), onEvent);
    buffer = consumeNdjson((buffer += '}\n'), onEvent);

    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(seen).toHaveLength(3);
  });

  it('skips one unparseable complete line and keeps going', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: any[] = [];

    consumeNdjson('{"a":1}\nnot json\n{"b":2}\n', (e) => seen.push(e));

    /* A malformed line is a server problem; it must not stall the stream. */
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    warn.mockRestore();
  });

  it('ignores blank lines', () => {
    const seen: any[] = [];
    consumeNdjson('\n\n{"a":1}\n\n', (e) => seen.push(e));

    expect(seen).toEqual([{ a: 1 }]);
  });

  it('dispatches a final line only once a newline is appended', () => {
    const seen: any[] = [];

    const rest = consumeNdjson('{"last":true}', (e) => seen.push(e));
    expect(seen).toEqual([]);
    expect(rest).toBe('{"last":true}');

    /* How the caller flushes at end of stream. */
    consumeNdjson(rest + '\n', (e) => seen.push(e));
    expect(seen).toEqual([{ last: true }]);
  });

  it('handles a realistic streamed answer without duplication', () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      type: 'chunk',
      data: `t${i}`,
    }));
    const wire = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

    const seen: any[] = [];
    let buffer = '';

    /* Chop the wire at arbitrary offsets, as a socket would. */
    for (let i = 0; i < wire.length; i += 37) {
      buffer += wire.slice(i, i + 37);
      buffer = consumeNdjson(buffer, (e) => seen.push(e));
    }

    expect(seen).toHaveLength(200);
    expect(seen[0]).toEqual({ type: 'chunk', data: 't0' });
    expect(seen[199]).toEqual({ type: 'chunk', data: 't199' });
  });
});
