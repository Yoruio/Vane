'use client';

import { Activity, AlertTriangle, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface Run {
  messageId: string | null;
  chatId: string | null;
  query: string | null;
  status: string | null;
  calls: number;
  errors: number;
  startedAt: string;
  lastStartedAt: string;
  modelMs: number;
  inputChars: number;
  outputChars: number;
}

interface Call {
  id: number;
  provider: string | null;
  model: string | null;
  method: string;
  startedAt: string;
  durationMs: number | null;
  firstChunkMs: number | null;
  inputChars: number | null;
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
const methodColor: Record<string, string> = {
  generateText: 'bg-sky-500',
  streamText: 'bg-emerald-500',
  generateObject: 'bg-violet-500',
  streamObject: 'bg-amber-500',
};

const ms = (v: number | null | undefined) => {
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

const Page = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/debug/llm-calls')
      .then((res) => res.json())
      .then((data) => {
        setRuns(data.runs ?? []);
        setSelectedRun(data.runs?.[0]?.messageId ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedRun) return;
    setCalls([]);
    fetch(`/api/debug/llm-calls?messageId=${encodeURIComponent(selectedRun)}`)
      .then((res) => res.json())
      .then((data) => setCalls(data.calls ?? []));
  }, [selectedRun]);

  const openCall = useCallback((id: number) => {
    fetch(`/api/debug/llm-calls?callId=${id}`)
      .then((res) => res.json())
      .then((data) => setDetail(data.call ?? null));
  }, []);

  /* The timeline is laid out against wall-clock time, not call order, so
   * overlapping bars are exactly the concurrent fan-out. */
  const t0 = calls.length ? Date.parse(calls[0].startedAt) : 0;
  const tEnd = calls.reduce(
    (max, c) => Math.max(max, Date.parse(c.startedAt) + (c.durationMs ?? 0)),
    t0 + 1,
  );
  const span = Math.max(tEnd - t0, 1);

  return (
    <div className="flex flex-col gap-6 pt-10 px-2 pb-16">
      <div className="flex items-center border-b border-light-200/20 dark:border-dark-200/20 pb-6">
        <Activity size={40} className="mb-2.5" />
        <div className="flex flex-col">
          <h1
            className="text-5xl font-normal p-2 pb-0"
            style={{ fontFamily: 'PP Editorial, serif' }}
          >
            Model calls
          </h1>
          <div className="px-2 text-sm text-black/60 dark:text-white/60">
            Every call a run made, on a wall-clock timeline. Click a bar to
            inspect it.
          </div>
        </div>
      </div>

      {loading && (
        <div className="text-sm text-black/60 dark:text-white/60">Loading…</div>
      )}

      {!loading && runs.length === 0 && (
        <div className="text-sm text-black/60 dark:text-white/60">
          No calls recorded yet. Timing is always recorded; prompts and
          responses need{' '}
          <span className="font-medium">Capture model prompts and responses</span>{' '}
          switched on in settings.
        </div>
      )}

      {runs.length > 0 && (
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="lg:w-80 shrink-0 flex flex-col gap-1 max-h-[32rem] lg:max-h-[70vh] overflow-y-auto">
            {runs.map((run) => (
              <button
                key={run.messageId ?? run.startedAt}
                onClick={() => setSelectedRun(run.messageId)}
                className={`text-left rounded-lg px-3 py-2 border transition ${
                  selectedRun === run.messageId
                    ? 'border-black/20 dark:border-white/20 bg-light-secondary dark:bg-dark-secondary'
                    : 'border-transparent hover:bg-light-secondary dark:hover:bg-dark-secondary'
                }`}
              >
                <div className="text-sm truncate">
                  {run.query ?? run.messageId ?? 'Unattributed calls'}
                </div>
                <div className="text-xs text-black/60 dark:text-white/60 flex items-center gap-2">
                  <span>{run.calls} calls</span>
                  <span>{ms(run.modelMs)} in model</span>
                  {run.errors > 0 && (
                    <span className="text-red-500 flex items-center gap-1">
                      <AlertTriangle size={11} />
                      {run.errors}
                    </span>
                  )}
                </div>
                <div className="text-xs text-black/40 dark:text-white/40">
                  {new Date(run.startedAt).toLocaleString()}
                </div>
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <div className="flex flex-wrap gap-3 text-xs text-black/60 dark:text-white/60">
              {Object.entries(methodColor).map(([method, color]) => (
                <span key={method} className="flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded-sm ${color}`} />
                  {method}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-white/40 dark:bg-black/40 border border-black/20 dark:border-white/20" />
                time to first chunk
              </span>
              <span className="ml-auto">
                {calls.length} calls over {ms(span)} wall clock
              </span>
            </div>

            <div className="flex flex-col gap-[3px]">
              {calls.map((call) => {
                const offset = (Date.parse(call.startedAt) - t0) / span;
                const width = Math.max((call.durationMs ?? 0) / span, 0.004);
                const ttfb = call.firstChunkMs
                  ? call.firstChunkMs / (call.durationMs || call.firstChunkMs)
                  : 0;

                return (
                  <button
                    key={call.id}
                    onClick={() => openCall(call.id)}
                    title={`${call.method} · ${ms(call.durationMs)} · ${chars(call.inputChars)} chars in`}
                    className="relative h-5 w-full rounded-sm hover:bg-light-secondary dark:hover:bg-dark-secondary group"
                  >
                    <span
                      className={`absolute top-1 h-3 rounded-sm overflow-hidden ${
                        call.error
                          ? 'bg-red-500'
                          : (methodColor[call.method] ?? 'bg-gray-500')
                      } opacity-80 group-hover:opacity-100`}
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
          </div>
        </div>
      )}

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
                <div className="text-lg">{detail.method}</div>
                <div className="text-sm text-black/60 dark:text-white/60">
                  {detail.provider ?? 'unknown provider'} ·{' '}
                  {detail.model ?? 'unknown model'} ·{' '}
                  {new Date(detail.startedAt).toLocaleString()}
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
                {chars(detail.inputChars)} chars
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
                in settings and re-run; it only applies to calls made after it
                is enabled.
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

export default Page;
