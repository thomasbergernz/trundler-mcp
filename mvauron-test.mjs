// Live exercise of the Maison Vauron provider against dist/ (needs build).
// Hits the real mvauron.co.nz site. Usage: node mvauron-test.mjs
import { MaisonVauronProvider } from './dist/providers/maisonvauron/index.js';

const p = new MaisonVauronProvider();

function show(label, list) {
  console.log(`\n=== ${label} — ${list.count} of ${list.totalAvailable ?? '?'} ===`);
  for (const x of list.products.slice(0, 5)) {
    console.log(
      `  ${x.name} | $${x.price} | ${x.sku} | ${x.department ?? ''}` +
        `${x.isSpecial ? ` | SALE was $${x.originalPrice}` : ''}\n    ${x.productUrl}`,
    );
  }
}

const search = await p.searchProducts('champagne', { maxProducts: 8 });
show('search champagne', search);

const browse = await p.browseProducts('fromage', { maxProducts: 8 });
show('browse fromage', browse);

const wine = await p.browseProducts('red', { maxProducts: 5 });
show('browse red wine', wine);

const fallback = await p.searchProducts('bordeaux', { maxProducts: 5 });
show('search bordeaux', fallback);

const specials = await p.getSpecials({ maxProducts: 10 });
show('specials', specials);

// Sanity: every product should have a name, a price and a working-looking URL.
const bad = search.products.filter((x) => !x.name || x.price === undefined || !x.productUrl);
console.log(`\nsearch products missing name/price/url: ${bad.length}`);

// Confirm one product URL resolves.
const url = search.products[0]?.productUrl;
if (url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  console.log(`first productUrl HTTP ${res.status}: ${url}`);
}
console.log('\nlogin status:', await p.checkLogin());
