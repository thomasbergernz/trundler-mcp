import { filterCookies } from '../../core/http.js';
import type {
  BrowseOptions,
  LoginResult,
  LoginStatus,
  PastOrderItemsOptions,
  SearchOptions,
  ShoppingProvider,
  SpecialsOptions,
} from '../../core/provider.js';
import { TokenStore } from '../../core/tokenStore.js';
import type {
  Cart,
  CartMutation,
  Product,
  ProductList,
  Tokens,
  Unit,
} from '../../core/types.js';
import { COUNTDOWN } from './constants.js';
import { interactiveLogin, silentRefresh } from './login.js';
import { isExpired, verifyTokens } from './session.js';

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
  private cache: Tokens | null = null;

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

  // --- Low-level API helpers ------------------------------------------------

  private async callApi(endpoint: string, method = 'GET', body?: unknown): Promise<unknown> {
    const tokens = await this.getTokens();
    const url = endpoint.startsWith('http') ? endpoint : `${COUNTDOWN.origin}${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: { ...COUNTDOWN.headers, Cookie: filterCookies(tokens.cookies) },
      body: body ? JSON.stringify(body) : undefined,
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

    const res = await this.callApi(url);
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
      const res = await this.callApi(url);
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
      const res = await this.callApi(url);
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

  // --- Cart -----------------------------------------------------------------

  async cartGet(): Promise<Cart> {
    const res = await this.callApi('/api/v1/trolleys/my');
    if (isApiError(res)) throw apiError('Failed to get cart', res);
    const payload = res as CartPayload;
    const items = (payload.items ?? []).map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      price: item.price?.salePrice,
      originalPrice: item.price?.originalPrice,
      savings: item.price?.savePrice,
      subtotal: item.totalPrice,
    }));
    return {
      items,
      totals: {
        itemCount: payload.itemCount,
        subtotal: payload.subtotal,
        savings: payload.savings,
        total: payload.total,
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
  items?: Array<{
    sku: string;
    name?: string;
    quantity?: number;
    unit?: string;
    totalPrice?: string | number;
    price?: { salePrice?: number; originalPrice?: number; savePrice?: number };
  }>;
  itemCount?: number;
  subtotal?: string;
  savings?: string;
  total?: string;
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
    image: p.images?.big,
    productUrl: p.sku ? `${COUNTDOWN.origin}/shop/productdetails?stockcode=${p.sku}` : undefined,
    department: p.departments?.[0]?.name,
  };
}

function apiError(context: string, err: ApiError): Error {
  const detail = err.body ? ` — ${err.body}` : '';
  return new Error(`${context}: ${err.status} ${err.statusText}${detail}`);
}
