import db from '@/lib/db';
import { llmCalls, messages } from '@/lib/db/schema';
import { desc, eq, sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

/* The text columns hold whole prompts, so they are never selected for a list —
 * only for the single call the user opened. */
const callSummary = {
  id: llmCalls.id,
  provider: llmCalls.provider,
  model: llmCalls.model,
  method: llmCalls.method,
  startedAt: llmCalls.startedAt,
  durationMs: llmCalls.durationMs,
  firstChunkMs: llmCalls.firstChunkMs,
  inputChars: llmCalls.inputChars,
  outputChars: llmCalls.outputChars,
  error: llmCalls.error,
  hasText: sql<number>`(${llmCalls.inputText} is not null or ${llmCalls.outputText} is not null)`,
};

const listRuns = async () => {
  const runs = await db
    .select({
      messageId: llmCalls.messageId,
      chatId: llmCalls.chatId,
      query: messages.query,
      status: messages.status,
      calls: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${llmCalls.error} is null then 0 else 1 end)`,
      startedAt: sql<string>`min(${llmCalls.startedAt})`,
      lastStartedAt: sql<string>`max(${llmCalls.startedAt})`,
      modelMs: sql<number>`sum(coalesce(${llmCalls.durationMs}, 0))`,
      inputChars: sql<number>`sum(coalesce(${llmCalls.inputChars}, 0))`,
      outputChars: sql<number>`sum(coalesce(${llmCalls.outputChars}, 0))`,
    })
    .from(llmCalls)
    .leftJoin(messages, eq(messages.messageId, llmCalls.messageId))
    .groupBy(llmCalls.messageId)
    .orderBy(desc(sql`min(${llmCalls.startedAt})`))
    .limit(100);

  return Response.json({ runs }, { status: 200 });
};

/* Aggregate for the live progress strip, which polls while a search runs: a
 * long run has hundreds of rows and must not ship them all every few seconds.
 * Covered by llm_calls_messageId_idx. */
const summarizeCalls = async (messageId: string) => {
  const [summary] = await db
    .select({
      calls: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${llmCalls.error} is null then 0 else 1 end)`,
      modelMs: sql<number>`sum(coalesce(${llmCalls.durationMs}, 0))`,
    })
    .from(llmCalls)
    .where(eq(llmCalls.messageId, messageId));

  return Response.json({ summary }, { status: 200 });
};

const listCalls = async (messageId: string) => {
  const calls = await db
    .select(callSummary)
    .from(llmCalls)
    .where(eq(llmCalls.messageId, messageId))
    .orderBy(llmCalls.startedAt, llmCalls.id);

  return Response.json({ calls }, { status: 200 });
};

const getCall = async (callId: number) => {
  const call = await db.query.llmCalls.findFirst({
    where: eq(llmCalls.id, callId),
  });

  if (!call) {
    return Response.json({ message: 'Call not found' }, { status: 404 });
  }

  return Response.json({ call }, { status: 200 });
};

export const GET = async (req: Request) => {
  try {
    const params = new URL(req.url).searchParams;
    const callId = params.get('callId');
    const messageId = params.get('messageId');

    if (callId) return getCall(Number(callId));
    if (messageId && params.get('summary')) return summarizeCalls(messageId);
    if (messageId) return listCalls(messageId);
    return listRuns();
  } catch (err) {
    console.error('Error in getting llm calls: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
