/** Shared, provider-agnostic domain types. Each provider maps its native
 *  API responses into these so the MCP tools return a consistent shape. */

export type Unit = 'Each' | 'Kg';

export interface Product {
  sku: string;
  name: string;
  brand?: string;
  price?: number;
  originalPrice?: number;
  savings?: number;
  savingsPercent?: number;
  isSpecial?: boolean;
  multiBuy?: string | null;
  unitPrice?: number;
  unitMeasure?: string;
  size?: string;
  inStock?: boolean;
  /** Whether the item is priced per Each or per Kg — needed to re-add it to a cart. */
  pricingUnit?: Unit;
  image?: string;
  /** Direct link to the product page (opens photo + full detail in a browser). */
  productUrl?: string;
  department?: string;
}

export interface ProductList {
  query?: string;
  department?: string;
  totalAvailable?: number;
  count: number;
  products: Product[];
  /** For per-store-pricing providers: the store id these prices were drawn
   *  from (the explicit override, else the persisted/default selection). Lets
   *  callers avoid mislabelling results as a different store. */
  storeId?: string;
}

export interface CartItem {
  sku: string;
  name?: string;
  quantity?: number;
  unit?: string;
  price?: number;
  originalPrice?: number;
  savings?: number;
  subtotal?: string | number;
}

export interface CartTotals {
  itemCount?: number;
  totalQuantity?: number;
  subtotal?: string;
  savings?: string;
  total?: string;
}

export interface Cart {
  items: CartItem[];
  totals: CartTotals;
}

export interface CartMutation {
  success: boolean;
  item?: { sku?: string; quantity?: number; unit?: string };
  cart: CartTotals;
}

/** Outcome of one line in a batch cart operation (add-many / reorder). */
export interface CartBatchItem {
  sku: string;
  quantity: number;
  unit: string;
  ok: boolean;
  name?: string;
  error?: string;
}

/**
 * Result of a batch cart operation. Reports each line's outcome, the resulting
 * cart totals, and the URL where the shopper reviews the trolley and completes
 * checkout themselves (the agent never books a slot or pays).
 */
export interface CartBatchResult {
  added: number;
  failed: number;
  items: CartBatchItem[];
  totals: CartTotals;
  /** Where the shopper reviews and finishes (slot + payment) in their own browser. */
  reviewUrl: string;
}

/** Persisted authentication material for a provider. */
export interface Tokens {
  /** Full `Cookie:` header value (all cookies, joined). */
  cookies: string;
  /** Decoded XSRF token for state-changing requests (cart, etc.). */
  xsrfToken: string;
  email: string | null;
  capturedAt: string;
  expiresAt: string;
}
