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
}

/** One completion round. Returns the assistant message (may contain tool_calls). */
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

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
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

  const json = (await res.json()) as {
    choices?: Array<{ message?: ChatMessage }>;
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error('LLM returned no message');
  return message;
}
