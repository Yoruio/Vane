/* Extracted from useChat so it can be tested without a browser, a server or a
 * model. The framing bug this replaced stopped the answer streaming entirely
 * and was invisible to every other kind of check. */
/**
 * Dispatches the complete NDJSON lines in `buffer` and returns the trailing
 * fragment to carry into the next read.
 *
 * The previous version split the whole buffer, dispatched every line, and
 * cleared the buffer only if none of them threw -- but a network chunk almost
 * always ends mid-line, so `JSON.parse` threw on that last fragment *after*
 * the earlier lines had been dispatched, and the buffer was never cleared.
 * Every subsequent read therefore re-dispatched every event seen so far: one
 * observed run streamed 558 events, which is ~155,000 dispatches, each a React
 * state update mapping over the message list and its blocks. The answer
 * streamed correctly on the wire and appeared in the UI all at once at the end.
 */
export const consumeNdjson = (
  buffer: string,
  onEvent: (data: any) => void,
): string => {
  const lines = buffer.split('\n');
  /* The last element is either an incomplete line or '' when the chunk ended
   * on a newline. Either way it is not ours to dispatch yet. */
  const remainder = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      onEvent(JSON.parse(line));
    } catch {
      /* A *complete* line that does not parse is a server-side problem, not a
       * framing one. Skip it rather than stalling the rest of the stream. */
      console.warn('Discarding unparseable stream line');
    }
  }

  return remainder;
};
