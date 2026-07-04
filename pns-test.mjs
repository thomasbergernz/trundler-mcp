import { FoodstuffsProvider } from './dist/providers/foodstuffs/index.js';
import { PAK_N_SAVE } from './dist/providers/foodstuffs/banners.js';
const pns = new FoodstuffsProvider(PAK_N_SAVE);

console.log('# Pak\'nSave list_stores("auckland")');
const st = await pns.listStores('auckland');
console.log('count:', st.count, '| first:', st.stores[0]);

const storeId = st.stores[0]?.id;
process.env.TRUNDLER_PAKNSAVE_STORE_ID = storeId;

console.log('\n# Pak\'nSave search "milk" top 5');
const r = await pns.searchProducts('milk', { maxProducts: 5 });
console.log('total:', r.totalAvailable, 'returned:', r.count);
for (const p of r.products) console.log(`- ${p.name} (${p.brand}) ${p.size} | $${p.price} | ${p.unitPrice?'$'+p.unitPrice+'/'+p.unitMeasure:'—'}`);

console.log('\n# Pak\'nSave specials top 3');
const s = await pns.getSpecials({ maxProducts: 3 });
for (const p of s.products) console.log(`- ${p.name} | $${p.price} | special=${p.isSpecial}`);
