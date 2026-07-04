import { FoodstuffsProvider } from './dist/providers/foodstuffs/index.js';
import { PAK_N_SAVE } from './dist/providers/foodstuffs/banners.js';
const pns = new FoodstuffsProvider(PAK_N_SAVE);
const all = await pns.listStores();
console.log('total stores:', all.count);
console.log('first 5:', all.stores.slice(0,5).map(s=>s.name));
const akl = await pns.listStores('mangere');
console.log('mangere matches:', akl.stores.map(s=>({name:s.name,id:s.id})));
