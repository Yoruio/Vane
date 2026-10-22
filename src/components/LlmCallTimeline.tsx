'use client';

import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface Call {
  id: number;
  kind: string | null;
  label: string | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  method: string;
  startedAt: string;
  durationMs: number | null;
  firstChunkMs: number | null;
  inputChars: number | null;
  inputTokens: number | null;
  outputChars: number | null;
  error: string | null;
  hasText: number;
}

interface CallDetail extends Omit<Call, 'hasText'> {
  messageId: string | null;
  chatId: string | null;
  inputText: string | null;
  outputText: string | null;
}

/* One colour per method so the shape of a run is readable at a glance: a
 * research run is a wall of generateObject with a single streamText at the end. */
/* The SDK method names are the mechanism, not the job: streamText is both the
 * orchestrator and the writer, and generateObject is both the classifier and
 * the chunk extractor. These label the call shape, which is all the stored row
 * can tell us. */
const methodLabel: Record<string, string> = {
  generateText: 'Text',
  streamText: 'Streamed text',
  generateObject: 'Structured data',
  streamObject: 'Streamed structured data',
};

const kindLabel: Record<string, string> = {
  search: 'Search',
  scrape: 'Page fetch',
  embed: 'Embedding',
  load: 'Model load',
};

const roleLabel: Record<string, string> = {
  classifier: 'Classifier',
  orchestrator: 'Orchestrator',
  picker: 'Result picker',
  extractor: 'Extractor',
  writer: 'Writer',
  widget: 'Widget',
};

/* Role first, because it is the only one of the three that says what the call
 * was for: the orchestrator and the writer are both streamText, and the
 * classifier and the extractor are both generateObject. Then kind, since a
 * search span's method is the engine rather than a model call shape. */
const label = (call: {
  role?: string | null;
  kind?: string | null;
  method: string;
}) =>
  (call.role && (roleLabel[call.role] ?? call.role)) ??
  (call.kind && kindLabel[call.kind]) ??
  methodLabel[call.method] ??
  call.method;

const kindColor: Record<string, string> = {
  search: 'bg-blue-400',
  scrape: 'bg-orange-400',
  embed: 'bg-teal-400',
  load: 'bg-fuchsia-400',
};

/* Coloured by role rather than by SDK method, matching the row labels. The
 * method is the mechanism -- streamText is both the orchestrator and the
 * writer -- so colouring by it made the two most distinct phases of a run the
 * same colour. A model call with no role falls back to grey rather than to the
 * method, so an untagged call is visible but never claims a role's colour. */
const roleColor: Record<string, string> = {
  classifier: 'bg-violet-500',
  orchestrator: 'bg-emerald-500',
  picker: 'bg-indigo-500',
  extractor: 'bg-amber-500',
  writer: 'bg-rose-500',
  widget: 'bg-lime-500',
};

const barColor = (call: Call) =>
  call.error
    ? 'bg-red-500'
    : ((call.role ? roleColor[call.role] : undefined) ??
      (call.kind ? kindColor[call.kind] : undefined) ??
      'bg-gray-500');

export const ms = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${v} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.floor(v / 60000)}m ${Math.round((v % 60000) / 1000)}s`;
};

const chars = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${v}`;
  return `${(v / 1000).toFixed(1)}k`;
};

/**
 * The call timeline for one message: one bar per model call on a wall-clock
 * axis, click a bar to inspect it.
 *
 * Rendered inside a chat's research panel. There was a standalone page for
 * this too; it was removed once the timeline was available where the run
 * actually happened.
 */
const LlmCallTimeline = ({
  messageId,
  isRunning = false,
}: {
  messageId: string;
  isRunning?: boolean;
}) => {
  const [calls, setCalls] = useState<Call[]>([]);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [embedsOpen, setEmbedsOpen] = useState(false);

  useEffect(() => {
    if (!messageId) return;

    let cancelled = false;

    const load = () =>
      fetch(`/api/debug/llm-calls?messageId=${encodeURIComponent(messageId)}`)
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) setCalls(data.calls ?? []);
        })
        .catch(() => undefined);

    load();

    /* While the run is live, new calls appear and open ones close, so re-read.
     * A finished run never changes and is fetched once. */
    if (!isRunning) return () => {
      cancelled = true;
    };

    const poll = setInterval(load, 2000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [messageId, isRunning]);

  /* Open rows have no duration yet, so their bars are measured against the
   * clock here rather than waiting for the server to tell us how long they
   * took -- which it cannot do until they finish. */
  const hasRunning = calls.some((c) => c.durationMs === null);

  useEffect(() => {
    if (!hasRunning) return;

    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, [hasRunning]);

  const openCall = useCallback((id: number) => {
    fetch(`/api/debug/llm-calls?callId=${id}`)
      .then((res) => res.json())
      .then((data) => setDetail(data.call ?? null))
      .catch(() => undefined);
  }, []);

  /* The timeline is laid out against wall-clock time, not call order, so
   * overlapping bars are exactly the concurrent fan-out. */
  const t0 = calls.length ? Date.parse(calls[0].startedAt) : 0;
  const endOf = (c: Call) =>
    c.durationMs === null
      ? Math.max(now, Date.parse(c.startedAt))
      : Date.parse(c.startedAt) + c.durationMs;

  const tEnd = calls.reduce((max, c) => Math.max(max, endOf(c)), t0 + 1);
  const span = Math.max(tEnd - t0, 1);

  /* Usually one model for the whole run, but a reconnect or a settings change
   * mid-run can mix them, so show every distinct one rather than the first. */
  const models = Array.from(
    new Set(
      calls
        .map((c) => [c.provider, c.model].filter(Boolean).join(' / '))
        .filter(Boolean),
    ),
  );

  /* Embeddings are collapsed into one row. A speed-mode run makes about ninety
   * of them, which buries the handful of calls that explain the run's cost;
   * grouped, they still show when they happened and how much work they were. */
  type Row =
    | { type: 'call'; call: Call; nested?: boolean }
    | { type: 'embedGroup'; calls: Call[] };

  const embeds = calls.filter((c) => c.kind === 'embed');
  const rows: Row[] = [];
  let groupPlaced = false;

  for (const call of calls) {
    if (call.kind !== 'embed') {
      rows.push({ type: 'call', call });
      continue;
    }

    /* The group sits where the first embedding did, keeping the timeline in
     * chronological order, and expanding lists them all together underneath --
     * scattering them between later calls would read as orphaned rows. */
    if (!groupPlaced) {
      rows.push({ type: 'embedGroup', calls: embeds });
      groupPlaced = true;

      if (embedsOpen) {
        for (const embed of embeds) {
          rows.push({ type: 'call', call: embed, nested: true });
        }
      }
    }
  }

  /* Only what this run actually contains. Listing all six roles and all four
   * kinds unconditionally would put ten chips above a speed-mode run that used
   * four of them, and the legend is there to decode the bars, not to enumerate
   * the pipeline. Roles stay in pipeline order so the legend reads like the run. */
  const legend = [
    ...Object.keys(roleColor)
      .filter((role) => calls.some((c) => c.role === role))
      .map((role) => ({
        key: `role-${role}`,
        color: roleColor[role],
        text: roleLabel[role] ?? role,
      })),
    ...Object.keys(kindColor)
      .filter((kind) => calls.some((c) => c.kind === kind && !c.role))
      .map((kind) => ({
        key: `kind-${kind}`,
        color: kindColor[kind],
        text: kindLabel[kind],
      })),
    ...(calls.some((c) => c.error)
      ? [{ key: 'failed', color: 'bg-red-500', text: 'Failed' }]
      : []),
  ];

  if (calls.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3 text-xs text-black/60 dark:text-white/60">
        {legend.map(({ key, color, text }) => (
          <span key={key} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${color}`} />
            {text}
          </span>
        ))}
        <span className="ml-auto text-black/70 dark:text-white/70">
          {models.join(', ')}
        </span>
        <span>
          {calls.length} calls over {ms(span)} wall clock
        </span>
      </div>

      <div className="flex flex-col gap-[3px]">
        {rows.map((row) => {
          if (row.type === 'embedGroup') {
            const first = Math.min(...row.calls.map((c) => Date.parse(c.startedAt)));
            const last = Math.max(...row.calls.map(endOf));
            const running = row.calls.filter((c) => c.durationMs === null).length;
            const cpu = row.calls.reduce((t, c) => t + (c.durationMs ?? 0), 0);

            return (
              <button
                key="embed-group"
                onClick={() => setEmbedsOpen(!embedsOpen)}
                title={`${row.calls.length} embeddings · ${ms(cpu)} of work in ${ms(last - first)} of wall clock`}
                className="relative h-5 w-full rounded-sm hover:bg-light-secondary dark:hover:bg-dark-secondary group flex items-center"
              >
                <span
                  className={`absolute top-1 h-3 rounded-sm bg-teal-400 dark:bg-teal-300 opacity-80 group-hover:opacity-100 ${running ? 'animate-pulse' : ''}`}
                  style={{
                    left: `${((first - t0) / span) * 100}%`,
                    width: `${Math.max((last - first) / span, 0.004) * 100}%`,
                    minWidth: '2px',
                  }}
                />
                <span className="relative z-10 ml-auto pl-2 pr-1 text-[10px] font-mono text-black/50 dark:text-white/50">
                  {embedsOpen ? '▾' : '▸'} {row.calls.length} embeddings
                  {running > 0 && `, ${running} running`}
                </span>
              </button>
            );
          }

          const call = row.call;
          const start = Date.parse(call.startedAt);
          const offset = (start - t0) / span;
          const width = Math.max((endOf(call) - start) / span, 0.004);
          const open = call.durationMs === null;
          const ttfb =
            !open && call.firstChunkMs
              ? call.firstChunkMs / (call.durationMs || call.firstChunkMs)
              : 0;

          return (
            <button
              key={call.id}
              onClick={() => openCall(call.id)}
              title={`${label(call)} · ${call.label ?? call.model ?? ''} · ${
                open ? `running ${ms(now - start)}` : ms(call.durationMs)
              }`}
              className={`relative h-5 w-full rounded-sm hover:bg-light-secondary dark:hover:bg-dark-secondary group ${row.nested ? 'pl-4' : ''}`}
            >
              <span
                className={`absolute top-1 h-3 rounded-sm overflow-hidden ${barColor(
                  call,
                )} opacity-80 group-hover:opacity-100 ${open ? 'animate-pulse' : ''}`}
                style={{
                  left: `${offset * 100}%`,
                  width: `${width * 100}%`,
                  minWidth: '2px',
                }}
              >
                {ttfb > 0 && (
                  <span
                    className="absolute inset-y-0 left-0 bg-white/50 dark:bg-black/40"
                    style={{ width: `${Math.min(ttfb, 1) * 100}%` }}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>

    {detail && (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto"
        onClick={() => setDetail(null)}
      >
        <div
          className="bg-light-primary dark:bg-dark-primary rounded-lg max-w-4xl w-full mt-10 p-5 flex flex-col gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg">{label(detail)}</div>
              <div className="text-sm text-black/60 dark:text-white/60">
                {/* A search or scrape span has no provider or model; its label
                  * is the query or the URL. */}
                {detail.label ??
                  `${detail.provider ?? 'unknown provider'} / ${detail.model ?? 'unknown model'}`}{' '}
                · {new Date(detail.startedAt).toLocaleString()}
              </div>
            </div>
            <button onClick={() => setDetail(null)}>
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                Duration
              </div>
              {ms(detail.durationMs)}
            </div>
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                First chunk
              </div>
              {ms(detail.firstChunkMs)}
            </div>
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                Input
              </div>
              {detail.inputTokens
                ? `${chars(detail.inputTokens)} tokens`
                : `${chars(detail.inputChars)} chars`}
            </div>
            <div>
              <div className="text-xs text-black/50 dark:text-white/50">
                Output
              </div>
              {chars(detail.outputChars)} chars
            </div>
          </div>

          {detail.error && (
            <div className="text-sm text-red-500 border border-red-500/30 rounded-md p-3">
              {detail.error}
            </div>
          )}

          {detail.inputText === null && detail.outputText === null ? (
            <div className="text-sm text-black/60 dark:text-white/60 border border-light-200/20 dark:border-dark-200/20 rounded-md p-3">
              Text was not captured for this call. Turn on{' '}
              <span className="font-medium">
                Capture model prompts and responses
              </span>{' '}
              under Settings → Debug and re-run; it only applies to calls made
              after it is enabled.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-black/50 dark:text-white/50">
                  Prompt
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words max-h-80 overflow-y-auto bg-light-secondary dark:bg-dark-secondary rounded-md p-3">
                  {detail.inputText || '(empty)'}
                </pre>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-black/50 dark:text-white/50">
                  Response
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words max-h-80 overflow-y-auto bg-light-secondary dark:bg-dark-secondary rounded-md p-3">
                  {detail.outputText || '(empty)'}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    )}
    </div>
  );
};

export default LlmCallTimeline;
