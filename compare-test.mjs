// Live check for multi-store compare_list + saved list. Needs a build.
//   node compare-test.mjs
import { buildRegistry } from './dist/providers/index.js';
import { compareList } from './dist/core/compareList.js';
import { saveList, getList } from './dist/core/shoppingList.js';
import { FoodstuffsProvider } from './dist/providers/foodstuffs/index.js';
import { NEW_WORLD } from './dist/providers/foodstuffs/banners.js';

const registry = buildRegistry();

// 1. Find 2 New World stores by suburb/town filter.
const nw = new FoodstuffsProvider(NEW_WORLD);
const { stores } = await nw.listStores('auckland');
console.log(`list_stores("auckland") -> ${stores.length} stores`);
const s0 = stores[0], s1 = stores[1];
console.log('  pick A:', s0.name, '|', s0.suburb ?? '-', '|', s0.latitude, s0.longitude, '| id', s0.id.slice(0,8));
console.log('  pick B:', s1.name, '|', s1.suburb ?? '-', '| id', s1.id.slice(0,8));

// storeId override must NOT mutate persisted selection:
const before = await nw.getStore();

// 2. Compare a 4-item list across 2 NW branches + Warehouse + Countdown.
const items = [
  { query: 'milk 2L', quantity: 2 },
  { query: 'eggs' },
  { query: 'bread' },
  { query: 'bananas' },
];
const sel = [
  { provider: 'newworld', storeId: s0.id, label: `NW ${s0.suburb ?? s0.name}` },
  { provider: 'newworld', storeId: s1.id, label: `NW ${s1.suburb ?? s1.name}` },
  { provider: 'warehouse' },
  { provider: 'countdown' }, // not logged in -> should be 'unavailable'
];
const res = await compareList(registry, items, sel);

for (const col of res.stores) {
  console.log(`\n### ${col.label} [${col.status}${col.reason ? ': '+col.reason.slice(0,40) : ''}]`);
  if (col.status !== 'ok') continue;
  for (const it of items) {
    const r = col.items[it.query];
    const m = r?.match;
    console.log(`  ${it.query}: ${r?.status}${m ? ` -> ${m.name.slice(0,34)} $${m.price}` : ''}`);
  }
  console.log(`  subtotal $${col.subtotal}  coverage ${col.coverage.found}/${col.coverage.total}`);
}
console.log('\ncheapestPerItem:');
for (const [q, w] of Object.entries(res.cheapestPerItem)) console.log(`  ${q}: ${w ? w.label+' $'+w.price : 'none'}`);
console.log('cheapestOverall:', res.cheapestOverall ? `${res.cheapestOverall.label} $${res.cheapestOverall.subtotal}` : 'none (partial coverage)');

// storeId override didn't change persisted store?
const after = await nw.getStore();
console.log('\npersisted store unchanged by override?', JSON.stringify(before) === JSON.stringify(after) ? 'YES' : `NO (${before?.id} -> ${after?.id})`);

// 3. saved list round-trip
await saveList(items);
const got = await getList();
console.log('save/get_list round-trip:', got.items.length === items.length && got.items[0].query === 'milk 2L' ? 'OK' : 'FAIL', JSON.stringify(got.items[0]));
console.log('\nDone.');
