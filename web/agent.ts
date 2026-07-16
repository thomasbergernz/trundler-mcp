/**
 * The chat-agent tool loop. Drives the selected LLM over the exposed trundler
 * tools, emitting SSE-friendly events as it goes. Non-streaming per round: the
 * latency is the live tool calls, not token typing.
 */
import { chat, type ChatMessage } from './llm.js';
import { listOpenAiTools, callTool, instructions } from './mcpBridge.js';
import type { WebConfig } from './config.js';

export type Emit = (event: string, data?: Record<string, unknown>) => void;

/** Reproduces the session's behaviour: ask for location first, cap at 5 stores. */
const PREAMBLE = [
  '',
  '--- App context ---',
  'You are the assistant behind a local grocery-pricing web app for New Zealand',
  'shoppers. Providers: countdown (Woolworths, national, needs login),',
  'newworld and paknsave (per-store — call list_stores and pass a storeId),',
  'warehouse (national). If the user asks for prices "near me" or "close to me"',
  'and you do not yet know their suburb, town or postcode, ASK for it before',
  'calling list_stores; meanwhile you may offer to price national stores',
  '(countdown/warehouse). compare_list and budget_basket accept at most 5',
  'stores. If a Woolworths/countdown call reports the user is not logged in,',
  'tell them to click the "Log in to Woolworths" button in the app — you cannot',
  'log them in yourself. Keep answers concise and always render product lists as',
  'markdown tables following the formatting rules above.',
].join('\n');

const MAX_ROUNDS = 8;

export async function runAgent(
  history: ChatMessage[],
  settings: WebConfig,
  emit: Emit,
): Promise<void> {
  const tools = await listOpenAiTools();
  const system = (await instructions()) + '\n' + PREAMBLE;
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const assistant = await chat({
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model,
      messages,
      tools,
    });
    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      emit('message', { content: assistant.content ?? '' });
      return;
    }

    emit('thinking', { tools: calls.map((c) => c.function.name) });

    for (const tc of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      emit('tool_call', { name: tc.function.name, args });

      const { text, isError } = await callTool(tc.function.name, args);
      emit('tool_result', {
        name: tc.function.name,
        isError,
        preview: text.slice(0, 2000),
      });
      if (isError && /log ?in|logged in|login tool|not logged/i.test(text)) {
        emit('login_required', {});
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: text,
      });
    }
  }

  emit('message', {
    content: 'I stopped after several tool calls without finishing — please refine or narrow the request.',
  });
}
