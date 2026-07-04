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
  image?: string;
  department?: string;
}

export interface ProductList {
  query?: string;
  department?: string;
  totalAvailable?: number;
  count: number;
  products: Product[];
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
