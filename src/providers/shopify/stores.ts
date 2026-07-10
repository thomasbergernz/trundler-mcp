/**
 * Shopify-backed stores. Any Shopify storefront exposes the same public JSON
 * endpoints (`/products.json`, `/collections.json`, `/search/suggest.json`), so a
 * read-only provider is just this config plus the shared `ShopifyProvider`.
 */
export interface ShopifyStore {
  /** Provider id used by the registry and the `provider` tool arg. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Store origin, e.g. https://ceres.co.nz (no trailing slash). */
  origin: string;
}

export const CERES: ShopifyStore = {
  id: 'ceres',
  name: 'Ceres Organics',
  origin: 'https://ceres.co.nz',
};
