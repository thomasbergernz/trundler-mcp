import type {
  BrowseOptions,
  LoginResult,
  LoginStatus,
  PastOrderItemsOptions,
  SearchOptions,
  ShoppingProvider,
  SpecialsOptions,
} from '../../core/provider.js';
import { curlGet } from '../../core/curl.js';
import type { Cart, CartMutation, Product, ProductList, Unit } from '../../core/types.js';

const ORIGIN = 'https://www.thewarehouse.co.nz';

/** Top-level Salesforce category id for food/pantry/household. Used to keep the
 *  general-merchandise catalogue out of grocery results. */
const FOOD_CGID = 'foodhouseholdpets';
/** SFRA renders 32 product tiles per grid page. */
const PAGE_SIZE = 32;
/** Bound the catalogue scan for specials (there is no on-sale-only endpoint).
 *  Kept low: the edge throttles bursts of page loads aggressively. */
const SPECIALS_SCAN_CAP = 96;
/** Polite pause between successive page loads to avoid the edge's 429 throttle. */
const PAGE_DELAY_MS = 700;

const NOT_SUPPORTED = 'Not yet supported for this provider (requires a logged-in session).';

/** The per-tile GTM payload embedded in each search/category result. */
interface RawTile {
  id: string;
  name: string;
  brand?: string;
  price?: string; // dollars, as a string
  productThenPrice?: string; // was-price when discounted
  productBadges?: string; // e.g. "badge_specials", "badge_2_for_7.99", "na"
  category?: string; // taxonomy path, e.g. "foodhouseholdpets/..."
  productEAN?: string;
}

/**
 * Read-only provider for The Warehouse (thewarehouse.co.nz), a server-rendered
 * Salesforce Commerce Cloud (SFRA) storefront. There is no public product JSON
 * API, so search/browse scrape the `data-gtm-product` payload SFRA embeds in
 * each product tile (name, brand, price, badges, category). Anonymous — no
 * login or token. Results are filtered to the food/pantry category so the
 * general-merchandise catalogue does not leak into grocery queries. Cart and
 * orders require an authenticated session (not implemented).
 */
export class WarehouseProvider implements ShoppingProvider {
  readonly id = 'warehouse';
  readonly name = 'The Warehouse';

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

  /** Fetch one SFRA grid page and parse its product tiles. `params` supplies the
   *  query (`q`) or category (`cgid`); `start` paginates.
   *
   *  Uses `curlGet` rather than Node's fetch: the Cloudflare edge in front of the
   *  site 403s undici's TLS fingerprint but serves curl normally — the same
   *  escape hatch the Foodstuffs token mint relies on. `curlGet` doesn't follow
   *  redirects, and some keyword searches 302 to a canonical URL, so follow one
   *  hop manually. */
  private async gridPage(params: Record<string, string>, start: number): Promise<RawTile[]> {
    const qs = new URLSearchParams({ ...params, start: String(start), sz: String(PAGE_SIZE) });
    const url = `${ORIGIN}/search?${qs}`;
    // The Cloudflare edge 429s bursts of page loads; back off with growing delays.
    let res = await curlGet(url);
    for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
      await sleep(1000 * 2 ** attempt); // 1s, 2s, 4s
      res = await curlGet(url);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res = await curlGet(new URL(res.headers.location, ORIGIN).toString());
    }
    if (res.status !== 200) {
      throw new Error(
        `${this.name} returned HTTP ${res.status}. The site may be rate-limiting requests — ` +
          `try again shortly.`,
      );
    }
    return parseTiles(res.body);
  }

  /** Page through a grid, keeping food tiles, until `max` collected or the grid
   *  is exhausted. `onSaleOnly` keeps only discounted tiles. */
  private async collect(
    params: Record<string, string>,
    max: number,
    scanCap: number,
    onSaleOnly: boolean,
  ): Promise<RawTile[]> {
    const kept: RawTile[] = [];
    for (let start = 0; kept.length < max && start < scanCap; start += PAGE_SIZE) {
      if (start > 0) await sleep(PAGE_DELAY_MS);
      const tiles = await this.gridPage(params, start);
      if (tiles.length === 0) break;
      for (const t of tiles) {
        if (!isGrocery(t)) continue;
        if (onSaleOnly && !isSpecial(t)) continue;
        kept.push(t);
      }
      if (tiles.length < PAGE_SIZE) break; // last page
    }
    return kept;
  }

  // --- Products -------------------------------------------------------------

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 48;
    const tiles = await this.collect({ q: query }, max, max + PAGE_SIZE, Boolean(opts.specialsOnly));
    const mapped = tiles.slice(0, max).map((t) => this.mapProduct(t));
    return { query, totalAvailable: mapped.length, count: mapped.length, products: mapped };
  }

  async getSpecials(opts: SpecialsOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    // No on-sale-only endpoint exists, so scan the food category and keep the
    // badged-special tiles, bounded so this stays a handful of page loads.
    const tiles = await this.collect({ cgid: FOOD_CGID }, max, SPECIALS_SCAN_CAP, true);
    const mapped = tiles.slice(0, max).map((t) => this.mapProduct(t));
    return { totalAvailable: mapped.length, count: mapped.length, products: mapped };
  }

  async browseProducts(department: string, opts: BrowseOptions = {}): Promise<ProductList> {
    const max = opts.maxProducts ?? 120;
    // Department names map to a keyword query within the food category; the
    // grocery filter keeps general-merchandise hits out.
    const tiles = await this.collect({ q: department }, max, max + PAGE_SIZE, Boolean(opts.specialsOnly));
    if (tiles.length === 0) {
      throw new Error(
        `No ${this.name} grocery products for "${department}". Try a term like: milk, bread, ` +
          `chocolate, pasta, coffee, snacks.`,
      );
    }
    const mapped = tiles.slice(0, max).map((t) => this.mapProduct(t));
    return { department, totalAvailable: mapped.length, count: mapped.length, products: mapped };
  }

  private mapProduct(t: RawTile): Product {
    const price = toNumber(t.price);
    const wasPrice = toNumber(t.productThenPrice);
    const onSale = isSpecial(t);
    const original = onSale && wasPrice !== undefined && price !== undefined && wasPrice > price ? wasPrice : undefined;
    const savings = original !== undefined && price !== undefined
      ? Math.round((original - price) * 100) / 100
      : undefined;
    return {
      sku: t.id,
      name: t.name,
      brand: t.brand || undefined,
      price,
      originalPrice: original,
      savings,
      savingsPercent:
        savings !== undefined && original ? Math.round((savings / original) * 100) : undefined,
      isSpecial: onSale || undefined,
      productUrl: `${ORIGIN}/p/${slugify(t.name)}/${t.id}.html`,
      department: leafCategory(t.category),
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

/** Extract and JSON-parse the `data-gtm-product` payload from every product
 *  tile in an SFRA grid page. */
function parseTiles(html: string): RawTile[] {
  const out: RawTile[] = [];
  const re = /data-gtm-product="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(decodeEntities(m[1])) as RawTile);
    } catch {
      /* skip a malformed tile */
    }
  }
  return out;
}

/** Decode the HTML-entity encoding SFRA applies to the attribute value. */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** Keep only tiles in the food/pantry category tree. */
function isGrocery(t: RawTile): boolean {
  return (t.category ?? '').toLowerCase().startsWith(FOOD_CGID);
}

/** A tile is on special when it carries the specials badge. */
function isSpecial(t: RawTile): boolean {
  return /special/i.test(t.productBadges ?? '');
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Last segment of the taxonomy path, as a human-ish department label. */
function leafCategory(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const leaf = path.split('/').filter(Boolean).pop();
  return leaf || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
