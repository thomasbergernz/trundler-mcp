import { filterCookies } from '../../core/http.js';
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
import { TokenStore } from '../../core/tokenStore.js';
import type {
  Cart,
  CartBatchItem,
  CartBatchResult,
  CartMutation,
  Product,
  ProductList,
  Tokens,
  Unit,
} from '../../core/types.js';
import { COUNTDOWN } from './constants.js';
import { mintGuestTokens } from './guestSession.js';
import { interactiveLogin, silentRefresh } from './login.js';
import { isExpired, verifyTokens } from './session.js';
import { CountdownStoreConfig, fetchPickupStores, filterStores } from './stores.js';

interface ApiError {
  error: true;
  status: number;
  statusText: string;
  body?: string;
}

function isApiError(x: unknown): x is ApiError {
  return typeof x === 'object' && x !== null && (x as ApiError).error === true;
}

export class CountdownProvider implements ShoppingProvider {
  readonly id = COUNTDOWN.id;
  readonly name = COUNTDOWN.name;

  private readonly store = new TokenStore(COUNTDOWN.id);
  private readonly storeConfig = new CountdownStoreConfig();
  private cache: Tokens | null = null;
  /** Anonymous guest sessions for read-only calls, keyed by pinned store id
   *  ('' = the IP-located default). In-memory only (short TTL). Keying by store
   *  keeps concurrent reads for different branches on separate cookie jars, so
   *  the stateful store-pin never races (e.g. compare_list across branches). */
  private readonly guestCache = new Map<string, Tokens>();

  // --- Authentication -------------------------------------------------------

  async interactiveLogin(): Promise<LoginResult> {
    const tokens = await interactiveLogin(this.store);
    this.cache = tokens;
    return { email: tokens.email, expiresAt: tokens.expiresAt };
  }

  async checkLogin(): Promise<LoginStatus> {
    const stored = this.cache ?? (await this.store.loadTokens());
    if (!stored) return { isLoggedIn: false, email: null, expiresAt: null };
    const check = await verifyTokens(stored);
    return { isLoggedIn: check.isLoggedIn, email: check.email, expiresAt: stored.expiresAt };
  }

  /** Return usable tokens: cached → stored → silent refresh → prompt for login. */
  private async getTokens(): Promise<Tokens> {
    if (this.cache && !isExpired(this.cache)) return this.cache;

    const stored = await this.store.loadTokens();
    if (stored && !isExpired(stored)) {
      this.cache = stored;
      return stored;
    }

    try {
      const refreshed = await silentRefresh(this.store);
      this.cache = refreshed;
      return refreshed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Not logged in to ${this.name}. Run the "login" tool first. (${reason})`,
      );
    }
  }

  /**
   * Anonymous session for reads, pinned to a store. `storeId` (a per-call
   * override) wins; otherwise the persisted store pin, if any; otherwise the
   * IP-located default. Sessions are cached per store id and re-minted on expiry.
   */
  private async getGuestTokens(storeId?: string): Promise<Tokens> {
    const pin = storeId ?? (await this.storeConfig.resolve())?.id;
    const key = pin ?? '';
    const cached = this.guestCache.get(key);
    if (cached && !isExpired(cached)) return cached;
    const minted = await mintGuestTokens(pin);
    this.guestCache.set(key, minted);
    return minted;
  }

  /**
   * Tokens for read-only calls (search/specials/browse). An explicit `storeId`
   * override always uses the anonymous session pinned to that store — never the
   * logged-in one, whose store-set would mutate the shopper's real account
   * fulfilment. With no override: prefer the logged-in session (prices follow
   * the shopper's own store), else an anonymous guest session at the persisted
   * (or default) store. Cart and order history never use this — a guest has
   * neither.
   */
  private async getReadTokens(storeId?: string): Promise<Tokens> {
    if (storeId) return this.getGuestTokens(storeId);
    try {
      return await this.getTokens();
    } catch {
      return this.getGuestTokens();
    }
  }

  // --- Low-level API helpers ------------------------------------------------

  private async callApi(
    endpoint: string,
    opts: { method?: string; body?: unknown; auth?: 'read' | 'user'; storeId?: string } = {},
  ): Promise<unknown> {
    const tokens =
      opts.auth === 'read' ? await this.getReadTokens(opts.storeId) : await this.getTokens();
    const url = endpoint.startsWith('http') ? endpoint : `${COUNTDOWN.origin}${endpoint}`;
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { ...COUNTDOWN.headers, Cookie: filterCookies(tokens.cookies) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      return { error: true, status: res.status, statusText: res.statusText } satisfies ApiError;
    }
    return res.json();
  }

  private async callCartApi(body: unknown): Promise<unknown> {
    const tokens = await this.getTokens();
    const res = await fetch(`${COUNTDOWN.origin}/api/v1/trolleys/my/items`, {
      method: 'POST',
      headers: {
        ...COUNTDOWN.headers,
        Cookie: filterCookies(tokens.cookies),
        'X-XSRF-TOKEN': tokens.xsrfToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        error: true,
        status: res.status,
        statusText: res.statusText,
        body: text,
      } satisfies ApiError;
    }
    return res.json();
  }

  // --- Products -------------------------------------------------------------

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<ProductList> {
    const limit = opts.maxProducts ?? 48;
    const inStock = opts.inStockOnly ?? false;
    const url = `/api/v1/products?target=search&search=${encodeURIComponent(
      query,
    )}&inStockProductsOnly=${inStock}&size=${limit}`;

    const res = await this.callApi(url, { auth: 'read', storeId: opts.storeId });
    if (isApiError(res)) throw apiError('Search failed', res);

    const payload = res as ProductsPayload;
    let items = (payload.products?.items ?? []).filter((p) => p.type === 'Product');
    if (opts.specialsOnly) {
      items = items.filter((p) => p.price?.isSpecial === true || p.productTag?.multiBuy != null);
    }

    return {
      query,
      totalAvailable: payload.products?.totalItems ?? 0,
      count: items.length,
      products: items.map(mapProduct),
    };
  }

  async getSpecials(opts: SpecialsOptions = {}): Promise<ProductList> {
    const perPage = Math.min(opts.pageSize ?? 120, 120);
    const maxLimit = opts.maxProducts ?? Infinity;
    const collected: RawProduct[] = [];
    let page = 1;
    let totalItems = 0;

    while (collected.length < maxLimit) {
      const url = `/api/v1/products?target=specials&useRankedSpecials=true&page=${page}&size=${perPage}`;
      const res = await this.callApi(url, { auth: 'read', storeId: opts.storeId });
      if (isApiError(res)) {
        if (collected.length > 0) break;
        throw apiError('Failed to fetch specials', res);
      }
      const payload = res as ProductsPayload;
      const items = payload.products?.items ?? [];
      totalItems = payload.products?.totalItems ?? 0;
      if (items.length === 0) break;

      collected.push(...items.slice(0, maxLimit - collected.length));
      if (collected.length >= totalItems || items.length < perPage) break;
      page++;
    }

    return {
      totalAvailable: totalItems,
      count: collected.length,
      products: collected.map(mapProduct),
    };
  }

  async browseProducts(department: string, opts: BrowseOptions = {}): Promise<ProductList> {
    const perPage = Math.min(opts.pageSize ?? 120, 120);
    const maxLimit = opts.maxProducts ?? Infinity;
    const filters = [`Department%3B%3B${encodeURIComponent(department)}%3Bfalse`];
    if (opts.aisle) filters.push(`Aisle%3B%3B${encodeURIComponent(opts.aisle)}%3Bfalse`);
    const filterParam = filters.map((f) => `dasFilter=${f}`).join('&');

    const collected: RawProduct[] = [];
    let page = 1;
    let totalItems = 0;

    while (collected.length < maxLimit) {
      const url = `/api/v1/products?target=browse&${filterParam}&inStockProductsOnly=false&size=${perPage}&page=${page}`;
      const res = await this.callApi(url, { auth: 'read', storeId: opts.storeId });
      if (isApiError(res)) {
        if (collected.length > 0) break;
        throw apiError('Failed to browse products', res);
      }
      const payload = res as ProductsPayload;
      let items = (payload.products?.items ?? []).filter((p) => p.type === 'Product');
      totalItems = payload.products?.totalItems ?? 0;
      if (items.length === 0) break;
      if (opts.specialsOnly) items = items.filter((p) => p.price?.isSpecial === true);

      collected.push(...items.slice(0, maxLimit - collected.length));
      if (collected.length >= totalItems || items.length < perPage) break;
      page++;
    }

    return {
      department,
      totalAvailable: totalItems,
      count: collected.length,
      products: collected.map(mapProduct),
    };
  }

  // --- Store selection (guest) ----------------------------------------------
  // Woolworths prices per branch. A guest can pin a store (Click & Collect
  // address) and reads then price there; a logged-in shopper always prices at
  // their own account store, so these only affect the anonymous session.

  async listStores(query?: string): Promise<StoreSelection> {
    const guest = await this.getGuestTokens();
    const stores = filterStores(await fetchPickupStores(guest.cookies), query);
    return { stores, count: stores.length };
  }

  async setStore(storeId: string): Promise<StoreInfo> {
    const guest = await this.getGuestTokens();
    const match = (await fetchPickupStores(guest.cookies)).find((s) => s.id === storeId);
    if (!match) throw new Error(`Unknown ${this.name} store id "${storeId}".`);
    await this.storeConfig.set(match);
    // Drop cached guest sessions so the next read re-mints pinned to the new store.
    this.guestCache.clear();
    return match;
  }

  async getStore(): Promise<StoreInfo | null> {
    return this.storeConfig.resolve();
  }

  // --- Cart -----------------------------------------------------------------

  async cartGet(): Promise<Cart> {
    const res = await this.callApi('/api/v1/trolleys/my');
    if (isApiError(res)) throw apiError('Failed to get cart', res);
    const payload = res as CartPayload;

    // Trolley items are grouped by aisle (items[].products[]), quantity is an
    // object, the line total is price.total, and cart totals live under
    // context.basketTotals — flatten and remap accordingly.
    const items = (payload.items ?? []).flatMap((group) =>
      (group.products ?? []).map((p) => ({
        sku: p.sku,
        name: p.name,
        quantity: p.quantity?.value,
        unit: p.unit,
        price: p.price?.salePrice,
        originalPrice: p.price?.originalPrice,
        savings: p.price?.savePrice,
        subtotal: p.price?.total,
      })),
    );

    const totals = payload.context?.basketTotals;
    return {
      items,
      totals: {
        itemCount: totals?.totalItems ?? payload.itemCount,
        totalQuantity: totals?.totalItemQuantity,
        subtotal: totals?.subtotal,
        savings: totals?.savings,
        total: totals?.totalIncludingDeliveryFees,
      },
    };
  }

  cartAdd(sku: string, quantity: number, unit: Unit): Promise<CartMutation> {
    return this.mutateCart({ sku, quantity, pricingUnit: unit, adId: null });
  }

  cartUpdate(sku: string, quantity: number, unit: Unit): Promise<CartMutation> {
    return this.mutateCart({ sku, quantity, pricingUnit: unit, adId: null });
  }

  cartRemove(sku: string, unit: Unit): Promise<CartMutation> {
    return this.mutateCart({ sku, quantity: 0, pricingUnit: unit, adId: null });
  }

  private async mutateCart(body: CartMutationBody): Promise<CartMutation> {
    const res = await this.callCartApi(body);
    if (isApiError(res)) throw apiError('Cart request failed', res);
    const r = res as CartMutationResponse;
    return {
      success: Boolean(r.isSuccessful),
      item: r.itemAdded
        ? { sku: r.itemAdded.sku, quantity: r.itemAdded.quantity, unit: r.itemAdded.unit }
        : undefined,
      cart: {
        itemCount: r.context?.basketTotals?.totalItems,
        totalQuantity: r.context?.basketTotals?.totalItemQuantity,
        subtotal: r.context?.basketTotals?.subtotal,
        savings: r.context?.basketTotals?.savings,
      },
    };
  }

  // --- Batch cart (delegation) ----------------------------------------------
  // These fill the trolley in bulk but deliberately stop there: the shopper picks
  // a delivery slot and pays themselves via `reviewUrl`. No slot/checkout/payment
  // capability is exposed here by design.

  async cartAddMany(
    items: Array<{ sku: string; quantity: number; unit: Unit }>,
  ): Promise<CartBatchResult> {
    const outcomes: CartBatchItem[] = [];
    for (const it of items) {
      const qty = it.quantity > 0 ? it.quantity : 1;
      try {
        const r = await this.mutateCart({ sku: it.sku, quantity: qty, pricingUnit: it.unit, adId: null });
        outcomes.push({ sku: it.sku, quantity: qty, unit: it.unit, ok: Boolean(r.success) });
      } catch (err) {
        outcomes.push({
          sku: it.sku,
          quantity: qty,
          unit: it.unit,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.batchResult(outcomes);
  }

  async cartClear(): Promise<CartBatchResult> {
    const cart = await this.cartGet();
    const outcomes: CartBatchItem[] = [];
    for (const line of cart.items) {
      const unit: Unit = /kg/i.test(line.unit ?? '') ? 'Kg' : 'Each';
      try {
        const r = await this.cartRemove(line.sku, unit);
        outcomes.push({ sku: line.sku, quantity: 0, unit, ok: Boolean(r.success), name: line.name });
      } catch (err) {
        outcomes.push({
          sku: line.sku,
          quantity: 0,
          unit,
          ok: false,
          name: line.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.batchResult(outcomes);
  }

  async reorderUsuals(maxItems: number): Promise<CartBatchResult> {
    const want = Math.max(1, maxItems);
    // Frequent items come ~20/page; fetch enough pages to still hit `want` after
    // dropping out-of-stock lines.
    const list = await this.listPastOrderItems({
      sort: 'Frequency',
      maxPages: Math.min(5, Math.ceil(want / 15) + 1),
    });
    const picks = list.products.filter((p) => p.inStock).slice(0, want);
    const items = picks.map((p) => ({
      sku: p.sku,
      quantity: 1,
      unit: p.pricingUnit ?? ('Each' as Unit),
    }));
    const result = await this.cartAddMany(items);
    // Attach names for a friendlier review (add-many works from SKUs alone).
    const nameBySku = new Map(picks.map((p) => [p.sku, p.name]));
    result.items = result.items.map((i) => ({ ...i, name: i.name ?? nameBySku.get(i.sku) }));
    return result;
  }

  private async batchResult(items: CartBatchItem[]): Promise<CartBatchResult> {
    const cart = await this.cartGet();
    return {
      added: items.filter((i) => i.ok).length,
      failed: items.filter((i) => !i.ok).length,
      items,
      totals: cart.totals,
      reviewUrl: COUNTDOWN.trolleyUrl,
    };
  }

  // --- Past orders ----------------------------------------------------------

  async listPastOrders(filter?: string): Promise<unknown> {
    const filterParam = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const res = await this.callApi(`/api/v1/shoppers/my/past-orders${filterParam}`);
    if (isApiError(res)) throw apiError('Failed to fetch past orders', res);
    const payload = res as PastOrdersPayload;
    return {
      count: payload.items?.length ?? 0,
      availableFilters: payload.filterList?.map((f) => f.value) ?? [],
      orders: (payload.items ?? []).map((o) => ({
        orderId: o.orderId,
        date: o.orderDate,
        method: o.method,
        total: o.total,
        deliveryFee: o.deliveryFee,
        status: o.status,
        fulfilmentDate: o.fulfilmentDate,
        fulfilmentTime: o.fulfilmentTime,
      })),
    };
  }

  async listPastOrderItems(opts: PastOrderItemsOptions = {}): Promise<ProductList> {
    const sort = opts.sort ?? 'Frequency';
    const startPage = opts.page ?? 1;
    const pages = opts.maxPages ?? 1;
    const collected: RawProduct[] = [];
    let totalItems = 0;

    for (let p = startPage; p < startPage + pages; p++) {
      const res = await this.callApi(
        `/api/v1/shoppers/my/past-orders/items?page=${p}&sort=${sort}`,
      );
      if (isApiError(res)) {
        if (collected.length > 0) break;
        throw apiError('Failed to fetch past order items', res);
      }
      const payload = res as ProductsPayload;
      const items = payload.products?.items ?? [];
      totalItems = payload.products?.totalItems ?? 0;
      if (items.length === 0) break;
      collected.push(...items);
      if (collected.length >= totalItems) break;
    }

    return {
      totalAvailable: totalItems,
      count: collected.length,
      products: collected.map(mapProduct),
    };
  }

  async getOrderItems(orderId: string): Promise<ProductList> {
    const collected: RawProduct[] = [];
    let totalItems = 0;
    let page = 1;

    while (true) {
      const res = await this.callApi(
        `/api/v1/shoppers/my/past-orders/${encodeURIComponent(orderId)}/items?page=${page}`,
      );
      if (isApiError(res)) {
        if (collected.length > 0) break;
        throw apiError('Failed to fetch order items', res);
      }
      const payload = res as ProductsPayload;
      const items = payload.products?.items ?? [];
      totalItems = payload.products?.totalItems ?? 0;
      if (items.length === 0) break;
      collected.push(...items);
      if (collected.length >= totalItems) break;
      page++;
    }

    return {
      query: orderId,
      totalAvailable: totalItems,
      count: collected.length,
      products: collected.map(mapProduct),
    };
  }
}

// --- Woolworths response shapes (partial) & mapping -------------------------

interface RawProduct {
  type?: string;
  sku: string;
  name: string;
  brand?: string;
  unit?: string;
  price?: {
    salePrice?: number;
    originalPrice?: number;
    savePrice?: number;
    savePercentage?: number;
    isSpecial?: boolean;
  };
  productTag?: { multiBuy?: { quantity: number; value: number } | null };
  size?: { cupPrice?: number; cupMeasure?: string; volumeSize?: string };
  images?: { big?: string };
  availabilityStatus?: string;
  departments?: Array<{ name?: string }>;
}

interface ProductsPayload {
  products?: { items?: RawProduct[]; totalItems?: number };
}

interface CartPayload {
  itemCount?: number;
  // Trolley lines are grouped by aisle; products are nested one level down.
  items?: Array<{
    categoryType?: string;
    categoryDescription?: string;
    products?: Array<{
      sku: string;
      name?: string;
      unit?: string;
      quantity?: { value?: number; quantityInOrder?: number };
      price?: { salePrice?: number; originalPrice?: number; savePrice?: number; total?: string };
    }>;
  }>;
  context?: {
    basketTotals?: {
      subtotal?: string;
      savings?: string;
      totalItems?: number;
      totalItemQuantity?: number;
      deliveryFees?: string;
      bagFees?: string;
      totalIncludingDeliveryFees?: string;
    };
  };
}

interface CartMutationBody {
  sku: string;
  quantity: number;
  pricingUnit: Unit;
  adId: null;
}

interface CartMutationResponse {
  isSuccessful?: boolean;
  itemAdded?: { sku?: string; quantity?: number; unit?: string };
  context?: {
    basketTotals?: {
      totalItems?: number;
      totalItemQuantity?: number;
      subtotal?: string;
      savings?: string;
    };
  };
}

interface PastOrdersPayload {
  items?: Array<{
    orderId?: string;
    orderDate?: string;
    method?: string;
    total?: string;
    deliveryFee?: string;
    status?: string;
    fulfilmentDate?: string;
    fulfilmentTime?: string;
  }>;
  filterList?: Array<{ value?: string }>;
}

function mapProduct(p: RawProduct): Product {
  return {
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    price: p.price?.salePrice,
    originalPrice: p.price?.originalPrice,
    savings: p.price?.savePrice,
    savingsPercent: p.price?.savePercentage,
    isSpecial: p.price?.isSpecial,
    multiBuy: p.productTag?.multiBuy
      ? `${p.productTag.multiBuy.quantity} for $${p.productTag.multiBuy.value}`
      : null,
    unitPrice: p.size?.cupPrice,
    unitMeasure: p.size?.cupMeasure,
    size: p.size?.volumeSize,
    inStock: p.availabilityStatus === 'In Stock',
    pricingUnit: /kg/i.test(p.unit ?? '') ? 'Kg' : 'Each',
    image: p.images?.big,
    productUrl: p.sku ? `${COUNTDOWN.origin}/shop/productdetails?stockcode=${p.sku}` : undefined,
    department: p.departments?.[0]?.name,
  };
}

function apiError(context: string, err: ApiError): Error {
  const detail = err.body ? ` — ${err.body}` : '';
  return new Error(`${context}: ${err.status} ${err.statusText}${detail}`);
}
