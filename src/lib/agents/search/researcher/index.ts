import { ActionOutput, ResearcherInput, ResearcherOutput } from '../types';
import { ActionRegistry } from './actions';
import { getResearcherPrompt } from '@/lib/prompts/search/researcher';
import SessionManager from '@/lib/session';
import { Message, ReasoningResearchBlock } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import { ToolCall } from '@/lib/models/types';
import { patchProgress, setCurrent } from './progress';
import { withRole } from '@/lib/models/base/instrumented';

class Researcher {
  async research(
    session: SessionManager,
    input: ResearcherInput,
  ): Promise<ResearcherOutput> {
    let actionOutput: ActionOutput[] = [];
    let maxIteration =
      input.config.mode === 'speed'
        ? 2
        : input.config.mode === 'balanced'
          ? 6
          : 25;

    const availableTools = ActionRegistry.getAvailableActionTools({
      classification: input.classification,
      fileIds: input.config.fileIds,
      mode: input.config.mode,
      sources: input.config.sources,
    });

    const availableActionsDescription =
      ActionRegistry.getAvailableActionsDescriptions({
        classification: input.classification,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
        sources: input.config.sources,
      });

    const researchBlockId = input.researchBlockId ?? crypto.randomUUID();

    if (session.getBlock(researchBlockId)) {
      /* The agent created it before classification, so the status line could
       * cover that call too; only the budget is still unknown at that point. */
      patchProgress(session, researchBlockId, (p) => {
        p.maxIterations = maxIteration;
      });
    } else {
      /* No block handed in -- the API agent does not make one -- so own it. */
      session.emitBlock({
        id: researchBlockId,
        type: 'research',
        data: {
          subSteps: [],
          progress: {
            startedAt: new Date().toISOString(),
            mode: input.config.mode,
            iteration: 0,
            maxIterations: maxIteration,
            phase: 'planning',
            scrape: {
              inFlight: 0,
              completed: 0,
              failed: 0,
              chunksDone: 0,
              chunksTotal: 0,
              chunksFailed: 0,
            },
          },
        },
      });
    }

    const agentMessageHistory: Message[] = [
      {
        role: 'user',
        content: `
          <conversation>
          ${formatChatHistoryAsString(input.chatHistory.slice(-10))}
           User: ${input.followUp} (Standalone question: ${input.classification.standaloneFollowUp})
           </conversation>
        `,
      },
    ];

    for (let i = 0; i < maxIteration; i++) {
      patchProgress(session, researchBlockId, (p) => {
        p.iteration = i + 1;
        p.phase = 'planning';
        p.current = `Deciding what to do next (step ${i + 1} of ${maxIteration})`;
        p.currentSince = new Date().toISOString();
      });

      const researcherPrompt = getResearcherPrompt(
        availableActionsDescription,
        input.config.mode,
        i,
        maxIteration,
        input.config.fileIds,
      );

      const actionStream = withRole(
        input.config.llm,
        'orchestrator',
      ).streamText({
        messages: [
          {
            role: 'system',
            content: researcherPrompt,
          },
          ...agentMessageHistory,
        ],
        tools: availableTools,
      });

      const block = session.getBlock(researchBlockId);

      let reasoningEmitted = false;
      let reasoningId = crypto.randomUUID();

      let finalToolCalls: ToolCall[] = [];

      for await (const partialRes of actionStream) {
        if (partialRes.toolCallChunk.length > 0) {
          partialRes.toolCallChunk.forEach((tc) => {
            if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              !reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              reasoningEmitted = true;

              block.data.subSteps.push({
                id: reasoningId,
                type: 'reasoning',
                reasoning: tc.arguments['plan'],
              });

              session.updateBlock(researchBlockId, [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: block.data.subSteps,
                },
              ]);
            } else if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              const subStepIndex = block.data.subSteps.findIndex(
                (step: any) => step.id === reasoningId,
              );

              if (subStepIndex !== -1) {
                const subStep = block.data.subSteps[
                  subStepIndex
                ] as ReasoningResearchBlock;
                subStep.reasoning = tc.arguments['plan'];
                session.updateBlock(researchBlockId, [
                  {
                    op: 'replace',
                    path: '/data/subSteps',
                    value: block.data.subSteps,
                  },
                ]);
              }
            }

            const existingIndex = finalToolCalls.findIndex(
              (ftc) => ftc.id === tc.id,
            );

            if (existingIndex !== -1) {
              finalToolCalls[existingIndex].arguments = tc.arguments;
            } else {
              finalToolCalls.push(tc);
            }
          });
        }
      }

      /* Three ways out of this loop and they look identical to the browser
       * otherwise: no tool calls, the done tool, or the budget running out. */
      if (finalToolCalls.length === 0) {
        patchProgress(session, researchBlockId, (p) => (p.phase = 'done'));
        break;
      }

      if (finalToolCalls[finalToolCalls.length - 1].name === 'done') {
        patchProgress(session, researchBlockId, (p) => (p.phase = 'done'));
        break;
      }

      agentMessageHistory.push({
        role: 'assistant',
        content: '',
        tool_calls: finalToolCalls,
      });

      /* finalToolCalls is known before anything runs, so the status line can
       * name the actual tools rather than a generic phase. */
      const toolNames = Array.from(
        new Set(finalToolCalls.map((tc) => tc.name).filter(Boolean)),
      ).filter((name) => name !== '__reasoning_preamble');

      setCurrent(
        session,
        researchBlockId,
        'searching',
        toolNames.length ? `Running ${toolNames.join(', ')}` : 'Working',
      );

      const actionResults = await ActionRegistry.executeAll(finalToolCalls, {
        llm: input.config.llm,
        embedding: input.config.embedding,
        session: session,
        callContext: input.callContext,
        /* The standalone rewrite rather than the raw follow-up, so a question
         * like "what about the newer one?" still carries its subject. */
        query:
          input.classification.standaloneFollowUp || input.followUp,
        contextPerRequest: input.config.contextPerRequest,
        researchBlockId: researchBlockId,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
      });

      actionOutput.push(...actionResults);

      actionResults.forEach((action, i) => {
        agentMessageHistory.push({
          role: 'tool',
          id: finalToolCalls[i].id,
          name: finalToolCalls[i].name,
          content: JSON.stringify(action),
        });
      });
    }

    /* Also covers falling out of the loop with the budget exhausted. Every
     * break path falls through to here, so this is the one place finishedAt
     * needs setting. */
    patchProgress(session, researchBlockId, (p) => {
      p.phase = 'done';
      p.finishedAt = new Date().toISOString();
    });

    const searchResults = actionOutput
      .filter((a) => a.type === 'search_results')
      .flatMap((a) => a.results);

    const seenUrls = new Map<string, number>();

    const filteredSearchResults = searchResults
      .map((result, index) => {
        if (result.metadata.url && !seenUrls.has(result.metadata.url)) {
          seenUrls.set(result.metadata.url, index);
          return result;
        } else if (result.metadata.url && seenUrls.has(result.metadata.url)) {
          const existingIndex = seenUrls.get(result.metadata.url)!;

          const existingResult = searchResults[existingIndex];

          existingResult.content += `\n\n${result.content}`;

          return undefined;
        }

        return result;
      })
      .filter((r) => r !== undefined);

    session.emitBlock({
      id: crypto.randomUUID(),
      type: 'source',
      data: filteredSearchResults,
    });

    return {
      findings: actionOutput,
      searchFindings: filteredSearchResults,
    };
  }
}

export default Researcher;
