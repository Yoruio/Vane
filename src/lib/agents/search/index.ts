import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { TextBlock } from '@/lib/types';
import { getTokenCount } from '@/lib/utils/splitText';
import configManager from '@/lib/config';
import { withRole } from '@/lib/models/base/instrumented';
import { setCurrent } from './researcher/progress';

/* A generous ceiling rather than a tight one: a reasoning model spends part of
 * its budget thinking before it answers, so a tight cap would turn a slow
 * answer into no answer. This exists to stop an unbounded run, not to shape
 * the response. */
const WRITER_MAX_TOKENS = 8192;

/* A quantised model can collapse into emitting one character forever. Observed
 * on 2026-10-21: 26,407 '?' characters streamed over 54 minutes, stored as the
 * answer. The idle timeout cannot catch it because tokens keep arriving, and
 * grammar-constrained calls fail loudly while free text like this does not. */
const MAX_REPEATED_CHARS = 300;

/* The trailing run of one repeated character in `text`, and whether the whole
 * chunk is that character -- which is what decides if a run carries over from
 * the previous chunk. */
const trailingRun = (text: string) => {
  const char = text[text.length - 1];
  let run = 0;

  while (run < text.length && text[text.length - 1 - run] === char) run++;

  return { char, run, wholeChunk: run === text.length };
};

class SearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    /* Created here rather than inside the researcher so the status line covers
     * the classifier too -- on a local model that call alone can run 30s, and
     * until now the UI could only say "Brainstorming...". */
    const researchBlockId = crypto.randomUUID();

    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: {
        subSteps: [],
        progress: {
          startedAt: new Date().toISOString(),
          mode: input.config.mode,
          iteration: 0,
          maxIterations: 0,
          phase: 'planning',
          current: 'Working out what to search for',
          currentSince: new Date().toISOString(),
          scrape: {
            inFlight: 0,
            completed: 0,
            failed: 0,
            chunksDone: 0,
            chunksTotal: 0,
          },
        },
      },
    });

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
        researchBlockId,
        /* Same key the model registry reads when it wraps the chat model; read
         * here too rather than importing it through the telemetry module,
         * which everything else imports. */
        callContext: {
          messageId: input.messageId,
          chatId: input.chatId,
          captureText:
            configManager.getConfig('debug.captureLlmText', false) === true,
        },
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      finalContext = searchResults?.searchFindings
        .map(
          (f, index) =>
            `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
        )
        .join('\n');
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
    );

    setCurrent(session, researchBlockId, 'writing', 'Writing the answer');

    const answerStream = withRole(input.config.llm, 'writer').streamText({
      options: { maxTokens: WRITER_MAX_TOKENS },
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    let responseBlockId = '';

    let repeatRun = 0;
    let lastChar = '';
    let degenerated = false;

    for await (const chunk of answerStream) {
      const text = chunk.contentChunk ?? '';

      if (text) {
        const { char, run, wholeChunk } = trailingRun(text);

        repeatRun = wholeChunk && char === lastChar ? repeatRun + run : run;
        lastChar = char;

        if (repeatRun >= MAX_REPEATED_CHARS) {
          console.error(
            `Writer degenerated: ${repeatRun} repetitions of ${JSON.stringify(lastChar)}; stopping.`,
          );
          degenerated = true;
          break;
        }
      }

      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;

        session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }
    }

    setCurrent(session, researchBlockId, 'done', undefined);

    if (degenerated) {
      const block = session.getBlock(responseBlockId) as TextBlock | null;

      if (block) {
        block.data +=
          '\n\n_The model began repeating itself, so the answer was stopped here._';

        session.updateBlock(block.id, [
          { op: 'replace', path: '/data', value: block.data },
        ]);
      }
    }

    session.emit('end', {});

    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  }
}

export default SearchAgent;
