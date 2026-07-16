// Standalone live check for the read-only providers added on top of Foodstuffs:
// Ceres (Shopify), Naturally Organic (WooCommerce) and Farro (Olympic Trader).
// Exercises search / specials / browse against the real sites. Needs a build.
//   node new-providers-test.mjs
import { ShopifyProvider } from './dist/providers/shopify/index.js';
import { CERES } from './dist/providers/shopify/stores.js';
import { WooCommerceProvider } from './dist/providers/woocommerce/index.js';
import { NATURALLY_ORGANIC } from './dist/providers/woocommerce/stores.js';
import { FarroProvider } from './dist/providers/farro/index.js';

const line = (p) =>
  `- ${p.name}${p.brand ? ` (${p.brand})` : ''} | $${p.price ?? '—'}` +
  `${p.unitPrice ? ` | $${p.unitPrice}/${(p.unitMeasure || '').replace(/^per\s*/i, '')}` : ''}` +
  `${p.isSpecial ? ` | SPECIAL was $${p.originalPrice ?? '?'}` : ''}`;

async function exercise(label, provider, department) {
  console.log(`\n########## ${label} ##########`);
  const s = await provider.searchProducts('milk', { maxProducts: 5 });
  console.log(`search "milk": total=${s.totalAvailable} returned=${s.count}`);
  s.products.forEach((p) => console.log('  ' + line(p)));

  const sp = await provider.getSpecials({ maxProducts: 3 });
  console.log(`specials: returned=${sp.count}`);
  sp.products.forEach((p) => console.log('  ' + line(p)));

  const b = await provider.browseProducts(department, { maxProducts: 3 });
  console.log(`browse "${department}": total=${b.totalAvailable} returned=${b.count}`);
  b.products.forEach((p) => console.log('  ' + line(p)));

  // Capability guard: a cart tool must fail with the friendly message.
  try {
    await provider.cartGet();
    console.log('  !! cartGet did NOT throw (expected not-supported)');
  } catch (e) {
    console.log(`  cartGet correctly rejected: ${e.message.slice(0, 60)}…`);
  }
}

await exercise('CERES (Shopify)', new ShopifyProvider(CERES), 'chocolate');
await exercise('NATURALLY ORGANIC (WooCommerce)', new WooCommerceProvider(NATURALLY_ORGANIC), 'beverages');
await exercise('FARRO (Olympic Trader)', new FarroProvider(), 'produce');

console.log('\nDone.');
