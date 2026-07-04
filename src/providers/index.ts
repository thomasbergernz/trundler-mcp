import { ProviderRegistry } from '../core/provider.js';
import { CountdownProvider } from './countdown/index.js';
import { NEW_WORLD } from './foodstuffs/banners.js';
import { FoodstuffsProvider } from './foodstuffs/index.js';

/** Provider used when a tool call omits an explicit `provider` argument. */
export const DEFAULT_PROVIDER = 'countdown';

/** Build the registry of all supported shopping providers. */
export function buildRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new CountdownProvider());
  registry.register(new FoodstuffsProvider(NEW_WORLD));
  // Future: registry.register(new FoodstuffsProvider(PAK_N_SAVE));
  return registry;
}
