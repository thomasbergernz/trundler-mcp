// Live smoke test for anonymous (guest) Woolworths reads against dist/.
// Run with a THROWAWAY config dir to force the guest path (no stored login):
//   npm run build && XDG_CONFIG_HOME=$(mktemp -d) node countdown-guest-test.mjs
// Must run from a residential connection — datacenter IPs trip bot management.
import { buildRegistry, compareList } from './dist/lib.js';

const registry = buildRegistry();
const countdown = registry.get('countdown');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 0. Confirm we're actually logged out (guest path, not a stored session).
const status = await countdown.checkLogin();
check('logged out (guest path exercised)', !status.isLoggedIn, `isLoggedIn=${status.isLoggedIn}`);

// 1. Search without login.
const search = await countdown.searchProducts('sunflower oil 1l', { maxProducts: 5 });
check(
  'searchProducts returns priced products',
  search.count > 0 && search.products.every((p) => typeof p.price === 'number'),
  `count=${search.count}, first=${search.products[0]?.name} $${search.products[0]?.price}`,
);

// 2. Specials without login.
const specials = await countdown.getSpecials({ maxProducts: 5 });
check(
  'getSpecials returns products',
  specials.count > 0,
  `count=${specials.count}, first=${specials.products[0]?.name}`,
);

// 3. compare_list: countdown must be a priced column, not `unavailable`.
const cmp = await compareList(
  registry,
  [{ query: 'milk 2l' }],
  [{ provider: 'countdown', label: 'Woolworths (guest)' }],
);
const col = cmp.stores[0];
check(
  'compare_list prices countdown while logged out',
  col.status === 'ok' && col.subtotal > 0,
  `status=${col.status}, subtotal=${col.subtotal}`,
);

// 3b. Store selection works logged-out.
const stores = await countdown.listStores();
check(
  'listStores returns pickup stores (guest)',
  stores.count > 50 && stores.stores.every((s) => s.id && s.name),
  `count=${stores.count}, first=${stores.stores[0]?.name}`,
);

const filtered = await countdown.listStores('ponsonby');
check(
  'listStores filters by suburb',
  filtered.count > 0 && filtered.count < stores.count,
  `ponsonby matches=${filtered.count}`,
);

// Per-call storeId override reprices at a chosen branch (no persistence side-effect).
const branch = filtered.stores[0] ?? stores.stores[0];
const atBranch = await countdown.searchProducts('milk 2l', { maxProducts: 3, storeId: branch.id });
check(
  'searchProducts honours a countdown storeId override',
  atBranch.count > 0 && atBranch.products.every((p) => typeof p.price === 'number'),
  `store=${branch.name}, first=${atBranch.products[0]?.name} $${atBranch.products[0]?.price}`,
);

// set_store persists a pin; get_store echoes it.
const set = await countdown.setStore(branch.id);
const got = await countdown.getStore();
check(
  'setStore persists and getStore returns the pin',
  set.id === branch.id && got?.id === branch.id,
  `set=${set.name}, got=${got?.name}`,
);

// compare_list at a specific countdown branch prices as an ok column.
const cmpStore = await compareList(
  registry,
  [{ query: 'milk 2l' }],
  [{ provider: 'countdown', storeId: branch.id, label: `Woolworths ${branch.name}` }],
);
const scol = cmpStore.stores[0];
check(
  'compare_list prices a specific countdown branch',
  scol.status === 'ok' && scol.subtotal > 0,
  `status=${scol.status}, subtotal=${scol.subtotal}`,
);

// 4. Cart must still demand login for guests.
let cartBlocked = false;
try {
  await countdown.cartGet();
} catch (err) {
  cartBlocked = /login/i.test(String(err));
}
check('cartGet still requires login', cartBlocked);

console.log(failures === 0 ? '\nAll guest checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
