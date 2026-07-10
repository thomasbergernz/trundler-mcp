// Live check for the Countdown delegation tools (cart_add_many / cart_clear /
// reorder_usuals). Needs a build + a stored Countdown login. Mutates YOUR real
// trolley: it clears it, adds a couple of items, then clears again. Run only if
// you're OK with that.
//   node delegation-test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
const client = new Client({ name: 'trundler-delegation-test', version: '0.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

// Boundary check: no checkout/slot/payment tool should exist.
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
const forbidden = names.filter((n) => /checkout|slot|payment|place.?order|pay\b/i.test(n));
console.log('tools:', names.join(', '));
console.log('boundary — forbidden checkout/slot/payment tools present:', forbidden.length ? forbidden : 'none ✓');

const login = await call('check_login', { provider: 'countdown' });
if (!login.isLoggedIn) {
  console.log('\nNot logged in to Countdown — run `npm run cli login` first. Skipping cart tests.');
  await client.close();
  process.exit(0);
}

console.log('\n# cart_clear (reset)');
let r = await call('cart_clear', { provider: 'countdown' });
console.log('cleared', r.added ?? 0, 'removed lines; failed', r.failed, '| totals', JSON.stringify(r.totals));

console.log('\n# reorder_usuals maxItems=5');
r = await call('reorder_usuals', { provider: 'countdown', maxItems: 5 });
console.log('added', r.added, 'failed', r.failed, '| reviewUrl', r.reviewUrl);
r.items.forEach((i) => console.log(`  ${i.ok ? '✓' : '✗'} ${i.name ?? i.sku} x${i.quantity} (${i.unit})${i.error ? ' — ' + i.error : ''}`));
console.log('totals:', JSON.stringify(r.totals));

console.log('\n# cart_get (confirm review link surfaced by delegation flow)');
const cart = await call('cart_get', { provider: 'countdown' });
console.log('cart lines:', cart.items.length, '| total', cart.totals?.total);

console.log('\n# cart_clear (tidy up)');
r = await call('cart_clear', { provider: 'countdown' });
console.log('removed', r.items.length, 'lines; failed', r.failed);

await client.close();
process.exit(0);
