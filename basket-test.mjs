// Live check for budget_basket. Needs a build.  node basket-test.mjs
import { buildRegistry } from './dist/providers/index.js';
import { budgetBasket } from './dist/core/budgetBasket.js';
import { FoodstuffsProvider } from './dist/providers/foodstuffs/index.js';
import { NEW_WORLD } from './dist/providers/foodstuffs/banners.js';

const registry = buildRegistry();
const nw = new FoodstuffsProvider(NEW_WORLD);
const { stores } = await nw.listStores('wellington');
const s = stores[0];
console.log('store:', s.name, '|', s.suburb, '| id', s.id.slice(0,8));

const sel = [
  { provider: 'newworld', storeId: s.id, label: `NW ${s.suburb}` },
  { provider: 'warehouse' },
  { provider: 'countdown' }, // not logged in -> skipped
];
const res = await budgetBasket(registry, sel, { budget: 100, maxItems: 25 });

console.log('\nstores:');
res.stores.forEach(st => console.log(`  ${st.label}: ${st.status}${st.specials!=null?` (${st.specials} specials)`:''}${st.reason?' - '+st.reason.slice(0,40):''}`));
console.log(`\nbasket: ${res.itemCount} items, total $${res.total}, leftover $${res.leftover} (budget $${res.budget})`);
console.log('by category:', Object.entries(res.byCategory).map(([c,v])=>`${c}:${v.items}/$${v.spend}`).join('  '));
console.log('\nsample items:');
res.basket.slice(0,12).forEach(b => console.log(`  $${b.price}${b.unitPrice?` ($${b.unitPrice}/${(b.unitMeasure||'').replace(/^per /i,'')})`:''}  [${b.category}] ${b.name.slice(0,40)}  @${b.store}`));

// invariants
const sum = Math.round(res.basket.reduce((a,b)=>a+b.price,0)*100)/100;
console.log('\nINVARIANTS:');
console.log('  total <= budget?', res.total <= res.budget ? 'YES' : 'NO');
console.log('  total == sum(items)?', sum === res.total ? 'YES' : `NO (${sum} vs ${res.total})`);
console.log('  countdown skipped (unavailable)?', res.stores.find(x=>x.label.match(/Countdown/i))?.status === 'unavailable' ? 'YES' : 'NO');
console.log('  categories spread > 1?', Object.keys(res.byCategory).length > 1 ? 'YES ('+Object.keys(res.byCategory).length+')' : 'NO');
console.log('\nDone.');
