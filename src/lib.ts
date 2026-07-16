/**
 * Library entry point for embedding trundler in another app (e.g. a shell that
 * mounts the MCP server in-process). Unlike ./index.ts, importing this module has
 * NO side effects — it starts nothing. Build your own transport and connect the
 * server returned by buildServer(), or drive providers directly via the registry.
 */
export { buildServer } from './mcp/server.js';
export { buildRegistry, DEFAULT_PROVIDER } from './providers/index.js';
export { ProviderRegistry } from './core/provider.js';
export { TokenStore } from './core/tokenStore.js';
export { compareList } from './core/compareList.js';
export { getList, saveList } from './core/shoppingList.js';

export type {
  CompareItem,
  CompareOptions,
  CompareResult,
  ItemAtStore,
  MatchInfo,
  StoreColumn,
  StoreSelector,
} from './core/compareList.js';

export type {
  BrowseOptions,
  LoginResult,
  LoginStatus,
  PastOrderItemsOptions,
  SearchOptions,
  ShoppingProvider,
  SpecialsOptions,
  StoreInfo,
  StoreSelection,
} from './core/provider.js';
export type {
  Cart,
  CartItem,
  CartMutation,
  CartTotals,
  Product,
  ProductList,
  Tokens,
  Unit,
} from './core/types.js';
