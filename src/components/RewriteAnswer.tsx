'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const STYLES: { key: 'brief' | 'standard' | 'deep'; label: string }[] = [
  { key: 'brief', label: 'Brief' },
  { key: 'standard', label: 'Standard' },
  { key: 'deep', label: 'Deep' },
];

/**
 * Rewrites a finished answer at a different length.
 *
 * Only the writer runs again, against the context stored when the answer was
 * first produced -- the research is what costs minutes, so the same sources
 * and citations are reused rather than retrieved again.
 */
const RewriteAnswer = ({
  messageId,
  current,
  onRewrite,
}: {
  messageId: string;
  current?: string | null;
  onRewrite: (text: string) => void;
}) => {
  const [busy, setBusy] = useState<string | null>(null);

  const rewrite = async (style: 'brief' | 'standard' | 'deep') => {
    if (busy) return;
    setBusy(style);

    try {
      const res = await fetch('/api/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          answerStyle: style,
          chatModel: {
            providerId: localStorage.getItem('chatModelProviderId'),
            key: localStorage.getItem('chatModelKey'),
          },
        }),
      });

      if (!res.ok) {
        const { message } = await res.json().catch(() => ({ message: '' }));
        toast.error(message || 'Could not rewrite this answer.');
        return;
      }

      /* Same framing as the chat stream: dispatch complete lines and carry the
       * trailing fragment, so the rewrite appears as it is written. */
      const reader = res.body!.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let text = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);
            if (event.type === 'chunk') {
              text += event.data;
              onRewrite(text);
            } else if (event.type === 'error') {
              toast.error(event.data || 'Rewrite failed.');
            }
          } catch {
            /* A complete line that will not parse is a server problem; skip it
             * rather than stalling the rest of the rewrite. */
          }
        }
      }
    } catch {
      toast.error('Could not reach the server to rewrite this answer.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-row items-center gap-2 text-xs text-black/50 dark:text-white/50">
      <span>Rewrite as</span>

      {STYLES.map((style) => {
        const active = current === style.key;

        return (
          <button
            key={style.key}
            type="button"
            disabled={busy !== null || active}
            onClick={() => rewrite(style.key)}
            title={
              active
                ? `This answer is already ${style.label.toLowerCase()}`
                : `Rewrite at ${style.label.toLowerCase()} length, reusing the same sources`
            }
            className={cn(
              'flex flex-row items-center gap-1 px-2 py-1 rounded-lg transition duration-200',
              active
                ? 'text-black/30 dark:text-white/30 cursor-default'
                : 'hover:bg-light-secondary dark:hover:bg-dark-secondary hover:text-black dark:hover:text-white',
              busy && busy !== style.key && 'opacity-40',
            )}
          >
            {busy === style.key && (
              <Loader2 size={12} className="animate-spin" />
            )}
            {style.label}
          </button>
        );
      })}
    </div>
  );
};

export default RewriteAnswer;
