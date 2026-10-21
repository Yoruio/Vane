import { ToolCall } from './models/types';

export type SystemMessage = {
  role: 'system';
  content: string;
};

export type AssistantMessage = {
  role: 'assistant';
  content: string;
  tool_calls?: ToolCall[];
};

export type UserMessage = {
  role: 'user';
  content: string;
};

export type ToolMessage = {
  role: 'tool';
  id: string;
  name: string;
  content: string;
};

export type ChatTurnMessage = UserMessage | AssistantMessage;

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ToolMessage;

export type Chunk = {
  content: string;
  metadata: Record<string, any>;
};

export type TextBlock = {
  id: string;
  type: 'text';
  data: string;
};

export type SourceBlock = {
  id: string;
  type: 'source';
  data: Chunk[];
};

export type SuggestionBlock = {
  id: string;
  type: 'suggestion';
  data: string[];
};

export type WidgetBlock = {
  id: string;
  type: 'widget';
  data: {
    widgetType: string;
    params: Record<string, any>;
  };
};

export type ReasoningResearchBlock = {
  id: string;
  type: 'reasoning';
  reasoning: string;
};

export type SearchingResearchBlock = {
  id: string;
  type: 'searching';
  searching: string[];
};

export type SearchResultsResearchBlock = {
  id: string;
  type: 'search_results';
  reading: Chunk[];
};

export type ReadingResearchBlock = {
  id: string;
  type: 'reading';
  reading: Chunk[];
};

export type UploadSearchingResearchBlock = {
  id: string;
  type: 'upload_searching';
  queries: string[];
};

export type UploadSearchResultsResearchBlock = {
  id: string;
  type: 'upload_search_results';
  results: Chunk[];
};

export type ResearchBlockSubStep =
  | ReasoningResearchBlock
  | SearchingResearchBlock
  | SearchResultsResearchBlock
  | ReadingResearchBlock
  | UploadSearchingResearchBlock
  | UploadSearchResultsResearchBlock;

/* Live status of a run, carried inside the research block rather than on a
 * channel of its own: the chat route forwards only 'block', 'updateBlock' and
 * 'researchComplete', and session.subscribe() replays block snapshots, so
 * anything outside a block is dropped on reconnect. */
export type ResearchProgress = {
  /* The client ticks elapsed time from this; the server never pushes per-second
   * updates. */
  startedAt: string;
  /* Set when the loop ends, so a finished run can still report how long it
   * took; without it a reopened chat has nothing to measure against. */
  finishedAt?: string;
  mode: 'speed' | 'balanced' | 'quality';
  iteration: number;
  maxIterations: number;
  phase: 'planning' | 'searching' | 'reading' | 'writing' | 'done';
  /* What is happening right now, for a status line. The telemetry cannot answer
   * this: a row is written when a call finishes, so an in-flight call does not
   * exist in it yet. */
  current?: string;
  /* When the current activity started, so the client can age it without the
   * server pushing updates. */
  currentSince?: string;
  scrape: {
    inFlight: number;
    completed: number;
    failed: number;
    chunksDone: number;
    chunksTotal: number;
  };
};

export type ResearchBlock = {
  id: string;
  type: 'research';
  data: {
    subSteps: ResearchBlockSubStep[];
    /* Optional so a block persisted before this existed still parses. */
    progress?: ResearchProgress;
  };
};

export type Block =
  | TextBlock
  | SourceBlock
  | SuggestionBlock
  | WidgetBlock
  | ResearchBlock;
