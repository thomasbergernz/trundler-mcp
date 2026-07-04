/**
 * Foodstuffs NZ banners (New World, Pak'nSave, Four Square) all run the same
 * online-shopping "edge" platform — identical request/response shapes on a
 * per-banner host. A provider is just this config plus the shared client.
 */
export interface FoodstuffsBanner {
  /** Provider id used by the registry and the `provider` tool arg. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Site origin (used for the guest-token mint and product links). */
  origin: string;
  /** Edge API host, e.g. https://api-prod.newworld.co.nz */
  apiHost: string;
  /** Banner code embedded in the JWT (`MNW`, `PNS`, ...). Informational. */
  bannerCode: string;
  /** Env var that supplies a store id for local testing (never a shipped default). */
  storeEnvVar: string;
}

export const NEW_WORLD: FoodstuffsBanner = {
  id: 'newworld',
  name: 'New World',
  origin: 'https://www.newworld.co.nz',
  apiHost: 'https://api-prod.newworld.co.nz',
  bannerCode: 'MNW',
  storeEnvVar: 'TRUNDLER_NEWWORLD_STORE_ID',
};

// Future: PAK_N_SAVE = { id: 'paknsave', origin: 'https://www.paknsave.co.nz',
//   apiHost: 'https://api-prod.paknsave.co.nz', bannerCode: 'PNS', ... }
