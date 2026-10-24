import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import BaseModelProvider from '../../base/provider';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseLLM from '../../base/llm';
import LemonadeLLM from './lemonadeLLM';
import BaseEmbedding from '../../base/embedding';
import LemonadeEmbedding from './lemonadeEmbedding';

interface LemonadeConfig {
  baseURL: string;
  apiKey?: string;
  llamacppArgs?: string;
}

const providerConfigFields: UIConfigField[] = [
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description: 'The base URL for Lemonade API',
    required: true,
    placeholder: 'https://api.lemonade.ai/v1',
    env: 'LEMONADE_BASE_URL',
    scope: 'server',
  },
  {
    type: 'string',
    name: 'llama.cpp arguments',
    key: 'llamacppArgs',
    description:
      'Passed to llama-server when this app loads a model. Leave empty to derive parallelism from the model\'s own context window, which is the safer default: a value chosen for one model starves the next, since the context is split between parallel slots. Set this only to override that.',
    required: false,
    placeholder: '--parallel 2',
    env: 'LEMONADE_LLAMACPP_ARGS',
    scope: 'server',
  },
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description: 'Your Lemonade API key (optional)',
    required: false,
    placeholder: 'Lemonade API Key',
    env: 'LEMONADE_API_KEY',
    scope: 'server',
  },
];

class LemonadeProvider extends BaseModelProvider<LemonadeConfig> {
  constructor(id: string, name: string, config: LemonadeConfig) {
    super(id, name, config);
  }

  /**
   * One slot, always.
   *
   * Slots were derived from the context window on the theory that more slots
   * meant more throughput. Measured on 2026-10-24 with the same binary, the
   * same 20 prompts and only --parallel varied:
   *
   *   --parallel 1  ->  20/20 ok,  0 grammar crashes, mean 146s (4 clients)
   *   --parallel 2  ->   0/20 ok, 19 grammar crashes
   *   --parallel 4  ->   1/20 ok, 19 grammar crashes
   *
   * More than one slot breaks grammar-constrained generation outright: every
   * generateObject call -- extractor, picker, classifier -- fails with
   * llama.cpp's "Unexpected empty grammar stack after accepting piece: ? (30)".
   * Upstream has this open as #30419 with no fix, and the related reports only
   * soften the crash rather than prevent it.
   *
   * One slot is also faster here: 32.4s mean for an extraction against 146s,
   * and it gives every request the model's whole context instead of a
   * fraction, which removes the overflow problem the derivation existed to
   * manage. Nothing is given up: the earlier "4 slots beat 8" measurement was
   * a 6% difference on prefill-heavy prompts, and nine concurrent extractor
   * calls were measured spreading 28s-212s, i.e. queueing rather than
   * parallelism.
   */
  private static readonly SLOTS = 1;

  /** The model's context window, used to verify what a load actually gave us. */
  private async contextLength(modelName: string): Promise<number | null> {
    try {
      const res = await fetch(this.managementURL('/models'), {
        headers: this.managementHeaders(),
      });

      if (!res.ok) return null;

      const body = await res.json();
      const model = (body.data ?? []).find((m: any) => m.id === modelName);

      return model?.context_length ?? model?.max_context_window ?? null;
    } catch {
      return null;
    }
  }

  /** What one request can actually hold, from the running process's own flags. */
  private perRequestContext(record: any): number | null {
    const args: string[] = (record?.launch_command ?? []).map(String);
    const at = args.indexOf('--ctx-size');

    if (at === -1) return null;

    const ctx = Number(args[at + 1]);
    const parallelAt = args.indexOf('--parallel');
    const slots = parallelAt === -1 ? 1 : Number(args[parallelAt + 1]) || 1;

    return Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx / slots) : null;
  }

  /* Lemonade's management API sits beside the OpenAI-compatible path: the
   * configured baseURL ends in /v1, the management routes are under /api/v1. */
  private managementURL(path: string) {
    return `${this.config.baseURL.replace(/\/v1\/?$/, '')}/api/v1${path}`;
  }

  private managementHeaders() {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey
        ? { Authorization: `Bearer ${this.config.apiKey}` }
        : {}),
    };
  }

  /**
   * Whether the weights are already resident. Lemonade unloads idle models, and
   * the first request after that pays ~26s of load -- which otherwise lands on
   * whichever call happens to be first.
   */
  private async loadedRecord(modelName: string): Promise<any | null> {
    try {
      const res = await fetch(this.managementURL('/health'), {
        headers: this.managementHeaders(),
      });

      if (!res.ok) return null;

      const health = await res.json();

      return (
        (health.all_models_loaded ?? []).find(
          (m: any) => m.model_name === modelName && m.loaded,
        ) ?? null
      );
    } catch {
      /* An unreachable management API is not a reason to block a search. */
      return null;
    }
  }

  /**
   * How the resident model was launched: how many request slots it has and how
   * much context each one gets.
   *
   * llama-server divides --ctx-size between --parallel slots, so raising
   * parallelism shrinks the window available to any single request. Reported
   * rather than judged -- what counts as too small depends on what the caller
   * intends to send.
   */
  async getSlotInfo(modelName: string): Promise<{
    slots: number;
    contextSize: number;
    contextPerSlot: number;
  } | null> {
    const record = await this.loadedRecord(modelName);

    if (!record) return null;

    const args: string[] = record.launch_command ?? [];
    const valueOf = (flag: string) => {
      const i = args.indexOf(flag);
      return i === -1 ? undefined : Number(args[i + 1]);
    };

    const contextSize =
      valueOf('--ctx-size') ?? record.max_context_window ?? 0;
    const slots = valueOf('--parallel') ?? 1;

    if (!contextSize || !slots) return null;

    return {
      slots,
      contextSize,
      contextPerSlot: Math.floor(contextSize / slots),
    };
  }

  /* Whether every flag we asked for is present in what the server actually
   * launched, ignoring order and any extras it added itself. */
  private hasArgs(record: any): boolean {
    const wanted = (this.config.llamacppArgs ?? '').trim().split(/\s+/);
    const actual: string[] = (record.launch_command ?? []).map(String);
    const reported = String(record.recipe_options?.llamacpp_args ?? '')
      .trim()
      .split(/\s+/);
    const haystack = new Set([...actual, ...reported]);

    /* Flags come as "--flag value" pairs; require the value to sit directly
     * after its flag rather than merely appearing somewhere. */
    for (let i = 0; i < wanted.length; i++) {
      if (!wanted[i].startsWith('--')) continue;

      const value = wanted[i + 1]?.startsWith('--') ? undefined : wanted[i + 1];

      if (!haystack.has(wanted[i])) return false;

      if (value !== undefined) {
        const atIdx = actual.indexOf(wanted[i]);
        const inReported = reported.indexOf(wanted[i]);
        const matches =
          (atIdx !== -1 && actual[atIdx + 1] === value) ||
          (inReported !== -1 && reported[inReported + 1] === value);

        if (!matches) return false;
      }
    }

    return true;
  }

  async isModelLoaded(modelName: string): Promise<boolean> {
    const record = await this.loadedRecord(modelName);

    if (!record) return false;

    /* Resident but launched without the configured arguments counts as not
     * ready, or setting them would silently do nothing whenever the model
     * happened to already be up.
     *
     * Containment, not equality: Lemonade merges what we send with the
     * server's own defaults, so asking for "--parallel 4" comes back as
     * "--parallel 4 --spec-type draft-mtp". Comparing the whole string never
     * matches, which made every single search unload and reload the model. */
    if (this.config.llamacppArgs) return this.hasArgs(record);

    /* A model left resident with a different split would never be corrected
     * otherwise -- the trap that comparing arguments by equality already
     * caused once today. */
    const args: string[] = (record.launch_command ?? []).map(String);
    const at = args.indexOf('--parallel');

    /* A model left resident with a different split would never be corrected
     * otherwise, and more than one slot is not a performance choice here --
     * it breaks every structured call. */
    if (at === -1 || Number(args[at + 1]) !== LemonadeProvider.SLOTS) {
      return false;
    }

    return true;
  }

  async loadModel(modelName: string): Promise<boolean> {
    try {
      const args =
        this.config.llamacppArgs ?? `--parallel ${LemonadeProvider.SLOTS}`;

      /* llama-server only takes its arguments at process start, so applying
       * them to a resident model means restarting it. Never do that while it is
       * serving someone -- another client may share this box. */
      const record = await this.loadedRecord(modelName);

      if (record && !record.is_busy && !record.is_streaming) {
        await fetch(this.managementURL('/unload'), {
          method: 'POST',
          headers: this.managementHeaders(),
          body: JSON.stringify({ model_name: modelName }),
        }).catch(() => undefined);
      } else if (record) {
        /* Busy: leave it alone and report the current state as good enough. */
        return true;
      }

      const res = await fetch(this.managementURL('/load'), {
        method: 'POST',
        headers: this.managementHeaders(),
        body: JSON.stringify({
          model_name: modelName,
          /* A reload would otherwise silently unpin a model someone pinned
           * deliberately to keep it resident. */
          ...(record?.pinned ? { pinned: true } : {}),
          /* Derived from the model's own context rather than configured: a
           * hand-set value is right for one model and starves the next, and
           * nothing tells you. Note the load endpoint reports success even for
           * keys it ignores, so check /health to confirm it took effect. */
          ...(args ? { llamacpp_args: args } : {}),
        }),
      });

      if (!res.ok) return false;

      const data = await res.json();

      if (data.status !== 'success') return false;

      /* Verify rather than assume. On 2026-10-21 a 131k model ended up serving
       * 4,096 tokens per request -- a tenth of what the flags implied -- and
       * every search failed for an hour before anyone looked. The cause was
       * never identified, so this checks the outcome instead: if the running
       * process is not giving roughly what the arithmetic predicted, drop the
       * arguments and let the server use its own configuration. */
      {
        const total = await this.contextLength(modelName);

        if (total) {
          const predicted = Math.floor(total / LemonadeProvider.SLOTS);
          const actual = this.perRequestContext(
            await this.loadedRecord(modelName),
          );

          /* A tenth of the prediction is the failure that happened; a small
           * shortfall is just rounding. */
          if (!actual || actual < predicted * 0.9) {
            console.warn(
              `Lemonade gave ${actual ?? 'no'} tokens per request for ${modelName}, ` +
                `expected about ${predicted}; reloading without arguments.`,
            );

            await fetch(this.managementURL('/unload'), {
              method: 'POST',
              headers: this.managementHeaders(),
              body: JSON.stringify({ model_name: modelName }),
            }).catch(() => undefined);

            const retry = await fetch(this.managementURL('/load'), {
              method: 'POST',
              headers: this.managementHeaders(),
              body: JSON.stringify({ model_name: modelName }),
            });

            return retry.ok;
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async getDefaultModels(): Promise<ModelList> {
    try {
      const res = await fetch(`${this.config.baseURL}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
      });

      const data = await res.json();

      const models: Model[] = data.data
        .filter((m: any) => m.recipe === 'llamacpp')
        .map((m: any) => {
          return {
            name: m.id,
            key: m.id,
          };
        });

      return {
        embedding: models,
        chat: models,
      };
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error(
          'Error connecting to Lemonade API. Please ensure the base URL is correct and the service is available.',
        );
      }

      throw err;
    }
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...configProvider.embeddingModels,
      ],
      chat: [...defaultModels.chat, ...configProvider.chatModels],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const modelList = await this.getModelList();

    const exists = modelList.chat.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading Lemonade Chat Model. Invalid Model Selected',
      );
    }

    return new LemonadeLLM({
      apiKey: this.config.apiKey || 'not-needed',
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    const modelList = await this.getModelList();
    const exists = modelList.embedding.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading Lemonade Embedding Model. Invalid Model Selected.',
      );
    }

    return new LemonadeEmbedding({
      apiKey: this.config.apiKey || 'not-needed',
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  static parseAndValidate(raw: any): LemonadeConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.baseURL)
      throw new Error('Invalid config provided. Base URL must be provided');

    /* Every key the provider needs has to be listed here: this builds the
     * config object rather than spreading raw, so anything omitted is silently
     * dropped before the instance sees it. */
    return {
      baseURL: String(raw.baseURL),
      apiKey: raw.apiKey ? String(raw.apiKey) : undefined,
      llamacppArgs: raw.llamacppArgs ? String(raw.llamacppArgs) : undefined,
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'lemonade',
      name: 'Lemonade',
    };
  }
}

export default LemonadeProvider;
