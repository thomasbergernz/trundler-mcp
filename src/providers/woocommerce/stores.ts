/**
 * WooCommerce-backed stores. Any shop exposing the public WooCommerce Store API
 * (`/wp-json/wc/store/v1/…`) can be added as read-only with just this config —
 * the generic `WooCommerceProvider` does the rest.
 */
export interface WooStore {
  /** Provider id used by the registry and the `provider` tool arg. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Site origin, e.g. https://naturallyorganic.co.nz (no trailing slash). */
  origin: string;
}

export const NATURALLY_ORGANIC: WooStore = {
  id: 'naturallyorganic',
  name: 'Naturally Organic',
  origin: 'https://naturallyorganic.co.nz',
};
