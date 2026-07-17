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

const ORIGIN = 'https://www.farro.co.nz';
/** Sent by the site on every API call; identifies the trading entity. */
const TRADING_ENTITY_ID = 'Olympic-1234';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** Page size for the Search endpoint (proven to accept up to 1000). */
const PAGE_SIZE = 250;
/** Upper bound on products scanned when gathering specials (density ~5%). */
const SPECIALS_SCAN_CAP = 2500;

const NOT_SUPPORTED = 'Not yet supported for this provider (requires a logged-in session).';

/** A product as returned by /api/ViewModel/Search/Search. */
interface RawFarroProduct {
  id: string; // e.g. "Grocery-6071"
  productSKU?: string;
  title?: string;
  brand?: string;
  catalog?: string; // grocery | egiftcards | hampers | ...
  category?: string; // e.g. "chilled"
  department?: string; // e.g. "dairy"
  sellPrice?: number; // dollars
  originalPrice?: number; // dollars
  onSale?: boolean;
  perUnitSellPrice?: number; // dollars
  perUnitOriginalPrice?: number;
  perUnitKind?: string; // e.g. "Per L", "Per 100g"
  productStampImageUrl?: string;
  availabilityState?: string;
}

interface SearchPayload {
  content?: RawFarroProduct[];
  totalElements?: number;
  skipped?: number;
  pageSize?: number;
}

interface AggregationFilter {
  key: string;
  items: Array<{ name: string; count: number; applied: boolean; extraOutputFields: object }>;
  rangeItems: null;
  retrieveAll: boolean;
}

/**
 * Read-only provider for Farro Fresh (farro.co.nz), a Blazor/"Olympic Trader"
 * storefront. Search and category browsing hit the anonymous Search view-model
 * API; specials are the discounted products from that same catalog. No login,
 * no token. Cart and orders require an authenticated session (not implemented).
 */
export class FarroProvider implements ShoppingProvider {
  readonly id = 'farro';
  readonly name = 'Farro Fresh';

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

  private async searchPage(
    searchPattern: string,
    skip: number,
    take: number,
    aggFilters: AggregationFilter[] = [],
  ): Promise<SearchPayload> {
    const res = await fetch(`${ORIGIN}/api/ViewModel/Search/Search`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'x-tradingentity-id': TRADING_ENTITY_ID,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/shop/products`,
      },
      body: JSON.stringify({
        searchPattern,
        sortBy: '',
        skip,
        take,
        filters: [],
        appliedSearchAggregationFilters: aggFilters,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${this.name} API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as SearchPayload;
  }

  // --- Products -------------------------------------------------------------

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 48;
    const collected: RawFarroProduct[] = [];
    let skip = 0;
    let total = 0;
    while (collected.length < max) {
      const take = Math.min(PAGE_SIZE, max - collected.length + 20); // slack for the egiftcard drop
      const res = await this.searchPage(query, skip, take, []);
      const items = (res.content ?? []).filter(isGrocery);
      total = res.totalElements ?? total;
      if (items.length === 0 && (res.content?.length ?? 0) === 0) break;
      collected.push(...items);
      skip += take;
      if (skip >= (res.totalElements ?? 0)) break;
    }
    let products = collected;
    if (opts.specialsOnly) products = products.filter((p) => p.onSale);
    const mapped = products.slice(0, max).map((p) => this.mapProduct(p));
    return { query, totalAvailable: total, count: mapped.length, products: mapped };
  }

  async getSpecials(opts: SpecialsOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    // No server-side on-sale filter exists, so scan the catalog and keep the
    // discounted items, bounded so this stays a handful of calls.
    const specials: RawFarroProduct[] = [];
    let skip = 0;
    while (specials.length < max && skip < SPECIALS_SCAN_CAP) {
      const res = await this.searchPage('', skip, PAGE_SIZE, []);
      const items = res.content ?? [];
      if (items.length === 0) break;
      specials.push(...items.filter((p) => p.onSale && isGrocery(p)));
      skip += PAGE_SIZE;
      if (skip >= (res.totalElements ?? 0)) break;
    }
    const mapped = specials.slice(0, max).map((p) => this.mapProduct(p));
    return { totalAvailable: specials.length, count: mapped.length, products: mapped };
  }

  async browseProducts(department: string, opts: BrowseOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    const agg = categoryFilter(department);
    const collected: RawFarroProduct[] = [];
    let skip = 0;
    let total = 0;
    while (collected.length < max) {
      const res = await this.searchPage('', skip, PAGE_SIZE, [agg]);
      const items = (res.content ?? []).filter(isGrocery);
      total = res.totalElements ?? total;
      if ((res.content?.length ?? 0) === 0) break;
      collected.push(...items);
      skip += PAGE_SIZE;
      if (skip >= (res.totalElements ?? 0)) break;
    }
    let products = collected;
    if (opts.specialsOnly) products = products.filter((p) => p.onSale);
    if (products.length === 0) {
      throw new Error(
        `No ${this.name} products for category "${department}". Try one of: produce, chilled, ` +
          `grocery, deli, beverages, consumables.`,
      );
    }
    const mapped = products.slice(0, max).map((p) => this.mapProduct(p));
    return { department, totalAvailable: total, count: mapped.length, products: mapped };
  }

  private mapProduct(p: RawFarroProduct): Product {
    const onSale = Boolean(p.onSale);
    const savings =
      onSale && p.originalPrice !== undefined && p.sellPrice !== undefined && p.originalPrice > p.sellPrice
        ? Math.round((p.originalPrice - p.sellPrice) * 100) / 100
        : undefined;
    return {
      sku: p.productSKU || p.id,
      name: p.title ?? '',
      brand: p.brand || undefined,
      price: p.sellPrice,
      originalPrice: onSale ? p.originalPrice : undefined,
      savings,
      savingsPercent:
        savings !== undefined && p.originalPrice
          ? Math.round((savings / p.originalPrice) * 100)
          : undefined,
      isSpecial: onSale || undefined,
      unitPrice: p.perUnitSellPrice,
      unitMeasure: p.perUnitKind,
      image: p.productStampImageUrl || undefined,
      productUrl: `${ORIGIN}/shop/product/${p.id}?name=${slugify(p.title ?? '')}`,
      department: p.department || p.category || undefined,
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

/** Drop non-grocery catalogs (gift cards, hampers) from results. */
function isGrocery(p: RawFarroProduct): boolean {
  const c = (p.catalog ?? '').toLowerCase();
  return c !== 'egiftcards' && c !== 'hampers';
}

function categoryFilter(department: string): AggregationFilter {
  return {
    key: 'Category',
    items: [{ name: department.trim().toLowerCase(), count: 0, applied: true, extraOutputFields: {} }],
    rangeItems: null,
    retrieveAll: false,
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
