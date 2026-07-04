import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ProviderRegistry, ShoppingProvider } from '../core/provider.js';
import { buildRegistry, DEFAULT_PROVIDER } from '../providers/index.js';

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }] };
}

const providerArg = {
  provider: z
    .string()
    .optional()
    .describe(`Shopping provider id (default: "${DEFAULT_PROVIDER}").`),
};

export function buildServer(registry: ProviderRegistry = buildRegistry()): McpServer {
  const server = new McpServer({ name: 'trundler', version: '0.1.0' });

  const resolve = (id?: string): ShoppingProvider => registry.get(id ?? DEFAULT_PROVIDER);

  // --- Auth -----------------------------------------------------------------

  server.registerTool(
    'login',
    {
      description:
        'Open a browser window to sign in to a shopping provider. Complete the login in the window; the session is captured and stored locally. Run this once, or again when the session expires.',
      inputSchema: { ...providerArg },
    },
    async ({ provider }) => {
      try {
        const result = await resolve(provider).interactiveLogin();
        return textResult({ loggedIn: true, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'check_login',
    {
      description: 'Check whether the stored session for a provider is still authenticated.',
      inputSchema: { ...providerArg },
    },
    async ({ provider }) => {
      try {
        return textResult(await resolve(provider).checkLogin());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Products -------------------------------------------------------------

  server.registerTool(
    'search_products',
    {
      description: 'Search for products by keyword.',
      inputSchema: {
        query: z.string().describe('Search query, e.g. "eggs", "jasmine rice".'),
        maxProducts: z.number().optional().describe('Max products to return (default: 48).'),
        inStockOnly: z.boolean().optional().describe('Only in-stock items (default: false).'),
        specialsOnly: z
          .boolean()
          .optional()
          .describe('Only items on special or multi-buy (default: false).'),
        ...providerArg,
      },
    },
    async ({ query, maxProducts, inStockOnly, specialsOnly, provider }) => {
      try {
        return textResult(
          await resolve(provider).searchProducts(query, { maxProducts, inStockOnly, specialsOnly }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_specials',
    {
      description: 'Get current specials/deals with automatic pagination.',
      inputSchema: {
        maxProducts: z.number().optional().describe('Max products to return (default: all).'),
        pageSize: z.number().optional().describe('Products per API request (default: 120, max 120).'),
        ...providerArg,
      },
    },
    async ({ maxProducts, pageSize, provider }) => {
      try {
        return textResult(await resolve(provider).getSpecials({ maxProducts, pageSize }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'browse_products',
    {
      description:
        'Browse products by department. Departments: fruit-veg, meat-poultry, fish-seafood, fridge-deli, bakery, frozen, pantry, beer-wine, drinks, health-body, household, baby-child, pet.',
      inputSchema: {
        department: z.string().describe('Department slug, e.g. "fruit-veg".'),
        aisle: z.string().optional().describe('Aisle filter, e.g. "fresh-deals".'),
        specialsOnly: z.boolean().optional().describe('Only specials (default: false).'),
        maxProducts: z.number().optional().describe('Max products to return (default: all).'),
        pageSize: z.number().optional().describe('Products per API request (default: 120).'),
        ...providerArg,
      },
    },
    async ({ department, aisle, specialsOnly, maxProducts, pageSize, provider }) => {
      try {
        return textResult(
          await resolve(provider).browseProducts(department, {
            aisle,
            specialsOnly,
            maxProducts,
            pageSize,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Cart -----------------------------------------------------------------

  const unitArg = z.enum(['Each', 'Kg']).optional().describe('Pricing unit (default: Each).');

  server.registerTool(
    'cart_get',
    { description: 'Get current cart contents and totals.', inputSchema: { ...providerArg } },
    async ({ provider }) => {
      try {
        return textResult(await resolve(provider).cartGet());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cart_add',
    {
      description: 'Add an item to the cart.',
      inputSchema: {
        sku: z.string().describe('Product SKU.'),
        quantity: z.number().optional().describe('Quantity (default: 1).'),
        unit: unitArg,
        ...providerArg,
      },
    },
    async ({ sku, quantity, unit, provider }) => {
      try {
        return textResult(await resolve(provider).cartAdd(sku, quantity ?? 1, unit ?? 'Each'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cart_update',
    {
      description: 'Update the quantity of an item in the cart.',
      inputSchema: {
        sku: z.string().describe('Product SKU.'),
        quantity: z.number().describe('New quantity (must be > 0; use cart_remove to remove).'),
        unit: unitArg,
        ...providerArg,
      },
    },
    async ({ sku, quantity, unit, provider }) => {
      try {
        if (quantity <= 0) {
          return errorResult(new Error('Quantity must be > 0. Use cart_remove to remove items.'));
        }
        return textResult(await resolve(provider).cartUpdate(sku, quantity, unit ?? 'Each'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cart_remove',
    {
      description: 'Remove an item from the cart.',
      inputSchema: { sku: z.string().describe('Product SKU.'), unit: unitArg, ...providerArg },
    },
    async ({ sku, unit, provider }) => {
      try {
        return textResult(await resolve(provider).cartRemove(sku, unit ?? 'Each'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Past orders ----------------------------------------------------------

  server.registerTool(
    'list_past_orders',
    {
      description: 'List past orders with dates, totals, and status. Requires login.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Time filter: days-30, days-180, year-2025, all (default: days-180).'),
        ...providerArg,
      },
    },
    async ({ filter, provider }) => {
      try {
        return textResult(await resolve(provider).listPastOrders(filter));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_past_order_items',
    {
      description: 'List products from past orders, sorted by purchase frequency. Requires login.',
      inputSchema: {
        page: z.number().optional().describe('Page number (default: 1).'),
        sort: z.enum(['Frequency', 'Name', 'Price']).optional().describe('Sort order.'),
        maxPages: z.number().optional().describe('Max pages to fetch (default: 1).'),
        ...providerArg,
      },
    },
    async ({ page, sort, maxPages, provider }) => {
      try {
        return textResult(await resolve(provider).listPastOrderItems({ page, sort, maxPages }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_order_items',
    {
      description: 'Get all items from a specific past order. Requires login.',
      inputSchema: { orderId: z.string().describe('The order ID.'), ...providerArg },
    },
    async ({ orderId, provider }) => {
      try {
        return textResult(await resolve(provider).getOrderItems(orderId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
