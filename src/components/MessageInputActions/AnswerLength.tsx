'use client';

import { cn } from '@/lib/utils';
import { useChat } from '@/lib/hooks/useChat';

/* Four stops rather than three: "auto" has to be reachable, because it is the
 * only setting that lets the research depth decide the answer length, and it is
 * the default. Ordered shortest-to-longest so the track reads as a length. */
const STOPS = [
  {
    key: 'auto',
    label: 'Auto',
    hint: 'Length follows research depth',
  },
  {
    key: 'brief',
    label: 'Brief',
    hint: 'Answer the question, 2–4 sentences',
  },
  {
    key: 'standard',
    label: 'Standard',
    hint: 'Short answer with a few bullets',
  },
  {
    key: 'deep',
    label: 'Deep',
    hint: 'Full written report',
  },
];

const AnswerLength = () => {
  const { answerStyle, setAnswerStyle } = useChat();

  const index = Math.max(
    0,
    STOPS.findIndex((s) => s.key === (answerStyle || 'auto')),
  );
  const current = STOPS[index];

  return (
    <div
      className="flex flex-row items-center"
      /* The track is the control; the title carries the explanation so the
       * input bar does not need room for a description. */
      title={`Answer length — ${current.label}: ${current.hint}`}
    >
      <div
        role="radiogroup"
        aria-label="Answer length"
        className="relative flex flex-row items-center rounded-full bg-light-200 dark:bg-dark-200 p-0.5"
      >
        {/* The thumb. Positioned by index rather than by a transform on the
            buttons, so the labels stay put while it slides between them. */}
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-full bg-light-primary dark:bg-dark-primary shadow-sm transition-all duration-200 ease-out"
          style={{
            width: `calc(${100 / STOPS.length}% - 2px)`,
            left: `calc(${(index * 100) / STOPS.length}% + 1px)`,
          }}
        />

        {STOPS.map((stop) => {
          const active = stop.key === current.key;

          return (
            <button
              key={stop.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setAnswerStyle(stop.key)}
              title={`${stop.label} — ${stop.hint}`}
              className={cn(
                'relative z-10 px-2 py-1 text-[11px] rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
                active
                  ? 'text-black dark:text-white font-medium'
                  : 'text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80',
              )}
            >
              {stop.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default AnswerLength;
