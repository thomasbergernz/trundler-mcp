import { ProviderRegistry } from '../core/provider.js';
import { CountdownProvider } from './countdown/index.js';
import { FarroProvider } from './farro/index.js';
import { MaisonVauronProvider } from './maisonvauron/index.js';
import { NEW_WORLD, PAK_N_SAVE } from './foodstuffs/banners.js';
import { FoodstuffsProvider } from './foodstuffs/index.js';
import { ShopifyProvider } from './shopify/index.js';
import { CERES, GROCERY_BOX, PADDOCK_TO_PANTRY, SABATO } from './shopify/stores.js';
import { WarehouseProvider } from './warehouse/index.js';
import { WooCommerceProvider } from './woocommerce/index.js';
import { NATURALLY_ORGANIC } from './woocommerce/stores.js';

/** Provider used when a tool call omits an explicit `provider` argument. */
export const DEFAULT_PROVIDER = 'countdown';

/** Build the registry of all supported shopping providers. */
export function buildRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new CountdownProvider());
  registry.register(new FoodstuffsProvider(NEW_WORLD));
  registry.register(new FoodstuffsProvider(PAK_N_SAVE));
  registry.register(new ShopifyProvider(CERES));
  registry.register(new ShopifyProvider(SABATO));
  registry.register(new ShopifyProvider(PADDOCK_TO_PANTRY));
  registry.register(new ShopifyProvider(GROCERY_BOX));
  registry.register(new WooCommerceProvider(NATURALLY_ORGANIC));
  registry.register(new FarroProvider());
  registry.register(new WarehouseProvider());
  registry.register(new MaisonVauronProvider());
  return registry;
}
