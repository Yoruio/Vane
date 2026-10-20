'use client';

import { Activity, AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import LlmCallTimeline, { ms } from '@/components/LlmCallTimeline';

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

const Page = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
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


  return (
    <div className="flex flex-col gap-6 pt-10 px-2 pb-16">
      {/* Centered below lg, left from lg up — matches the Library header, whose
          wrapper flips to lg:justify-between at that breakpoint. */}
      <div className="flex items-center justify-center lg:justify-start border-b border-light-200/20 dark:border-dark-200/20 pb-6">
        <Activity size={45} className="mb-2.5" />
        <div className="flex flex-col">
          <h1
            className="text-5xl font-normal p-2 pb-0"
            style={{ fontFamily: 'PP Editorial, serif' }}
          >
            Model calls
          </h1>
          <div className="px-2 text-sm text-black/60 dark:text-white/60 text-center lg:text-left">
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
          switched on under Settings → Debug.
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

          <div className="flex-1 min-w-0">
            {selectedRun && <LlmCallTimeline messageId={selectedRun} />}
          </div>
        </div>
      )}

    </div>
  );
};

export default Page;
