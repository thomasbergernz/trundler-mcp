import { ProviderRegistry } from '../core/provider.js';
import { CountdownProvider } from './countdown/index.js';

/** Provider used when a tool call omits an explicit `provider` argument. */
export const DEFAULT_PROVIDER = 'countdown';

/** Build the registry of all supported shopping providers. */
export function buildRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new CountdownProvider());
  // Future: registry.register(new PakNSaveProvider()); etc.
  return registry;
}
