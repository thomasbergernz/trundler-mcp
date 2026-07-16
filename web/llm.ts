/**
 * Minimal OpenAI-compatible chat client for Groq and OpenRouter. No SDK — both
 * accept the same `/chat/completions` shape with `tools` for function calling.
 */
import type { LlmProvider } from './config.js';
import type { OpenAiTool } from './mcpBridge.js';

const BASE_URLS: Record<LlmProvider, string> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatParams {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: OpenAiTool[];
  /** Called before waiting out a rate-limit (429) so the UI can show it. */
  onWait?: (seconds: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds to wait after a 429, from the retry-after header or the body hint. */
function retryDelay(header: string | null, body: string): number {
  const h = header ? Number(header) : NaN;
  if (Number.isFinite(h) && h > 0) return Math.min(h, 30);
  const m = body.match(/try again in ([\d.]+)s/i);
  if (m) return Math.min(Number(m[1]) + 0.5, 30);
  return 8;
}

/** One completion round. Returns the assistant message (may contain tool_calls).
 *  Backs off and retries on 429 (free-tier tokens-per-minute limits). */
export async function chat(params: ChatParams): Promise<ChatMessage> {
  const base = BASE_URLS[params.provider];
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature: 0.2,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
        // OpenRouter likes these; harmless for Groq.
        'HTTP-Referer': 'http://127.0.0.1',
        'X-Title': 'trundler-web',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error('LLM returned no message');
      return message;
    }

    const detail = await res.text().catch(() => '');

    // Free-tier tokens-per-minute limit — wait out the window and retry.
    if (res.status === 429 && attempt < 4) {
      const wait = retryDelay(res.headers.get('retry-after'), detail);
      params.onWait?.(wait);
      await sleep(wait * 1000);
      continue;
    }

    // Groq returns 400 tool_use_failed when the model emits a tool call in the
    // Llama `<function=name {json}>` text format its validator can't parse. It
    // is intermittent — the caller retries once, then surfaces a clear hint.
    if (/tool_use_failed/.test(detail)) {
      const e = new Error(
        `The model "${params.model}" produced a malformed tool call. ` +
          `Try a model with cleaner tool calling (e.g. openai/gpt-oss-20b on Groq) in Settings.`,
      );
      (e as { toolFormat?: boolean }).toolFormat = true;
      throw e;
    }
    throw new Error(`LLM ${params.provider} ${res.status}: ${detail.slice(0, 500)}`);
  }
}
