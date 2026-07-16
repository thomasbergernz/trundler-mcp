import type { ProviderRegistry } from './provider.js';
import type { Product } from './types.js';

/** One line of the shopping list to price. */
export interface CompareItem {
  /** Search keyword, e.g. "milk 2L", "free range eggs 12". */
  query: string;
  /** How many of the matched product (default 1). */
  quantity?: number;
}

/** One store to price the list at. For per-store-pricing providers (New World,
 *  Pak'nSave) a `storeId` is required; national providers (countdown, warehouse)
 *  ignore it. */
export interface StoreSelector {
  provider: string;
  storeId?: string;
  /** Optional display label; defaults to the provider name (+ store id). */
  label?: string;
}

/** The product chosen (or offered) for an item at a store. */
export interface MatchInfo {
  sku: string;
  name: string;
  brand?: string;
  price?: number;
  unitPrice?: number;
  unitMeasure?: string;
  isSpecial?: boolean;
  productUrl?: string;
}

export interface ItemAtStore {
  status: 'found' | 'not-found';
  /** Best relevance-ranked match (top result); may lack a price. */
  match?: MatchInfo;
  /** Up to 2 further candidates, so the caller can substitute a better match. */
  alternates?: MatchInfo[];
}

export interface StoreColumn {
  provider: string;
  storeId?: string;
  label: string;
  status: 'ok' | 'unavailable';
  /** Why the store could not be priced (e.g. not logged in, no store selected). */
  reason?: string;
  /** Keyed by item query. */
  items: Record<string, ItemAtStore>;
  /** Σ (match price × quantity) over priced items. */
  subtotal?: number;
  coverage: { found: number; total: number };
}

export interface CompareResult {
  items: CompareItem[];
  stores: StoreColumn[];
  /** Cheapest store per item (only stores that priced it). */
  cheapestPerItem: Record<string, { label: string; price: number } | null>;
  /** Cheapest full-basket store among those that priced every item; null if none. */
  cheapestOverall: { label: string; subtotal: number } | null;
  note: string;
}

export interface CompareOptions {
  /** Candidates fetched per item per store (default 5). */
  candidatesPerItem?: number;
}

const MAX_STORES = 5;
const NOTE =
  'Matches are relevance-based, not barcode-exact — each store\'s top hit for the query. ' +
  'Sanity-check names/sizes; refine a query or pick an item from `alternates` if a match is wrong.';

/**
 * Price a shopping list across up to 5 stores and compare. Fans out
 * `searchProducts` per item per store (per-call store override for Foodstuffs),
 * picks the top match, and computes per-store subtotals, coverage, the cheapest
 * store per item, and the cheapest full-basket store. A store that errors
 * (e.g. Countdown not logged in) becomes an `unavailable` column rather than
 * failing the whole comparison.
 */
export async function compareList(
  registry: ProviderRegistry,
  items: CompareItem[],
  stores: StoreSelector[],
  opts: CompareOptions = {},
): Promise<CompareResult> {
  if (!items.length) throw new Error('compareList: `items` is empty.');
  if (!stores.length) throw new Error('compareList: `stores` is empty.');
  if (stores.length > MAX_STORES) {
    throw new Error(`compareList: at most ${MAX_STORES} stores (got ${stores.length}).`);
  }
  const perItem = opts.candidatesPerItem ?? 5;

  const columns = await Promise.all(
    stores.map((sel) => priceStore(registry, items, sel, perItem)),
  );

  // Cheapest store per item (only ok columns that priced the item).
  const cheapestPerItem: CompareResult['cheapestPerItem'] = {};
  for (const item of items) {
    let best: { label: string; price: number } | null = null;
    for (const col of columns) {
      if (col.status !== 'ok') continue;
      const price = col.items[item.query]?.match?.price;
      if (typeof price === 'number' && (!best || price < best.price)) {
        best = { label: col.label, price };
      }
    }
    cheapestPerItem[item.query] = best;
  }

  // Cheapest full-coverage basket.
  let cheapestOverall: CompareResult['cheapestOverall'] = null;
  for (const col of columns) {
    if (col.status !== 'ok' || col.subtotal === undefined) continue;
    if (col.coverage.found < col.coverage.total) continue; // partial baskets aren't comparable
    if (!cheapestOverall || col.subtotal < cheapestOverall.subtotal) {
      cheapestOverall = { label: col.label, subtotal: col.subtotal };
    }
  }

  return { items, stores: columns, cheapestPerItem, cheapestOverall, note: NOTE };
}

async function priceStore(
  registry: ProviderRegistry,
  items: CompareItem[],
  sel: StoreSelector,
  perItem: number,
): Promise<StoreColumn> {
  const label = sel.label ?? (sel.storeId ? `${sel.provider}:${sel.storeId}` : sel.provider);
  const base: StoreColumn = {
    provider: sel.provider,
    storeId: sel.storeId,
    label,
    status: 'ok',
    items: {},
    coverage: { found: 0, total: items.length },
  };

  let provider;
  try {
    provider = registry.get(sel.provider);
  } catch (err) {
    return { ...base, status: 'unavailable', reason: message(err) };
  }
  if (sel.label === undefined) base.label = sel.storeId ? `${provider.name} (${sel.storeId})` : provider.name;

  let subtotal = 0;
  let found = 0;
  let errors = 0;
  let firstError: string | undefined;
  for (const item of items) {
    let list;
    try {
      list = await provider.searchProducts(item.query, {
        maxProducts: perItem,
        storeId: sel.storeId,
      });
    } catch (err) {
      // A per-item error (transient site hiccup, or a store-level failure such as
      // not-logged-in that will repeat for every item) → record and continue.
      errors++;
      firstError ??= message(err);
      base.items[item.query] = { status: 'not-found' };
      continue;
    }
    const { best, alternates } = pickMatch(list.products);
    if (best) {
      base.items[item.query] = { status: 'found', match: toMatch(best), alternates: alternates.map(toMatch) };
      if (typeof best.price === 'number') {
        subtotal += best.price * (item.quantity ?? 1);
        found++;
      }
    } else {
      base.items[item.query] = { status: 'not-found' };
    }
  }

  // Every item errored → the store itself is unavailable (e.g. not logged in),
  // not merely missing products. A partial failure stays an `ok` column.
  if (errors === items.length) {
    return { ...base, status: 'unavailable', reason: firstError };
  }
  base.coverage = { found, total: items.length };
  base.subtotal = Math.round(subtotal * 100) / 100;
  return base;
}

/** Pick the top relevance-ranked, priced, in-stock match plus up to 2 alternates. */
function pickMatch(products: Product[]): { best?: Product; alternates: Product[] } {
  if (!products.length) return { alternates: [] };
  const priced = products.filter((p) => typeof p.price === 'number');
  const pool = priced.length ? priced : products;
  const inStock = pool.filter((p) => p.inStock !== false);
  const ranked = inStock.length ? inStock : pool;
  const [best, ...rest] = ranked;
  return { best, alternates: rest.slice(0, 2) };
}

function toMatch(p: Product): MatchInfo {
  return {
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    price: p.price,
    unitPrice: p.unitPrice,
    unitMeasure: p.unitMeasure,
    isSpecial: p.isSpecial,
    productUrl: p.productUrl,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
