'use client';

import {
  Activity,
  Brain,
  Search,
  FileText,
  ChevronDown,
  ChevronUp,
  BookSearch,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useState } from 'react';
import { ResearchBlock, ResearchBlockSubStep } from '@/lib/types';
import { useChat } from '@/lib/hooks/useChat';
import { cn } from '@/lib/utils';
import LlmCallTimeline from './LlmCallTimeline';

const getStepIcon = (step: ResearchBlockSubStep) => {
  if (step.type === 'reasoning') {
    return <Brain className="w-4 h-4" />;
  } else if (step.type === 'searching' || step.type === 'upload_searching') {
    return <Search className="w-4 h-4" />;
  } else if (
    step.type === 'search_results' ||
    step.type === 'upload_search_results'
  ) {
    return <FileText className="w-4 h-4" />;
  } else if (step.type === 'reading') {
    return <BookSearch className="w-4 h-4" />;
  }

  return null;
};

const getStepTitle = (
  step: ResearchBlockSubStep,
  isStreaming: boolean,
): string => {
  if (step.type === 'reasoning') {
    return isStreaming && !step.reasoning ? 'Thinking...' : 'Thinking';
  } else if (step.type === 'searching') {
    const queries = Array.isArray(step.searching) ? step.searching : [];
    return `Searching ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}`;
  } else if (step.type === 'search_results') {
    return `Found ${step.reading.length} ${step.reading.length === 1 ? 'result' : 'results'}`;
  } else if (step.type === 'reading') {
    return `Reading ${step.reading.length} ${step.reading.length === 1 ? 'source' : 'sources'}`;
  } else if (step.type === 'upload_searching') {
    return 'Scanning your uploaded documents';
  } else if (step.type === 'upload_search_results') {
    return `Reading ${step.results.length} ${step.results.length === 1 ? 'document' : 'documents'}`;
  }

  return 'Processing';
};

const formatElapsed = (totalMs: number) => {
  const seconds = Math.max(Math.floor(totalMs / 1000), 0);

  if (seconds < 60) return `${seconds}s`;

  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

const AssistantSteps = ({
  block,
  messageId,
  status,
  isLast,
}: {
  block: ResearchBlock;
  messageId: string;
  status: 'answering' | 'completed' | 'error';
  isLast: boolean;
}) => {
  const [isExpanded, setIsExpanded] = useState(
    isLast && status === 'answering' ? true : false,
  );
  const { researchEnded, loading, callStats } = useChat();
  const progress = block.data.progress;
  const isRunning = status === 'answering' && !researchEnded;
  const [now, setNow] = useState(() => Date.now());
  const [showCalls, setShowCalls] = useState(false);

  /* A finished run measures to finishedAt; measuring to startedAt would render
   * 0s every time an old chat is reopened. */
  const elapsedMs = progress
    ? (isRunning
        ? now
        : Date.parse(progress.finishedAt ?? progress.startedAt)) -
      Date.parse(progress.startedAt)
    : 0;

  /* useChat polls this only while a run is live, so a reopened chat would show
   * elapsed time with no model time beside it. Fetch it once instead. */
  const [finishedStats, setFinishedStats] = useState<{
    calls: number;
    errors: number;
    modelMs: number;
  } | null>(null);

  useEffect(() => {
    if (isRunning || !progress) return;

    let cancelled = false;

    fetch(
      `/api/debug/llm-calls?messageId=${encodeURIComponent(messageId)}&summary=1`,
    )
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.summary) setFinishedStats(data.summary);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [isRunning, messageId, progress]);

  const stats = isRunning ? callStats : finishedStats;

  /* Elapsed is ticked here rather than pushed from the server, which only
   * sends startedAt once. */
  useEffect(() => {
    if (!isRunning || !progress) return;

    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isRunning, progress?.startedAt]);

  useEffect(() => {
    if (researchEnded && isLast) {
      setIsExpanded(false);
    } else if (status === 'answering' && isLast) {
      setIsExpanded(true);
    }
  }, [researchEnded, status]);

  /* Progress alone is enough to render: speed mode emits no sub-steps at all
   * (__reasoning_preamble is disabled there), and every mode has a gap before
   * the first one arrives. */
  if (!block || (block.data.subSteps.length === 0 && !block.data.progress))
    return null;

  return (
    <div className="rounded-lg bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-light-200 dark:hover:bg-dark-200 transition duration-200"
      >
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-black dark:text-white" />
          <span className="text-sm font-medium text-black dark:text-white">
            Research Progress ({block.data.subSteps.length}{' '}
            {block.data.subSteps.length === 1 ? 'step' : 'steps'})
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-black/70 dark:text-white/70" />
        ) : (
          <ChevronDown className="w-4 h-4 text-black/70 dark:text-white/70" />
        )}
      </button>

      {progress && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-3 text-xs',
            status === 'error'
              ? 'text-red-500'
              : 'text-black/70 dark:text-white/70',
          )}
        >
          <span className="text-black dark:text-white">
            {progress.phase === 'done'
              ? 'Finishing'
              : `Iteration ${progress.iteration}/${progress.maxIterations}`}
          </span>
          <span>{progress.mode}</span>
          <span>
            {formatElapsed(elapsedMs)}
          </span>
          {progress.phase !== 'done' && <span>{progress.phase}</span>}
          {(progress.scrape.completed > 0 ||
            progress.scrape.failed > 0 ||
            progress.scrape.inFlight > 0) && (
            <span>
              {progress.scrape.completed} read
              {progress.scrape.failed > 0 && (
                <span className="text-red-500">
                  {' '}
                  ({progress.scrape.failed} failed)
                </span>
              )}
              {progress.scrape.inFlight > 0 &&
                ` · ${progress.scrape.inFlight} in flight`}
            </span>
          )}
          {progress.scrape.chunksTotal > 0 && (
            <span>
              {progress.scrape.chunksDone}/{progress.scrape.chunksTotal} chunks
            </span>
          )}
          {stats && stats.calls > 0 && (
            <span>
              {stats.calls} calls · {formatElapsed(stats.modelMs)} in model
              {stats.errors > 0 && (
                <span className="text-red-500"> · {stats.errors} failed</span>
              )}
            </span>
          )}
        </div>
      )}

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-light-200 dark:border-dark-200"
          >
            <div className="p-3 space-y-2">
              {block.data.subSteps.map((step, index) => {
                const isLastStep = index === block.data.subSteps.length - 1;
                const isStreaming = loading && isLastStep && !researchEnded;

                return (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, delay: 0 }}
                    className="flex gap-2"
                  >
                    <div className="flex flex-col items-center -mt-0.5">
                      <div
                        className={`rounded-full p-1.5 bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 ${isStreaming ? 'animate-pulse' : ''}`}
                      >
                        {getStepIcon(step)}
                      </div>
                      {index < block.data.subSteps.length - 1 && (
                        <div className="w-0.5 flex-1 min-h-[20px] bg-light-200 dark:bg-dark-200 mt-1.5" />
                      )}
                    </div>

                    <div className="flex-1 pb-1">
                      <span className="text-sm font-medium text-black dark:text-white">
                        {getStepTitle(step, isStreaming)}
                      </span>

                      {step.type === 'reasoning' && (
                        <>
                          {step.reasoning && (
                            <p className="text-xs text-black/70 dark:text-white/70 mt-0.5">
                              {step.reasoning}
                            </p>
                          )}
                          {isStreaming && !step.reasoning && (
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <div
                                className="w-1.5 h-1.5 bg-black/40 dark:bg-white/40 rounded-full animate-bounce"
                                style={{ animationDelay: '0ms' }}
                              />
                              <div
                                className="w-1.5 h-1.5 bg-black/40 dark:bg-white/40 rounded-full animate-bounce"
                                style={{ animationDelay: '150ms' }}
                              />
                              <div
                                className="w-1.5 h-1.5 bg-black/40 dark:bg-white/40 rounded-full animate-bounce"
                                style={{ animationDelay: '300ms' }}
                              />
                            </div>
                          )}
                        </>
                      )}

                      {step.type === 'searching' &&
                        Array.isArray(step.searching) &&
                        step.searching.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {step.searching.map((query, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border border-light-200 dark:border-dark-200"
                              >
                                {query}
                              </span>
                            ))}
                          </div>
                        )}

                      {(step.type === 'search_results' ||
                        step.type === 'reading') &&
                        step.reading.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {step.reading.slice(0, 4).map((result, idx) => {
                              const url = result.metadata.url || '';
                              const title = result.metadata.title || 'Untitled';
                              const domain = url ? new URL(url).hostname : '';
                              const faviconUrl = domain
                                ? `https://s2.googleusercontent.com/s2/favicons?domain=${domain}&sz=128`
                                : '';

                              return (
                                <a
                                  key={idx}
                                  href={url}
                                  target="_blank"
                                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border border-light-200 dark:border-dark-200"
                                >
                                  {faviconUrl && (
                                    <img
                                      src={faviconUrl}
                                      alt=""
                                      className="w-3 h-3 rounded-sm flex-shrink-0"
                                      onError={(e) => {
                                        e.currentTarget.style.display = 'none';
                                      }}
                                    />
                                  )}
                                  <span className="line-clamp-1">{title}</span>
                                </a>
                              );
                            })}
                          </div>
                        )}

                      {step.type === 'upload_searching' &&
                        step.queries.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {step.queries.map((query, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border border-light-200 dark:border-dark-200"
                              >
                                {query}
                              </span>
                            ))}
                          </div>
                        )}

                      {step.type === 'upload_search_results' &&
                        step.results.length > 0 && (
                          <div className="mt-1.5 grid gap-3 lg:grid-cols-3">
                            {step.results.slice(0, 4).map((result, idx) => {
                              const title =
                                (result.metadata &&
                                  (result.metadata.title ||
                                    result.metadata.fileName)) ||
                                'Untitled document';

                              return (
                                <div
                                  key={idx}
                                  className="flex flex-row space-x-3 rounded-lg border border-light-200 dark:border-dark-200 bg-light-100 dark:bg-dark-100 p-2 cursor-pointer"
                                >
                                  <div className="mt-0.5 h-10 w-10 rounded-md bg-cyan-100 text-cyan-800 dark:bg-sky-500 dark:text-cyan-50 flex items-center justify-center">
                                    <FileText className="w-5 h-5" />
                                  </div>
                                  <div className="flex flex-col justify-center">
                                    <p className="text-[13px] text-black dark:text-white line-clamp-1">
                                      {title}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {stats && stats.calls > 0 && (
        <div className="border-t border-light-200 dark:border-dark-200">
          <button
            onClick={() => setShowCalls(!showCalls)}
            className="w-full flex items-center justify-between p-3 hover:bg-light-200 dark:hover:bg-dark-200 transition duration-200"
          >
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-black dark:text-white" />
              <span className="text-sm font-medium text-black dark:text-white">
                Model calls ({stats.calls})
              </span>
            </div>
            {showCalls ? (
              <ChevronUp className="w-4 h-4 text-black/70 dark:text-white/70" />
            ) : (
              <ChevronDown className="w-4 h-4 text-black/70 dark:text-white/70" />
            )}
          </button>

          {/* Mounted only when open: it fetches every call row for the message,
            * and a chat can hold many of these panels. */}
          {showCalls && (
            <div className="px-3 pb-3">
              <LlmCallTimeline messageId={messageId} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AssistantSteps;
