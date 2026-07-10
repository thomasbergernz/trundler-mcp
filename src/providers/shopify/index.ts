import type {
  BrowseOptions,
  LoginResult,
  LoginStatus,
  PastOrderItemsOptions,
  SearchOptions,
  ShoppingProvider,
  SpecialsOptions,
} from '../../core/provider.js';
import type { Cart, CartMutation, Product, ProductList, Unit } from '../../core/types.js';
import type { ShopifyStore } from './stores.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const NOT_SUPPORTED = 'Not yet supported for this provider (requires a logged-in session).';

/** How long the full-catalog page cache stays warm (specials/browse reuse it). */
const CATALOG_TTL_MS = 10 * 60_000;
/** Shopify caps a single products.json/collection page at 250. */
const PAGE_SIZE = 250;

/** A variant from the REST products.json / collections products.json. */
interface RawVariant {
  price?: string; // dollars, e.g. "39.00"
  compare_at_price?: string | null;
  grams?: number;
  available?: boolean;
  title?: string;
}

/** A product from products.json / collections/{handle}/products.json. */
interface RawProduct {
  id: number;
  title?: string;
  handle?: string;
  vendor?: string;
  product_type?: string;
  tags?: string[] | string;
  variants?: RawVariant[];
  images?: Array<{ src?: string }>;
}

/** A product from search/suggest.json (shape differs from products.json). */
interface SuggestProduct {
  title?: string;
  handle?: string;
  url?: string;
  price?: string; // dollars
  compare_at_price?: string | null;
  available?: boolean;
  image?: string;
  vendor?: string;
}

interface RawCollection {
  handle: string;
  title?: string;
}

/**
 * Read-only provider for any Shopify storefront. Search uses the predictive
 * `suggest.json` for the fast path; specials and category browsing page the
 * public `products.json` / `collections.json` endpoints. All anonymous — no login,
 * no token. Cart and orders require an authenticated session (not implemented).
 */
export class ShopifyProvider implements ShoppingProvider {
  readonly id: string;
  readonly name: string;

  private collections: RawCollection[] | null = null;
  private catalog: { products: RawProduct[]; at: number } | null = null;

  constructor(private readonly store: ShopifyStore) {
    this.id = store.id;
    this.name = store.name;
  }

  // --- Auth (anonymous read-only; login is not implemented) ------------------

  async interactiveLogin(): Promise<LoginResult> {
    throw new Error(
      `${this.name} login is not yet implemented. Product search, specials and browsing ` +
        `work without logging in.`,
    );
  }

  async checkLogin(): Promise<LoginStatus> {
    return { isLoggedIn: false, email: null, expiresAt: null };
  }

  // --- HTTP -----------------------------------------------------------------

  private async json(path: string): Promise<unknown> {
    const res = await fetch(this.store.origin + path, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${this.name} ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  /** All catalog products, cached ~10 min so specials/search-fallback don't re-crawl. */
  private async fullCatalog(): Promise<RawProduct[]> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) {
      return this.catalog.products;
    }
    const products = await this.pageAll('/products.json');
    this.catalog = { products, at: Date.now() };
    return products;
  }

  /** Page a products.json-style endpoint until it runs dry (bounded for safety). */
  private async pageAll(basePath: string, maxProducts = 5000): Promise<RawProduct[]> {
    const out: RawProduct[] = [];
    let page = 1;
    while (out.length < maxProducts) {
      const sep = basePath.includes('?') ? '&' : '?';
      const body = (await this.json(`${basePath}${sep}limit=${PAGE_SIZE}&page=${page}`)) as {
        products?: RawProduct[];
      };
      const items = body.products ?? [];
      if (items.length === 0) break;
      out.push(...items);
      if (items.length < PAGE_SIZE) break;
      page++;
    }
    return out;
  }

  // --- Products -------------------------------------------------------------

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 48;

    // Fast path: predictive search (dollar prices, but no grams → no unit price)
    // and capped at 10 by Shopify. Fall back to the full catalog for larger
    // requests or when we need specials-only filtering.
    if (!opts.specialsOnly && max <= 10) {
      const q = new URLSearchParams({ q: query });
      q.set('resources[type]', 'product');
      q.set('resources[limit]', String(Math.min(max, 10)));
      const body = (await this.json(`/search/suggest.json?${q}`)) as {
        resources?: { results?: { products?: SuggestProduct[] } };
      };
      const hits = body.resources?.results?.products ?? [];
      const products = hits.map((p) => this.mapSuggest(p));
      return { query, totalAvailable: products.length, count: products.length, products };
    }

    // Full-catalog fallback: keyword match on title / vendor / type / tags.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let matched = (await this.fullCatalog()).filter((p) => {
      const hay = [p.title, p.vendor, p.product_type, tagsText(p.tags)].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    if (opts.specialsOnly) matched = matched.filter(isOnSpecial);
    const total = matched.length;
    const products = matched.slice(0, max).map((p) => this.mapProduct(p));
    return { query, totalAvailable: total, count: products.length, products };
  }

  async getSpecials(opts: SpecialsOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    const specials = (await this.fullCatalog()).filter(isOnSpecial);
    const products = specials.slice(0, max).map((p) => this.mapProduct(p));
    return { totalAvailable: specials.length, count: products.length, products };
  }

  async browseProducts(department: string, opts: BrowseOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    const collection = await this.resolveCollection(department);
    if (!collection) {
      throw new Error(
        `Unknown ${this.name} collection "${department}". Products are grouped into Shopify ` +
          `collections — try a term from the store's menu.`,
      );
    }
    let items = await this.pageAll(`/collections/${collection.handle}/products.json`, max * 3);
    if (opts.specialsOnly) items = items.filter(isOnSpecial);
    const total = items.length;
    const products = items.slice(0, max).map((p) => this.mapProduct(p));
    return {
      department: collection.title ?? department,
      totalAvailable: total,
      count: products.length,
      products,
    };
  }

  private async resolveCollection(name: string): Promise<RawCollection | null> {
    if (!this.collections) {
      const all = await this.pageCollections();
      this.collections = all;
    }
    const q = name.trim().toLowerCase();
    return (
      this.collections.find((c) => c.handle.toLowerCase() === q) ??
      this.collections.find((c) => (c.title ?? '').toLowerCase() === q) ??
      this.collections.find((c) => (c.title ?? '').toLowerCase().includes(q)) ??
      this.collections.find((c) => c.handle.toLowerCase().includes(q)) ??
      null
    );
  }

  private async pageCollections(): Promise<RawCollection[]> {
    const out: RawCollection[] = [];
    let page = 1;
    while (true) {
      const body = (await this.json(`/collections.json?limit=250&page=${page}`)) as {
        collections?: RawCollection[];
      };
      const items = body.collections ?? [];
      if (items.length === 0) break;
      out.push(...items);
      if (items.length < 250) break;
      page++;
    }
    return out;
  }

  // --- Mapping --------------------------------------------------------------

  private mapProduct(p: RawProduct): Product {
    const v = firstVariant(p.variants);
    const price = dollars(v?.price);
    const compareAt = dollars(v?.compare_at_price);
    const onSpecial = compareAt !== undefined && price !== undefined && compareAt > price;
    const savings = onSpecial ? Math.round((compareAt - price) * 100) / 100 : undefined;
    const grams = v?.grams ?? 0;
    return {
      sku: p.handle ?? String(p.id),
      name: p.title ?? '',
      brand: p.vendor,
      price,
      originalPrice: onSpecial ? compareAt : undefined,
      savings,
      savingsPercent:
        savings !== undefined && compareAt ? Math.round((savings / compareAt) * 100) : undefined,
      isSpecial: onSpecial || undefined,
      unitPrice: grams > 0 && price !== undefined ? Math.round((price / grams) * 100 * 100) / 100 : undefined,
      unitMeasure: grams > 0 && price !== undefined ? 'per 100g' : undefined,
      image: p.images?.[0]?.src,
      productUrl: p.handle ? `${this.store.origin}/products/${p.handle}` : undefined,
      inStock: p.variants?.some((x) => x.available),
      department: p.product_type || undefined,
    };
  }

  private mapSuggest(p: SuggestProduct): Product {
    const price = dollars(p.price);
    const compareAt = dollars(p.compare_at_price);
    const onSpecial = compareAt !== undefined && price !== undefined && compareAt > price;
    const savings = onSpecial ? Math.round((compareAt - price) * 100) / 100 : undefined;
    return {
      sku: p.handle ?? '',
      name: p.title ?? '',
      brand: p.vendor,
      price,
      originalPrice: onSpecial ? compareAt : undefined,
      savings,
      isSpecial: onSpecial || undefined,
      image: p.image,
      productUrl: p.handle
        ? `${this.store.origin}/products/${p.handle}`
        : p.url
          ? this.store.origin + p.url.split('?')[0]
          : undefined,
      inStock: p.available,
    };
  }

  // --- Cart & orders (require login, not implemented) -----------------------

  cartGet(): Promise<Cart> {
    throw new Error(NOT_SUPPORTED);
  }
  cartAdd(_sku: string, _q: number, _u: Unit): Promise<CartMutation> {
    throw new Error(NOT_SUPPORTED);
  }
  cartUpdate(_sku: string, _q: number, _u: Unit): Promise<CartMutation> {
    throw new Error(NOT_SUPPORTED);
  }
  cartRemove(_sku: string, _u: Unit): Promise<CartMutation> {
    throw new Error(NOT_SUPPORTED);
  }
  listPastOrders(): Promise<unknown> {
    throw new Error(NOT_SUPPORTED);
  }
  listPastOrderItems(_opts?: PastOrderItemsOptions): Promise<ProductList> {
    throw new Error(NOT_SUPPORTED);
  }
  getOrderItems(_orderId: string): Promise<ProductList> {
    throw new Error(NOT_SUPPORTED);
  }
}

function firstVariant(variants?: RawVariant[]): RawVariant | undefined {
  return variants?.find((v) => v.available) ?? variants?.[0];
}

function isOnSpecial(p: RawProduct): boolean {
  const v = firstVariant(p.variants);
  const price = dollars(v?.price);
  const compareAt = dollars(v?.compare_at_price);
  return compareAt !== undefined && price !== undefined && compareAt > price;
}

function dollars(s?: string | null): number | undefined {
  if (s === undefined || s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function tagsText(tags?: string[] | string): string {
  if (Array.isArray(tags)) return tags.join(' ');
  return tags ?? '';
}
