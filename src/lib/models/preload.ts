import ModelRegistry from './registry';
import { CallContext, recordCall } from '@/lib/telemetry';
import {
  AUTO_CHUNK_FLOOR,
  REQUEST_OVERHEAD_TOKENS,
  getConfiguredChunkTokens,
} from '@/lib/agents/search/researcher/chunking';

/* Structural check rather than an instanceof: only some providers have a
 * management API, and importing the concrete class here would couple the
 * registry to one provider. */
type Preloadable = {
  isModelLoaded: (modelName: string) => Promise<boolean>;
  loadModel: (modelName: string) => Promise<boolean>;
  getSlotInfo?: (modelName: string) => Promise<{
    slots: number;
    contextSize: number;
    contextPerSlot: number;
  } | null>;
};

const asPreloadable = (provider: unknown): Preloadable | null =>
  provider &&
  typeof (provider as Preloadable).loadModel === 'function' &&
  typeof (provider as Preloadable).isModelLoaded === 'function'
    ? (provider as Preloadable)
    : null;

export type PreloadResult = {
  /* 'supported' is false for providers with nothing to load -- a hosted API
   * has no weights to bring into memory. */
  supported: boolean;
  alreadyLoaded: boolean;
  loaded: boolean;
  durationMs: number;
  slots?: number;
  contextPerSlot?: number;
  /* Set when the per-slot window looks too small for what a search sends. */
  warning?: string;
};

/**
 * Whether this slot size will actually cause trouble.
 *
 * When the chunk size is automatic it is derived from the slot size, so it fits
 * by construction and there is nothing to warn about. Only two cases are real:
 * an explicit chunk size that does not fit, and slots so small that even the
 * smallest useful chunk will not fit.
 */
const slotWarning = (slots: number, contextPerSlot: number) => {
  const explicit = getConfiguredChunkTokens();

  if (explicit) {
    if (explicit + REQUEST_OVERHEAD_TOKENS <= contextPerSlot) return undefined;

    return (
      `Scrape chunk size is set to ${explicit.toLocaleString()} tokens, but ${slots} parallel ` +
      `slots leave only ${contextPerSlot.toLocaleString()} tokens per request. Requests will be ` +
      `truncated or rejected. Lower the chunk size, reduce --parallel, or clear the chunk size ` +
      `to size it automatically.`
    );
  }

  if (contextPerSlot >= AUTO_CHUNK_FLOOR + REQUEST_OVERHEAD_TOKENS)
    return undefined;

  return (
    `${slots} parallel slots leave only ${contextPerSlot.toLocaleString()} tokens per request, ` +
    `which is too small to read a page with. Reduce --parallel or raise --ctx-size.`
  );
};

const slotFields = async (provider: Preloadable, modelName: string) => {
  const info = await provider.getSlotInfo?.(modelName);

  if (!info) return {};

  return {
    slots: info.slots,
    contextPerSlot: info.contextPerSlot,
    warning: slotWarning(info.slots, info.contextPerSlot),
  };
};

/**
 * Brings a model's weights into memory if the provider can, so the first real
 * request does not pay for it. Safe to call repeatedly: an already-resident
 * model returns immediately.
 */
export const preloadModel = async (
  providerId: string,
  modelName: string,
): Promise<PreloadResult> => {
  const registry = new ModelRegistry();
  const entry = registry.activeProviders.find((p) => p.id === providerId);
  const provider = asPreloadable(entry?.provider);

  if (!provider) {
    return {
      supported: false,
      alreadyLoaded: false,
      loaded: false,
      durationMs: 0,
    };
  }

  const start = Date.now();

  if (await provider.isModelLoaded(modelName)) {
    return {
      supported: true,
      alreadyLoaded: true,
      loaded: true,
      durationMs: Date.now() - start,
      ...(await slotFields(provider, modelName)),
    };
  }

  const loaded = await provider.loadModel(modelName);

  return {
    supported: true,
    alreadyLoaded: false,
    loaded,
    durationMs: Date.now() - start,
    ...(await slotFields(provider, modelName)),
  };
};


/**
 * Confirms the weights are resident before a search starts, and records the
 * wait as its own span.
 *
 * The load happens either way -- Lemonade pays it on the first request -- but
 * doing it here keeps it out of whichever model call happened to be first. The
 * classifier used to read 34s when 25s of that was loading.
 */
export const ensureModelReady = async (
  providerId: string,
  modelName: string,
  ctx: CallContext & { provider?: string },
) => {
  const startedAt = new Date().toISOString();
  const result = await preloadModel(providerId, modelName);

  if (!result.supported) return result;

  /* Logged as well as returned: a search can start without anyone having
   * touched the model dropdown, so the toast is not guaranteed to be seen. */
  if (result.warning) console.warn(`Model context warning: ${result.warning}`);

  await recordCall(ctx, {
    kind: 'load',
    method: result.alreadyLoaded ? 'already-resident' : 'load',
    /* No role: the kind already labels this "Model load", and role takes
     * precedence in the timeline. */
    label: modelName,
    provider: ctx.provider,
    model: modelName,
    startedAt,
    durationMs: result.durationMs,
    error: result.loaded ? undefined : 'model did not report as loaded',
  });

  return result;
};
