import type { StoreSelector } from './compareList.js';
import type { ProviderRegistry } from './provider.js';
import type { Product } from './types.js';

export interface BudgetBasketOptions {
  /** Target spend in dollars (default 100). The basket total never exceeds it. */
  budget?: number;
  /** Max distinct items in the basket (default 40). */
  maxItems?: number;
  /** Specials fetched per store before merging (default 150). */
  perStoreSpecials?: number;
  /**
   * Category substrings to drop (case-insensitive), so a "feed people" basket
   * stays edible. Defaults to obvious non-food aisles (household, pet, health &
   * body, baby, alcohol, tobacco). Pass `[]` to include every category.
   */
  excludeCategories?: string[];
}

const DEFAULT_EXCLUDE = [
  'household', 'clean', 'pet', 'health', 'body', 'baby', 'toddler',
  'beer', 'wine', 'cider', 'liquor', 'alcohol', 'tobacco', 'magazine', 'flower',
];

/** A chosen basket line. */
export interface BasketItem {
  sku: string;
  name: string;
  brand?: string;
  price: number;
  unitPrice?: number;
  unitMeasure?: string;
  savingsPercent?: number;
  category: string;
  /** The store this item is cheapest at. */
  store: string;
  productUrl?: string;
}

export interface BasketStoreStatus {
  label: string;
  status: 'ok' | 'unavailable';
  reason?: string;
  /** Specials pulled from this store (before cross-store dedupe). */
  specials?: number;
}

export interface BudgetBasketResult {
  budget: number;
  total: number;
  leftover: number;
  itemCount: number;
  stores: BasketStoreStatus[];
  basket: BasketItem[];
  /** Item count + spend per category. */
  byCategory: Record<string, { items: number; spend: number }>;
  note: string;
}

const MAX_STORES = 5;
const NOTE =
  'A best-value basket of current specials filling the budget, balanced across categories ' +
  '(cheapest per unit first, deduped to the cheapest store per item). It does NOT estimate ' +
  'how many people it feeds — reason about servings/meals from the item names, sizes and ' +
  'quantities, and adjust quantities or swap items to suit the number of people.';

/**
 * Assemble a best-value basket of current specials that fills a budget without
 * exceeding it, pooling specials across up to 5 stores and keeping the cheapest
 * store for each item. Items are bucketed by category and picked round-robin
 * (cheapest per-unit first within each) so the basket stays balanced rather than
 * dumping the whole budget into one aisle. A store that errors (e.g. Countdown
 * not logged in, or no Foodstuffs store selected) is skipped, not fatal.
 */
export async function budgetBasket(
  registry: ProviderRegistry,
  stores: StoreSelector[],
  opts: BudgetBasketOptions = {},
): Promise<BudgetBasketResult> {
  if (!stores.length) throw new Error('budgetBasket: `stores` is empty.');
  if (stores.length > MAX_STORES) {
    throw new Error(`budgetBasket: at most ${MAX_STORES} stores (got ${stores.length}).`);
  }
  const budget = opts.budget ?? 100;
  const maxItems = opts.maxItems ?? 40;
  const perStore = opts.perStoreSpecials ?? 150;
  const exclude = (opts.excludeCategories ?? DEFAULT_EXCLUDE).map((s) => s.toLowerCase());

  // 1. Gather specials from every store (skip stores that can't be priced).
  const gathered = await Promise.all(
    stores.map((sel) => gatherSpecials(registry, sel, perStore)),
  );
  const storeStatus: BasketStoreStatus[] = gathered.map((g) => g.status);

  // 2. Pool candidates, keep only priced specials, dedupe across stores to the
  //    cheapest offering of each distinct item.
  const byKey = new Map<string, BasketItem>();
  for (const g of gathered) {
    for (const p of g.products) {
      if (!p.isSpecial || typeof p.price !== 'number') continue;
      const cand = toBasketItem(p, g.status.label);
      if (exclude.some((x) => cand.category.includes(x))) continue; // drop non-food aisles
      const key = dedupeKey(p);
      const existing = byKey.get(key);
      if (!existing || cand.price < existing.price) byKey.set(key, cand);
    }
  }

  // 3. Bucket by category, best value (lowest unit price, then price) first.
  const buckets = new Map<string, BasketItem[]>();
  for (const c of byKey.values()) {
    const list = buckets.get(c.category) ?? [];
    list.push(c);
    buckets.set(c.category, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity) || a.price - b.price);
  }

  // 4. Round-robin across categories, taking the next affordable item from each,
  //    until nothing more fits the budget or the item cap is reached.
  const basket: BasketItem[] = [];
  let total = 0;
  const cursors = new Map<string, number>();
  const cats = [...buckets.keys()];
  let progressed = true;
  while (progressed && basket.length < maxItems) {
    progressed = false;
    for (const cat of cats) {
      if (basket.length >= maxItems) break;
      const list = buckets.get(cat)!;
      let i = cursors.get(cat) ?? 0;
      // advance to the next item in this category that still fits the budget
      while (i < list.length && total + list[i].price > budget) i++;
      if (i < list.length) {
        basket.push(list[i]);
        total = Math.round((total + list[i].price) * 100) / 100;
        cursors.set(cat, i + 1);
        progressed = true;
      } else {
        cursors.set(cat, list.length);
      }
    }
  }

  // 5. Category breakdown.
  const byCategory: BudgetBasketResult['byCategory'] = {};
  for (const item of basket) {
    const b = (byCategory[item.category] ??= { items: 0, spend: 0 });
    b.items++;
    b.spend = Math.round((b.spend + item.price) * 100) / 100;
  }

  return {
    budget,
    total,
    leftover: Math.round((budget - total) * 100) / 100,
    itemCount: basket.length,
    stores: storeStatus,
    basket,
    byCategory,
    note: NOTE,
  };
}

async function gatherSpecials(
  registry: ProviderRegistry,
  sel: StoreSelector,
  perStore: number,
): Promise<{ status: BasketStoreStatus; products: Product[] }> {
  const label = sel.label ?? (sel.storeId ? `${sel.provider}:${sel.storeId}` : sel.provider);
  let provider;
  try {
    provider = registry.get(sel.provider);
  } catch (err) {
    return { status: { label, status: 'unavailable', reason: message(err) }, products: [] };
  }
  const niceLabel = sel.label ?? (sel.storeId ? `${provider.name} (${sel.storeId})` : provider.name);
  try {
    const list = await provider.getSpecials({ maxProducts: perStore, storeId: sel.storeId });
    return {
      status: { label: niceLabel, status: 'ok', specials: list.products.length },
      products: list.products,
    };
  } catch (err) {
    return { status: { label: niceLabel, status: 'unavailable', reason: message(err) }, products: [] };
  }
}

function toBasketItem(p: Product, store: string): BasketItem {
  return {
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    price: p.price as number,
    unitPrice: p.unitPrice,
    unitMeasure: p.unitMeasure,
    savingsPercent: p.savingsPercent,
    category: categoryOf(p.department),
    store,
    productUrl: p.productUrl,
  };
}

/** Cross-store identity key: normalized name + brand (no shared barcode exists). */
function dedupeKey(p: Product): string {
  return `${norm(p.name)}|${norm(p.brand ?? '')}`;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Coarse category label for balancing + exclusion. For dash-delimited SFRA paths
 * (Warehouse, e.g. "foodhouseholdpets-fooddrink-chocolates-…") use the meaningful
 * sub-segment ("fooddrink" / "household" / "pets") — never the compound root,
 * whose "household"/"pet" substrings would wrongly exclude the food catalogue.
 * Other providers use their clean level-0 name (e.g. "fruit & vegetables").
 */
function categoryOf(department?: string): string {
  if (!department) return 'other';
  const d = department.trim();
  if (d.includes('-')) {
    const segs = d.split('-').filter(Boolean);
    return (segs[1] ?? segs[0]).toLowerCase();
  }
  return d.toLowerCase();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
