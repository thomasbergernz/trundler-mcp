import type {
  BrowseOptions,
  LoginResult,
  LoginStatus,
  PastOrderItemsOptions,
  SearchOptions,
  ShoppingProvider,
  SpecialsOptions,
  StoreInfo,
  StoreSelection,
} from '../../core/provider.js';
import type { Cart, CartMutation, Product, ProductList, Unit } from '../../core/types.js';
import type { FoodstuffsBanner } from './banners.js';
import { FOODSTUFFS_UA, mintGuestToken, StoreConfig } from './session.js';

/** A single product as returned by the edge search API. */
interface RawNwProduct {
  productId: string;
  name?: string;
  brand?: string;
  displayName?: string;
  availability?: string[];
  singlePrice?: {
    price?: number; // cents (already the promo price when on special)
    promoId?: string; // present when on promotion
    comparativePrice?: {
      pricePerUnit?: number; // cents
      unitQuantityUom?: string;
      measureDescription?: string;
    };
  };
  promotions?: Array<{
    rewardValue?: number; // cents
    rewardType?: string; // e.g. NEW_PRICE
    threshold?: number; // >1 for multi-buy
  }>;
  categoryTrees?: Array<{ level0?: string; level1?: string; level2?: string }>;
}

interface SearchPayload {
  products?: RawNwProduct[];
  totalHits?: number;
  totalPages?: number;
  page?: number;
  hitsPerPage?: number;
}

interface RawStore {
  id: string;
  name?: string;
  region?: string;
  address?: unknown;
  latitude?: number;
  longitude?: number;
  physicalAddress?: {
    additionalCityName?: string; // the suburb, e.g. "Gate Pa"
    cityName?: string;
    regionName?: string;
    postalCode?: string;
  };
}

const NOT_SUPPORTED = 'Not yet supported for this provider (requires a logged-in session).';

export class FoodstuffsProvider implements ShoppingProvider {
  readonly id: string;
  readonly name: string;

  private readonly stores: StoreConfig;
  private token: { token: string; expEpochMs: number } | null = null;

  constructor(private readonly banner: FoodstuffsBanner) {
    this.id = banner.id;
    this.name = banner.name;
    this.stores = new StoreConfig(banner);
  }

  // --- Auth (Tier 1 is anonymous; login is Tier 2, not yet wired) ------------

  async interactiveLogin(): Promise<LoginResult> {
    throw new Error(
      `${this.name} login is not yet implemented. Product search, specials and store ` +
        `selection work without logging in.`,
    );
  }

  async checkLogin(): Promise<LoginStatus> {
    return { isLoggedIn: false, email: null, expiresAt: null };
  }

  /** Return a valid guest token, minting/refreshing as needed. */
  private async guestToken(): Promise<string> {
    if (this.token && this.token.expEpochMs - Date.now() > 60_000) return this.token.token;
    this.token = await mintGuestToken(this.banner);
    return this.token.token;
  }

  private async apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.guestToken();
    const res = await fetch(this.banner.apiHost + path, {
      ...init,
      headers: {
        'User-Agent': FOODSTUFFS_UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: this.banner.origin,
        Referer: this.banner.origin + '/',
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${this.name} API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  // --- Store selection ------------------------------------------------------

  private async requireStore(): Promise<string> {
    const storeId = await this.stores.resolve();
    if (!storeId) {
      throw new Error(
        `No ${this.name} store selected. Prices are per-store — call list_stores to find one, ` +
          `then set_store to choose it.`,
      );
    }
    return storeId;
  }

  async listStores(query?: string): Promise<StoreSelection> {
    const raw = (await this.apiFetch('/v1/edge/store')) as RawStore[] | { stores?: RawStore[] };
    const all = Array.isArray(raw) ? raw : (raw.stores ?? []);
    const stores: StoreInfo[] = all.map((s) => toStoreInfo(s));
    // Match against name, region, suburb and address so users can filter by
    // suburb (e.g. "gate pa") or town, not just the store name.
    const q = query?.trim().toLowerCase();
    const filtered = q
      ? stores.filter((s) =>
          [s.name, s.region, s.suburb, s.address]
            .some((f) => (f ?? '').toLowerCase().includes(q)),
        )
      : stores;
    return { stores: filtered, count: filtered.length };
  }

  async setStore(storeId: string): Promise<StoreInfo> {
    const { stores } = await this.listStores();
    const match = stores.find((s) => s.id === storeId);
    if (!match) throw new Error(`Unknown ${this.name} store id "${storeId}".`);
    await this.stores.set(storeId);
    return match;
  }

  async getStore(): Promise<StoreInfo | null> {
    const storeId = await this.stores.resolve();
    if (!storeId) return null;
    const { stores } = await this.listStores();
    return stores.find((s) => s.id === storeId) ?? { id: storeId, name: '(selected)' };
  }

  // --- Products -------------------------------------------------------------

  private async searchPage(
    storeId: string,
    query: string,
    filters: string,
    page: number,
    hitsPerPage: number,
  ): Promise<SearchPayload> {
    const body = {
      algoliaQuery: {
        attributesToHighlight: [],
        attributesToRetrieve: ['productID', 'Type'],
        facets: ['brand', 'category1NI', 'onPromotion'],
        filters,
        hitsPerPage,
        maxValuesPerFacet: 100,
        page,
        query,
      },
      algoliaFacetQueries: [],
      storeId,
      hitsPerPage,
      page,
      sortOrder: 'NI_POPULARITY_ASC',
      tobaccoQuery: true,
    };
    return (await this.apiFetch('/v1/edge/search/paginated/products', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as SearchPayload;
  }

  /** Collect up to `max` products across pages for the given filter/query. */
  private async collect(
    storeId: string,
    query: string,
    filters: string,
    max: number,
  ): Promise<{ products: Product[]; totalAvailable: number }> {
    const perPage = Math.min(max, 50);
    const collected: RawNwProduct[] = [];
    let page = 0;
    let totalHits = 0;
    let totalPages = 1;
    while (collected.length < max && page < totalPages) {
      const res = await this.searchPage(storeId, query, filters, page, perPage);
      const items = res.products ?? [];
      totalHits = res.totalHits ?? collected.length + items.length;
      totalPages = res.totalPages ?? page + 1;
      if (items.length === 0) break;
      collected.push(...items.slice(0, max - collected.length));
      page++;
    }
    return { products: collected.map((p) => this.mapProduct(p)), totalAvailable: totalHits };
  }

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<ProductList> {
    const storeId = opts.storeId ?? (await this.requireStore());
    const max = opts.maxProducts ?? 48;
    const filters = opts.specialsOnly
      ? `stores:${storeId} AND onPromotion:${storeId}`
      : `stores:${storeId}`;
    const { products, totalAvailable } = await this.collect(storeId, query, filters, max);
    return { query, totalAvailable, count: products.length, products };
  }

  async getSpecials(opts: SpecialsOptions = {}): Promise<ProductList> {
    const storeId = opts.storeId ?? (await this.requireStore());
    const max = opts.maxProducts ?? 120;
    const filters = `stores:${storeId} AND onPromotion:${storeId}`;
    const { products, totalAvailable } = await this.collect(storeId, '', filters, max);
    return { totalAvailable, count: products.length, products };
  }

  async browseProducts(department: string, opts: BrowseOptions = {}): Promise<ProductList> {
    const storeId = opts.storeId ?? (await this.requireStore());
    const max = opts.maxProducts ?? 120;
    let filters = `stores:${storeId} AND category0NI:"${department}"`;
    if (opts.specialsOnly) filters += ` AND onPromotion:${storeId}`;
    const { products, totalAvailable } = await this.collect(storeId, '', filters, max);
    return { department, totalAvailable, count: products.length, products };
  }

  private mapProduct(p: RawNwProduct): Product {
    const sp = p.singlePrice;
    const cmp = sp?.comparativePrice;
    const numeric = p.productId?.split('-')[0];
    // `price` is already the promo price when on special. Search results carry no
    // "was" price, so originalPrice is left undefined.
    const onSpecial = Boolean(sp?.promoId) || (p.promotions?.length ?? 0) > 0;
    const multi = p.promotions?.find((pr) => (pr.threshold ?? 1) > 1);
    return {
      sku: p.productId,
      name: p.name ?? '',
      brand: p.brand,
      price: centsToDollars(sp?.price),
      isSpecial: onSpecial || undefined,
      multiBuy:
        multi && multi.threshold && multi.rewardValue
          ? `${multi.threshold} for $${(multi.rewardValue / 100).toFixed(2)}`
          : undefined,
      unitPrice: centsToDollars(cmp?.pricePerUnit),
      unitMeasure: cmp?.measureDescription ?? cmp?.unitQuantityUom,
      size: p.displayName,
      inStock: p.availability ? p.availability.includes('ONLINE') : undefined,
      image: numeric
        ? `https://a.fsimg.co.nz/product/retail/fan/image/200x200/${numeric}.png`
        : undefined,
      productUrl: `${this.banner.origin}/shop/product/${p.productId}`,
      department: p.categoryTrees?.[0]?.level0,
    };
  }

  // --- Cart & orders (Tier 2 — require login, not yet implemented) ----------

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

function centsToDollars(cents?: number): number | undefined {
  return typeof cents === 'number' ? Math.round(cents) / 100 : undefined;
}

/** Map a raw edge store to the shared StoreInfo, keeping coordinates + suburb. */
function toStoreInfo(s: RawStore): StoreInfo {
  const pa = s.physicalAddress;
  return {
    id: s.id,
    name: s.name ?? '(unnamed)',
    region: s.region ?? pa?.regionName,
    address: typeof s.address === 'string' ? s.address : undefined,
    suburb: pa?.additionalCityName ?? pa?.cityName,
    latitude: typeof s.latitude === 'number' ? s.latitude : undefined,
    longitude: typeof s.longitude === 'number' ? s.longitude : undefined,
  };
}
