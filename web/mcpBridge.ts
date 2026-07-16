/**
 * In-process bridge to the trundler MCP server.
 *
 * We boot the real `buildServer(registry)` and connect an MCP `Client` to it
 * over a linked in-memory transport pair. This gives us the tool JSON Schemas
 * (already converted from Zod by the SDK) and the curated presentation
 * instructions verbatim — no duplication of `src/mcp/server.ts`.
 *
 * The SDK Client/InMemoryTransport are imported via bare specifier so they
 * resolve to the SAME @modelcontextprotocol/sdk copy in the repo-root
 * node_modules that the parent's Server uses (web/ intentionally does not
 * depend on the SDK, so there is a single instance and the transport pair is
 * type-compatible).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, buildRegistry, ProviderRegistry } from '../src/lib.js';

/** Tools the LLM is allowed to call. Deliberately excludes `login` (headed
 *  browser — an explicit user action), all cart_* writes, set_store,
 *  reorder_usuals and order-history tools. */
const EXPOSED_TOOLS = new Set([
  'search_products',
  'get_specials',
  'browse_products',
  'list_stores',
  'compare_list',
  'budget_basket',
  'save_list',
  'get_list',
  'check_login',
]);

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

interface Bridge {
  client: Client;
  registry: ProviderRegistry;
}

let bridgePromise: Promise<Bridge> | null = null;

async function getBridge(): Promise<Bridge> {
  if (!bridgePromise) {
    bridgePromise = (async () => {
      const registry = buildRegistry();
      const server = buildServer(registry);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'trundler-web', version: '0.1.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return { client, registry };
    })();
  }
  return bridgePromise;
}

/** The shared provider registry (same instance the MCP server uses). */
export async function getRegistry(): Promise<ProviderRegistry> {
  return (await getBridge()).registry;
}

/** Exposed tools as OpenAI-compatible function specs. */
export async function listOpenAiTools(): Promise<OpenAiTool[]> {
  const { client } = await getBridge();
  const { tools } = await client.listTools();
  return tools
    .filter((t) => EXPOSED_TOOLS.has(t.name))
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
}

/** Call a tool and return its text payload (JSON string). Tool errors are
 *  returned as text, not thrown, so the LLM can react (e.g. prompt for login). */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  if (!EXPOSED_TOOLS.has(name)) {
    return { text: `Tool "${name}" is not available in this app.`, isError: true };
  }
  const { client } = await getBridge();
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  return { text: text || '(no output)', isError: Boolean(res.isError) };
}

/** The server's presentation instructions, used as the LLM system prompt. */
export async function instructions(): Promise<string> {
  const { client } = await getBridge();
  return client.getInstructions() ?? FALLBACK_INSTRUCTIONS;
}

const FALLBACK_INSTRUCTIONS = [
  'You help shoppers price groceries across NZ stores. When listing products,',
  'label each A, B, C…, show price per unit (unitPrice/unitMeasure), sort',
  'cheapest-per-unit first, and include a productUrl link. For multi-store',
  'comparison use list_stores then compare_list (max 5 stores).',
].join(' ');
