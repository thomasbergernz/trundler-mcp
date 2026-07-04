import type { Cart, CartMutation, ProductList, Unit } from './types.js';

export interface SearchOptions {
  maxProducts?: number;
  inStockOnly?: boolean;
  specialsOnly?: boolean;
}

export interface BrowseOptions {
  aisle?: string;
  specialsOnly?: boolean;
  maxProducts?: number;
  pageSize?: number;
}

export interface SpecialsOptions {
  maxProducts?: number;
  pageSize?: number;
}

export interface PastOrderItemsOptions {
  page?: number;
  sort?: string;
  maxPages?: number;
}

export interface LoginStatus {
  isLoggedIn: boolean;
  email: string | null;
  expiresAt: string | null;
}

export interface LoginResult {
  email: string | null;
  expiresAt: string;
}

export interface StoreInfo {
  id: string;
  name: string;
  region?: string;
  address?: string;
}

export interface StoreSelection {
  stores: StoreInfo[];
  count: number;
}

/**
 * A shopping provider (Countdown, and future supermarkets). Providers normalize
 * their native APIs into the shared domain types. Capabilities a provider does
 * not support may throw an Error (surfaced to the agent as a tool error).
 */
export interface ShoppingProvider {
  readonly id: string;
  readonly name: string;

  /** Open a real browser window for the user to sign in; capture the session. */
  interactiveLogin(): Promise<LoginResult>;
  /** Verify the stored session is still authenticated. */
  checkLogin(): Promise<LoginStatus>;

  searchProducts(query: string, opts?: SearchOptions): Promise<ProductList>;
  getSpecials(opts?: SpecialsOptions): Promise<ProductList>;
  browseProducts(department: string, opts?: BrowseOptions): Promise<ProductList>;

  cartGet(): Promise<Cart>;
  cartAdd(sku: string, quantity: number, unit: Unit): Promise<CartMutation>;
  cartUpdate(sku: string, quantity: number, unit: Unit): Promise<CartMutation>;
  cartRemove(sku: string, unit: Unit): Promise<CartMutation>;

  listPastOrders(filter?: string): Promise<unknown>;
  listPastOrderItems(opts?: PastOrderItemsOptions): Promise<ProductList>;
  getOrderItems(orderId: string): Promise<ProductList>;

  /** Providers with per-store pricing (Foodstuffs) expose store selection. */
  listStores?(query?: string): Promise<StoreSelection>;
  setStore?(storeId: string): Promise<StoreInfo>;
  getStore?(): Promise<StoreInfo | null>;
}

export class ProviderRegistry {
  private readonly map = new Map<string, ShoppingProvider>();

  register(provider: ShoppingProvider): void {
    this.map.set(provider.id, provider);
  }

  get(id: string): ShoppingProvider {
    const provider = this.map.get(id);
    if (!provider) {
      throw new Error(
        `Unknown provider "${id}". Available: ${[...this.map.keys()].join(', ') || '(none)'}`,
      );
    }
    return provider;
  }

  ids(): string[] {
    return [...this.map.keys()];
  }
}
