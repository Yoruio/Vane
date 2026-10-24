import OpenAILLM from '../openai/openaiLLM';
import { GenerateOptions } from '../../types';

/**
 * Lemonade launches `llama-server` with `--jinja`, which applies chat-template
 * kwargs, and GLM and Qwen templates both read `enable_thinking`. That makes
 * thinking suppressible per request rather than per server.
 *
 * Measured on one writer call (10,136-char prompt, GLM-4.5-Air): thinking
 * roughly doubles wall time -- 57.4s against 25.2s cold, 30.2s against 11.3s
 * on a warm prompt cache. The answers were no worse without it; the thinking
 * in that sample talked itself into attributing an older release's security
 * severity to the version actually being asked about.
 */
class LemonadeLLM extends OpenAILLM {
  protected extraBody(options?: GenerateOptions): Record<string, unknown> {
    if (!options?.disableThinking) return {};

    return { chat_template_kwargs: { enable_thinking: false } };
  }
}

export default LemonadeLLM;
