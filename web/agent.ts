/**
 * The chat-agent tool loop. Drives the selected LLM over the exposed trundler
 * tools, emitting SSE-friendly events as it goes. Non-streaming per round: the
 * latency is the live tool calls, not token typing.
 */
import { chat, type ChatMessage } from './llm.js';
import { listOpenAiTools, callTool, instructions } from './mcpBridge.js';
import type { WebConfig } from './config.js';

export type Emit = (event: string, data?: Record<string, unknown>) => void;

/** Always-on app context. Location handling (ask vs use saved) is decided by
 *  locationContext() below, so it is intentionally NOT in here. */
const PREAMBLE = [
  '',
  '--- App context ---',
  'You are the assistant behind a local grocery-pricing web app for New Zealand',
  'shoppers. Providers: countdown (Woolworths — searchable without login at the',
  'default store; login only needed for cart/orders and own-store pricing),',
  'newworld and paknsave (per-store — pass a storeId from list_stores),',
  'warehouse (national). compare_list and budget_basket accept at most 5',
  'stores. For newworld/paknsave, ALWAYS pass a storeId to',
  'search_products/get_specials/browse_products/compare_list, and label prices',
  'by the storeId the result echoes — never by the suburb alone. If a',
  'Woolworths/countdown call reports the user is not logged in,',
  'tell them to click the "Log in to Woolworths" button in the app — you cannot',
  'log them in yourself. Keep answers concise and always render product lists as',
  'markdown tables following the formatting rules above.',
].join('\n');

const MAX_ROUNDS = 8;

/** Filler phrases a stalling model emits instead of calling a tool. */
const STALL_RE =
  /\b(wait|moment|hold on|retriev|fetch|look(ing)?\s*up|checking|one\s*sec|give me|shortly|in a bit)\b/i;

/** One completion round, retrying once on a malformed-tool-call format error
 *  (intermittent on Groq's Llama models). Re-throws after the retry. */
async function chatWithRetry(
  settings: WebConfig,
  messages: ChatMessage[],
  tools: Awaited<ReturnType<typeof listOpenAiTools>>,
  emit: Emit,
): Promise<ChatMessage> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chat({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        messages,
        tools,
        onWait: (s) => emit('rate_limited', { seconds: s }),
      });
    } catch (err) {
      if ((err as { toolFormat?: boolean }).toolFormat && attempt === 0) {
        emit('thinking', { tools: ['retrying malformed tool call'] });
        continue;
      }
      throw err;
    }
  }
}

/** Turn the user's saved region / pinned stores into system-prompt guidance.
 *  Explicit stores take precedence over region; if neither is set, ask. */
function locationContext(settings: WebConfig): string {
  if (settings.stores && settings.stores.length > 0) {
    const lines = settings.stores.map((s) => {
      const id = s.storeId ? ` storeId=${s.storeId}` : ' (national — no storeId)';
      return `  - provider=${s.provider}${id}${s.label ? ` (${s.label})` : ''}`;
    });
    return [
      '',
      '--- The user\'s location is ALREADY SET. Do NOT ask for it. ---',
      'The user has pinned the exact stores below. These ARE their location.',
      'NEVER ask for a suburb, town or postcode, and do NOT call list_stores or',
      'offer to add "nearby" branches. Price against EXACTLY these stores:',
      ...lines,
      'For the foodstuffs stores pass the storeId shown above. countdown/',
      'warehouse are national (no storeId). Use compare_list for a list across',
      'them, or search_products with the storeId for a single item. Only use',
      'different stores if the user explicitly names them in their message.',
    ].join('\n');
  }
  if (settings.region && settings.region.trim()) {
    return [
      '',
      '--- The user\'s location is ALREADY SET. Do NOT ask for it. ---',
      `The user's location is "${settings.region.trim()}". NEVER ask for a`,
      'suburb/town/postcode — call list_stores with this region as the query to',
      'find nearby New World / Pak\'nSave branches (pick up to 5), then price with',
      'their storeIds. countdown and warehouse are national.',
    ].join('\n');
  }
  return [
    '',
    '--- Location not set ---',
    'If the user asks for prices "near me" and you do not know their suburb,',
    'town or postcode, ask for it before calling list_stores; meanwhile you may',
    'offer national stores (countdown/warehouse). They can also pin stores in',
    'Settings to skip this.',
  ].join('\n');
}

export async function runAgent(
  history: ChatMessage[],
  settings: WebConfig,
  emit: Emit,
): Promise<void> {
  const tools = await listOpenAiTools();
  const system = (await instructions()) + '\n' + PREAMBLE + '\n' + locationContext(settings);
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history];

  let toolsCalled = 0;
  let nudges = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const assistant = await chatWithRetry(settings, messages, tools, emit);
    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      // A weak model sometimes ends its turn with a "hold on, fetching…"
      // message WITHOUT calling the tool. If nothing has been fetched yet and
      // the text reads like a stall, nudge it to actually run the tools.
      if (toolsCalled === 0 && nudges < 2 && STALL_RE.test(assistant.content ?? '')) {
        nudges++;
        emit('thinking', { tools: ['nudging model to run the tools'] });
        messages.push({
          role: 'user',
          content:
            'Do it now: call the necessary tools and return the actual results in ' +
            'this reply. Do not say you will fetch them or ask the user to wait — fetch them.',
        });
        continue;
      }
      emit('message', { content: assistant.content ?? '' });
      return;
    }

    toolsCalled += calls.length;
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
