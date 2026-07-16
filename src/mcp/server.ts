import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { budgetBasket } from '../core/budgetBasket.js';
import { compareList } from '../core/compareList.js';
import type { ProviderRegistry, ShoppingProvider } from '../core/provider.js';
import { getList, saveList } from '../core/shoppingList.js';
import { buildRegistry, DEFAULT_PROVIDER } from '../providers/index.js';

// Report the real package version (../../package.json relative to this file at
// both src/mcp/server.ts and dist/mcp/server.js) so the MCP handshake never lies.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

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
  const server = new McpServer(
    { name: 'trundler', version },
    {
      instructions: [
        'When presenting a list of products to the user (from search_products, get_specials,',
        'browse_products, or past-order tools), format it for easy shopping:',
        '',
        '- Prefix each product with a capital letter label in order: A, B, C, ... (continue',
        '  to AA, AB, ... past Z). The label lets the shopper say "two of A, one of C" when',
        '  choosing quantities, so keep the labels stable within a single list.',
        '- Show the price per unit whenever the data allows it. Products carry `unitPrice` and',
        '  `unitMeasure` fields (e.g. $2.50 / 100g, $1.20 / kg, $0.45 / ea) — display this',
        '  alongside the pack price so different pack sizes can be compared directly.',
        '- Sort the list by price per unit, cheapest first (lowest `unitPrice` at the top).',
        '  `unitMeasure` can differ between products (per 100g vs per kg vs per ea); normalise',
        '  to a common measure before comparing (e.g. $/kg) so the ranking is meaningful, and',
        '  only rank products against others in the same measure family (weight vs volume vs',
        '  each). Products missing a comparable unit price go last, after the sorted ones.',
        '',
        '- Include a link column so the shopper can open each item to see its photo and full',
        '  detail. Use the `productUrl` field as a compact clickable link (e.g. a markdown',
        '  link labelled "view" or "photo"); if `productUrl` is absent, fall back to the',
        '  `image` field, which is a direct URL to the product photo.',
        '',
        'Also include the product name, pack size, and pack price so the shopper has full',
        'context. This ordering and labelling applies to any product listing you show.',
        '',
        'PER-STORE PRICING (newworld / paknsave):',
        '',
        '- These banners price per branch. `search_products`, `get_specials` and `browse_products`',
        '  take an optional `storeId` — for a query about a specific branch, resolve it with',
        '  `list_stores` (filter by suburb) and PASS that `storeId`. If you omit it, the persisted',
        '  default store is used, which may be a different branch than the shopper means.',
        '- Every Foodstuffs product list echoes the `storeId` it was priced at. Label the store',
        '  from THAT returned `storeId` (match it back to list_stores) — never assume the branch',
        '  from the suburb the shopper mentioned. countdown and warehouse are national (no storeId).',
        '',
        'MULTI-STORE PRICE COMPARISON (price a list across nearby stores):',
        '',
        '- Use `list_stores` to find New World / Pak\'nSave branches — filter by suburb or town',
        '  (e.g. "gate pa"), not just the store name. Each store carries its suburb and',
        '  latitude/longitude. Let the shopper pick up to 5 stores to compare.',
        '- Then call `compare_list` with the shopping list and those stores. Foodstuffs stores',
        '  (newworld/paknsave) need a `storeId`; `countdown` (requires login) and `warehouse`',
        '  are national — no storeId. The result gives each store\'s matched product + price per',
        '  item, a per-store basket subtotal, coverage, the cheapest store per item, and the',
        '  cheapest full-basket store.',
        '- Matches are the top keyword hit, NOT barcode-exact. Check the product names against',
        '  what the shopper meant; if one is wrong, refine that item\'s query or pick from the',
        '  `alternates`. Report any `not-found` items and any `unavailable` store (e.g. Countdown',
        '  when not logged in) rather than hiding them.',
        '- `save_list` / `get_list` store the shopper\'s regular list so it can be reused and fed',
        '  straight into `compare_list`.',
        '',
        'BUDGET SPECIALS BASKET ("what can $X buy to feed people"):',
        '',
        '- Use `budget_basket` with the shopper\'s stores and a budget (default $100). It returns a',
        '  best-value basket of current specials that fills the budget across categories, cheapest',
        '  store per item. It does NOT know how many people it feeds — YOU estimate servings/meals',
        '  from the item names, pack sizes and quantities, group items into meals, and adjust',
        '  quantities or swap items to cover the number of people the shopper named. Call out the',
        '  total, the leftover, and any skipped (unavailable) store.',
        '',
        'DELEGATED SHOPPING (building a cart from a list, Countdown only):',
        '',
        '- To restock a usual shop, prefer `reorder_usuals` — it adds the shopper\'s most',
        '  frequently bought in-stock items directly (exact SKUs they actually buy), which is',
        '  more accurate than searching by name.',
        '- For a free-text list, resolve each line with `search_products`, then add the chosen',
        '  SKUs in one `cart_add_many` call. When a line is ambiguous (many sizes/brands) or is a',
        '  new item the shopper has not bought before, show the top candidate(s) and confirm the',
        '  choice before adding. Never silently guess an expensive or wrong item.',
        '- Use `cart_clear` to reset the trolley before rebuilding it to match a list.',
        '- After building the cart, present a review: items added, any that failed or were out of',
        '  stock (report these — never drop them silently), the total, and the `reviewUrl`.',
        '',
        'HARD BOUNDARY — the shopper always finishes checkout themselves:',
        '',
        '- You may fill the trolley. You must NOT select or reserve a delivery/pickup slot, submit',
        '  checkout, place the order, or handle payment. There are deliberately no tools for those.',
        '- Your job ends at "trolley filled + here is your review and the link to finish". Direct',
        '  the shopper to the `reviewUrl` to choose a time and pay in their own browser.',
        '- Adding items to a cart spends nothing, but still confirm with the shopper before adding',
        '  anything beyond what they asked for.',
      ].join('\n'),
    },
  );

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
        storeId: z
          .string()
          .optional()
          .describe(
            'For per-store providers (newworld/paknsave): the store to price at, from list_stores. ' +
              'If omitted, the persisted/default store is used — pass it explicitly to avoid ' +
              'pricing the wrong branch. The result echoes the storeId actually used.',
          ),
        ...providerArg,
      },
    },
    async ({ query, maxProducts, inStockOnly, specialsOnly, storeId, provider }) => {
      try {
        return textResult(
          await resolve(provider).searchProducts(query, {
            maxProducts,
            inStockOnly,
            specialsOnly,
            storeId,
          }),
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
        storeId: z
          .string()
          .optional()
          .describe(
            'For per-store providers (newworld/paknsave): the store to price at, from list_stores. ' +
              'If omitted, the persisted/default store is used. The result echoes the storeId used.',
          ),
        ...providerArg,
      },
    },
    async ({ maxProducts, pageSize, storeId, provider }) => {
      try {
        return textResult(await resolve(provider).getSpecials({ maxProducts, pageSize, storeId }));
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
        storeId: z
          .string()
          .optional()
          .describe(
            'For per-store providers (newworld/paknsave): the store to price at, from list_stores. ' +
              'If omitted, the persisted/default store is used. The result echoes the storeId used.',
          ),
        ...providerArg,
      },
    },
    async ({ department, aisle, specialsOnly, maxProducts, pageSize, storeId, provider }) => {
      try {
        return textResult(
          await resolve(provider).browseProducts(department, {
            aisle,
            specialsOnly,
            maxProducts,
            pageSize,
            storeId,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Store selection (per-store-pricing providers, e.g. New World) --------

  server.registerTool(
    'list_stores',
    {
      description:
        'List a provider\'s stores (for providers with per-store pricing, e.g. New World). ' +
        'Optionally filter by name, suburb, town or region. Stores include suburb and ' +
        'latitude/longitude. Use set_store to pick one, or pass store ids to compare_list.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Filter by name/suburb/town/region, e.g. "gate pa", "auckland".'),
        ...providerArg,
      },
    },
    async ({ query, provider }) => {
      try {
        const p = resolve(provider);
        if (!p.listStores) throw new Error(`${p.name} does not use per-store selection.`);
        return textResult(await p.listStores(query));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'set_store',
    {
      description:
        'Select the active store for a provider with per-store pricing. Persisted for future ' +
        'calls. Get store ids from list_stores.',
      inputSchema: { storeId: z.string().describe('Store id from list_stores.'), ...providerArg },
    },
    async ({ storeId, provider }) => {
      try {
        const p = resolve(provider);
        if (!p.setStore) throw new Error(`${p.name} does not use per-store selection.`);
        return textResult(await p.setStore(storeId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Multi-store comparison + saved list ----------------------------------

  const listItemsSchema = z
    .array(
      z.object({
        query: z.string().describe('Item search keyword, e.g. "milk 2L", "free range eggs 12".'),
        quantity: z.number().optional().describe('Quantity of the matched product (default: 1).'),
      }),
    )
    .describe('The shopping list.');

  server.registerTool(
    'compare_list',
    {
      description:
        'Price a shopping list across up to 5 stores and compare. For each item at each store ' +
        'it returns the top matching product and price, plus each store\'s basket subtotal, ' +
        'coverage, the cheapest store per item, and the cheapest full-basket store. Foodstuffs ' +
        'stores (newworld/paknsave) need a storeId from list_stores; countdown (requires login) ' +
        'and warehouse are national. Matches are relevance-based, not barcode-exact — verify ' +
        'names and use each item\'s `alternates` to substitute. A store that cannot be priced ' +
        'is returned as an `unavailable` column, never an error.',
      inputSchema: {
        items: listItemsSchema,
        stores: z
          .array(
            z.object({
              provider: z
                .string()
                .describe('Provider id: newworld, paknsave, countdown, or warehouse.'),
              storeId: z
                .string()
                .optional()
                .describe('Store id (required for newworld/paknsave; from list_stores).'),
              label: z.string().optional().describe('Optional display label for this column.'),
            }),
          )
          .max(5)
          .describe('Up to 5 stores to compare.'),
      },
    },
    async ({ items, stores }) => {
      try {
        return textResult(await compareList(registry, items, stores));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const storesSchema = z
    .array(
      z.object({
        provider: z.string().describe('Provider id: newworld, paknsave, countdown, or warehouse.'),
        storeId: z
          .string()
          .optional()
          .describe('Store id (required for newworld/paknsave; from list_stores).'),
        label: z.string().optional().describe('Optional display label.'),
      }),
    )
    .max(5);

  server.registerTool(
    'budget_basket',
    {
      description:
        'Suggest a best-value basket of current SPECIALS that fills a budget (default $100) ' +
        'without exceeding it, pooling specials across up to 5 stores and keeping the cheapest ' +
        'store per item, balanced across categories (cheapest per-unit first). Returns the ' +
        'basket, total, leftover, and a per-category breakdown. It does NOT estimate how many ' +
        'people it feeds — reason about servings from the item names/sizes and adjust ' +
        'quantities or swap items to suit the number of people. Foodstuffs stores need a ' +
        'storeId; countdown needs login; a store that cannot be priced is skipped.',
      inputSchema: {
        stores: storesSchema.describe('Up to 5 stores to pull specials from.'),
        budget: z.number().optional().describe('Target spend in dollars (default: 100).'),
        maxItems: z.number().optional().describe('Max distinct items in the basket (default: 40).'),
        excludeCategories: z
          .array(z.string())
          .optional()
          .describe(
            'Category substrings to drop (default: non-food aisles like household, pet, ' +
              'health & body, baby, alcohol). Pass [] to include every category.',
          ),
      },
    },
    async ({ stores, budget, maxItems, excludeCategories }) => {
      try {
        return textResult(await budgetBasket(registry, stores, { budget, maxItems, excludeCategories }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'save_list',
    {
      description:
        "Save the shopper's regular shopping list (item keywords + quantities) for reuse. " +
        'Overwrites any previous list. Retrieve it with get_list and feed it to compare_list.',
      inputSchema: { items: listItemsSchema },
    },
    async ({ items }) => {
      try {
        return textResult(await saveList(items));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_list',
    {
      description: "Get the shopper's saved regular shopping list (empty if none saved yet).",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await getList());
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

  // --- Batch cart / delegation ----------------------------------------------
  // These fill the trolley in one call. They never book a slot or pay — the
  // result carries a `reviewUrl` the shopper opens to finish checkout themselves.

  server.registerTool(
    'cart_add_many',
    {
      description:
        'Add several items to the cart in one call (for building a whole shop). Returns a ' +
        "per-item outcome, the cart totals, and a reviewUrl where the shopper reviews and " +
        'completes checkout themselves. Does NOT book a delivery slot or pay.',
      inputSchema: {
        items: z
          .array(
            z.object({
              sku: z.string().describe('Product SKU.'),
              quantity: z.number().optional().describe('Quantity (default: 1).'),
              unit: z.enum(['Each', 'Kg']).optional().describe('Pricing unit (default: Each).'),
            }),
          )
          .describe('Items to add.'),
        ...providerArg,
      },
    },
    async ({ items, provider }) => {
      try {
        const p = resolve(provider);
        if (!p.cartAddMany) throw new Error(`${p.name} does not support batch cart operations.`);
        const normalized = items.map((i) => ({
          sku: i.sku,
          quantity: i.quantity ?? 1,
          unit: i.unit ?? 'Each',
        }));
        return textResult(await p.cartAddMany(normalized));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cart_clear',
    {
      description:
        'Remove every item from the cart (e.g. to reset the trolley before rebuilding it from a ' +
        'list). Returns the per-item outcome and empty totals.',
      inputSchema: { ...providerArg },
    },
    async ({ provider }) => {
      try {
        const p = resolve(provider);
        if (!p.cartClear) throw new Error(`${p.name} does not support batch cart operations.`);
        return textResult(await p.cartClear());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'reorder_usuals',
    {
      description:
        "Add the shopper's most frequently purchased in-stock items to the cart in one call — " +
        'the fastest way to restock a usual shop. Returns the per-item outcome, cart totals, and ' +
        'a reviewUrl for the shopper to finish checkout. Does NOT book a slot or pay.',
      inputSchema: {
        maxItems: z.number().optional().describe('How many top items to add (default: 20).'),
        ...providerArg,
      },
    },
    async ({ maxItems, provider }) => {
      try {
        const p = resolve(provider);
        if (!p.reorderUsuals) throw new Error(`${p.name} does not support reordering usuals.`);
        return textResult(await p.reorderUsuals(maxItems ?? 20));
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
