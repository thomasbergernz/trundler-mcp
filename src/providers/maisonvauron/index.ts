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

const ORIGIN = 'https://www.mvauron.co.nz';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** Each server-rendered category/search page carries 20 items. */
const PAGE_SIZE = 20;
/** Upper bound on pages walked when gathering specials (no on-sale-only view). */
const SPECIALS_SCAN_CAP = 12;

const NOT_SUPPORTED = 'Not yet supported for this provider (requires a logged-in session).';

/** Category-path roots scanned for specials — the whole catalogue lives under these. */
const SPECIALS_ROOTS = ['/to-drink/wine', '/to-eat'];

/** Human department → Black Pepper category path. Unknown terms fall back to search. */
const DEPARTMENT_PATHS: Record<string, string> = {
  wine: '/to-drink/wine',
  red: '/to-drink/wine/red',
  'red wine': '/to-drink/wine/red',
  white: '/to-drink/wine/white',
  'white wine': '/to-drink/wine/white',
  rose: '/to-drink/wine/ros',
  'rosé': '/to-drink/wine/ros',
  sparkling: '/to-drink/wine/sparkling',
  champagne: '/to-drink/wine/sparkling',
  sweet: '/to-drink/wine/sweet',
  cheese: '/to-eat/fromage',
  fromage: '/to-eat/fromage',
  food: '/to-eat',
  deli: '/to-eat',
  drink: '/to-drink',
};

/** A product variant (a single buyable size) inside `stylecolour.variants`. */
interface RawVariant {
  barcode?: string;
  size?: string;
  currency?: string; // "NZD"
  baseunitprice?: string; // dollars, as a string — the normal price
  unitprice?: string; // dollars — the current selling price
  saleprice?: boolean;
  pricetype?: string; // "NORMAL", ...
}

/** One product as embedded in `window.category.items`. */
interface RawItem {
  productid?: number;
  style?: string;
  description?: string;
  department?: string; // "Wine", "Fromage", ...
  prodgroup?: string; // "Red", "SOFT", ...
  supplier?: string | null;
  stylecolour?: {
    urlkey?: string;
    url?: string; // detail path, e.g. "/volnay-…-w001466"
    webtitle?: string;
    saleprice?: boolean;
    variants?: RawVariant[];
    primaryimage?: { src?: string };
    images?: Array<{ src?: string }>;
  };
}

/** The `window.category = {…}` object server-rendered into every list page. */
interface RawCategory {
  items?: RawItem[];
  pagesize?: number;
  totalitems?: number;
}

/**
 * Read-only provider for Maison Vauron (mvauron.co.nz), an Auckland French wine +
 * gourmet-food retailer on the Black Pepper platform. Pages are server-rendered
 * and embed the full product catalogue as a `window.category = {…}` JSON blob, so
 * search/browse/specials fetch the relevant list page and parse that blob — no
 * public JSON API, no login, no token, and plain `fetch` works (nginx origin, no
 * Cloudflare, the >18 popup is a client-side overlay that does not gate the data).
 * Wine is priced per bottle (no per-100g/kg unit price). Cart and orders require
 * an authenticated session (not implemented).
 */
export class MaisonVauronProvider implements ShoppingProvider {
  readonly id = 'maisonvauron';
  readonly name = 'Maison Vauron';

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

  /** Fetch one list page (`path`, optionally `?page=N`) and parse its embedded
   *  `window.category` blob. */
  private async fetchCategory(path: string, page = 1): Promise<RawCategory> {
    const sep = path.includes('?') ? '&' : '?';
    const url = page > 1 ? `${ORIGIN}${path}${sep}page=${page}` : `${ORIGIN}${path}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) {
      throw new Error(`${this.name} returned HTTP ${res.status} for ${path}.`);
    }
    return extractCategory(await res.text());
  }

  /** Page through a list, collecting items until `max` reached or the list is
   *  exhausted. `onSaleOnly` keeps only discounted products. Returns the kept
   *  items plus the list's advertised total (`totalitems`). */
  private async collect(
    path: string,
    max: number,
    onSaleOnly: boolean,
    scanCap = 0,
  ): Promise<{ items: RawItem[]; total: number }> {
    const kept: RawItem[] = [];
    let total = Infinity;
    for (let page = 1; kept.length < max && (page - 1) * PAGE_SIZE < total; page++) {
      if (scanCap && page > scanCap) break;
      const cat = await this.fetchCategory(path, page);
      const items = cat.items ?? [];
      total = cat.totalitems ?? items.length;
      if (items.length === 0) break;
      for (const it of items) {
        if (onSaleOnly && !isSpecial(it)) continue;
        kept.push(it);
      }
      if (items.length < PAGE_SIZE) break; // last page
    }
    return { items: kept, total: Number.isFinite(total) ? total : kept.length };
  }

  // --- Products -------------------------------------------------------------

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 48;
    const path = `/search?q=${encodeURIComponent(query)}`;
    const { items, total } = await this.collect(path, max, Boolean(opts.specialsOnly));
    const mapped = items.slice(0, max).map((it) => this.mapProduct(it));
    return { query, totalAvailable: total, count: mapped.length, products: mapped };
  }

  async getSpecials(opts: SpecialsOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    // No on-sale-only endpoint — scan the catalogue roots and keep discounted
    // products, bounded so this stays a handful of page loads.
    const specials: RawItem[] = [];
    for (const root of SPECIALS_ROOTS) {
      if (specials.length >= max) break;
      const { items } = await this.collect(root, max - specials.length, true, SPECIALS_SCAN_CAP);
      specials.push(...items);
    }
    const mapped = specials.slice(0, max).map((it) => this.mapProduct(it));
    return { totalAvailable: mapped.length, count: mapped.length, products: mapped };
  }

  async browseProducts(department: string, opts: BrowseOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    const key = department.trim().toLowerCase();
    const path = DEPARTMENT_PATHS[key];
    // Unknown department → keyword search so any term still returns something.
    if (!path) {
      const res = await this.searchProducts(department, { maxProducts: max, specialsOnly: opts.specialsOnly });
      return { ...res, query: undefined, department };
    }
    const { items, total } = await this.collect(path, max, Boolean(opts.specialsOnly));
    if (items.length === 0) {
      throw new Error(
        `No ${this.name} products for "${department}". Try one of: wine, red, white, rose, ` +
          `sparkling, champagne, sweet, cheese, food.`,
      );
    }
    const mapped = items.slice(0, max).map((it) => this.mapProduct(it));
    return { department, totalAvailable: total, count: mapped.length, products: mapped };
  }

  private mapProduct(it: RawItem): Product {
    const sc = it.stylecolour ?? {};
    const v = sc.variants?.[0] ?? {};
    const onSale = Boolean(sc.saleprice || v.saleprice);
    const price = toNumber(v.unitprice);
    const base = toNumber(v.baseunitprice);
    const original = onSale && base !== undefined && price !== undefined && base > price ? base : undefined;
    const savings = original !== undefined && price !== undefined
      ? Math.round((original - price) * 100) / 100
      : undefined;
    const urlPath = sc.url || (sc.urlkey ? `/${sc.urlkey}` : undefined);
    return {
      sku: v.barcode || it.style || '',
      name: it.description || sc.webtitle || '',
      brand: it.supplier || undefined,
      price,
      originalPrice: original,
      savings,
      savingsPercent:
        savings !== undefined && original ? Math.round((savings / original) * 100) : undefined,
      isSpecial: onSale || undefined,
      size: v.size || undefined,
      pricingUnit: 'Each',
      image: sc.primaryimage?.src || sc.images?.[0]?.src || undefined,
      productUrl: urlPath ? `${ORIGIN}${urlPath}` : undefined,
      department: it.department || it.prodgroup || undefined,
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

/** Extract and JSON-parse the `window.category = {…}` object embedded in a list
 *  page. The blob is large with nested braces, so match balanced braces from the
 *  assignment rather than using a (lazy) regex. */
function extractCategory(html: string): RawCategory {
  const marker = 'window.category = ';
  const at = html.indexOf(marker);
  if (at < 0) return {};
  const start = html.indexOf('{', at);
  if (start < 0) return {};
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as RawCategory;
        } catch {
          return {};
        }
      }
    }
  }
  return {};
}

/** A product is on special when the style-colour (or its first variant) is flagged. */
function isSpecial(it: RawItem): boolean {
  const sc = it.stylecolour;
  return Boolean(sc?.saleprice || sc?.variants?.[0]?.saleprice);
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
