import { curlGet } from '../../core/curl.js';
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
import type { WooStore } from './stores.js';

const NOT_SUPPORTED = 'Not yet supported for this provider (requires a logged-in session).';

/** A product as returned by the WooCommerce Store API. */
interface RawWooProduct {
  id: number;
  name?: string;
  sku?: string;
  permalink?: string;
  on_sale?: boolean;
  prices?: {
    price?: string; // minor units (cents)
    regular_price?: string;
    sale_price?: string;
    currency_minor_unit?: number;
  };
  images?: Array<{ src?: string }>;
  categories?: Array<{ id: number; name?: string; slug?: string }>;
  is_in_stock?: boolean;
}

interface RawWooCategory {
  id: number;
  name?: string;
  slug?: string;
}

/**
 * Read-only provider for any shop on the public WooCommerce Store API. Product
 * search, on-sale specials and category browsing all work anonymously — no login,
 * no token. Cart and orders require an authenticated session (not implemented).
 */
export class WooCommerceProvider implements ShoppingProvider {
  readonly id: string;
  readonly name: string;

  private categories: RawWooCategory[] | null = null;

  constructor(private readonly store: WooStore) {
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

  private get apiBase(): string {
    return `${this.store.origin}/wp-json/wc/store/v1`;
  }

  private async apiGet(path: string): Promise<{ body: unknown; totalHits: number }> {
    // Via curl, not fetch: naturallyorganic.co.nz serves an incomplete TLS chain
    // that Node's fetch rejects (UNABLE_TO_VERIFY_LEAF_SIGNATURE). See core/curl.ts.
    const res = await curlGet(this.apiBase + path);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${this.name} API ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const totalHits = Number(res.headers['x-wp-total'] ?? '') || 0;
    return { body: JSON.parse(res.body), totalHits };
  }

  // --- Products -------------------------------------------------------------

  /** Fetch up to `max` products (paging the Store API) for the given query path. */
  private async collect(
    query: string,
    max: number,
  ): Promise<{ products: Product[]; totalAvailable: number }> {
    const perPage = Math.min(max, 100);
    const collected: RawWooProduct[] = [];
    let page = 1;
    let totalHits = 0;
    while (collected.length < max) {
      const sep = query.includes('?') ? '&' : '?';
      const { body, totalHits: hits } = await this.apiGet(`${query}${sep}per_page=${perPage}&page=${page}`);
      const items = (body as RawWooProduct[]) ?? [];
      if (page === 1) totalHits = hits;
      if (items.length === 0) break;
      collected.push(...items.slice(0, max - collected.length));
      if (items.length < perPage) break;
      page++;
    }
    return {
      products: collected.map((p) => this.mapProduct(p)),
      totalAvailable: totalHits || collected.length,
    };
  }

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 48;
    let path = `/products?search=${encodeURIComponent(query)}`;
    if (opts.specialsOnly) path += '&on_sale=true';
    const { products, totalAvailable } = await this.collect(path, max);
    return { query, totalAvailable, count: products.length, products };
  }

  async getSpecials(opts: SpecialsOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    const { products, totalAvailable } = await this.collect('/products?on_sale=true', max);
    return { totalAvailable, count: products.length, products };
  }

  async browseProducts(department: string, opts: BrowseOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    const category = await this.resolveCategory(department);
    if (!category) {
      throw new Error(
        `Unknown ${this.name} category "${department}". Try a broader term (e.g. "beverages", "dairy").`,
      );
    }
    let path = `/products?category=${category.id}`;
    if (opts.specialsOnly) path += '&on_sale=true';
    const { products, totalAvailable } = await this.collect(path, max);
    return { department: category.name ?? department, totalAvailable, count: products.length, products };
  }

  private async resolveCategory(name: string): Promise<RawWooCategory | null> {
    if (!this.categories) {
      const { body } = await this.apiGet('/products/categories?per_page=100');
      this.categories = (body as RawWooCategory[]) ?? [];
    }
    const q = name.trim().toLowerCase();
    return (
      this.categories.find((c) => (c.slug ?? '').toLowerCase() === q) ??
      this.categories.find((c) => decodeEntities(c.name ?? '').toLowerCase() === q) ??
      this.categories.find((c) => decodeEntities(c.name ?? '').toLowerCase().includes(q)) ??
      null
    );
  }

  private mapProduct(p: RawWooProduct): Product {
    const minor = p.prices?.currency_minor_unit ?? 2;
    const price = minorToDollars(p.prices?.price, minor);
    const regular = minorToDollars(p.prices?.regular_price, minor);
    const onSale = Boolean(p.on_sale);
    const savings =
      onSale && regular !== undefined && price !== undefined && regular > price
        ? Math.round((regular - price) * 100) / 100
        : undefined;
    return {
      sku: p.sku || String(p.id),
      name: decodeEntities(p.name ?? ''),
      price,
      originalPrice: onSale ? regular : undefined,
      savings,
      savingsPercent:
        savings !== undefined && regular ? Math.round((savings / regular) * 100) : undefined,
      isSpecial: onSale || undefined,
      image: p.images?.[0]?.src,
      productUrl: p.permalink,
      inStock: p.is_in_stock,
      department: p.categories?.[0] ? decodeEntities(p.categories[0].name ?? '') : undefined,
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

function minorToDollars(minor?: string, unit = 2): number | undefined {
  if (minor === undefined || minor === '') return undefined;
  const n = Number(minor);
  return Number.isFinite(n) ? n / 10 ** unit : undefined;
}

/** Decode the handful of HTML entities WooCommerce leaves in names/categories. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8211;/g, '–')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}
