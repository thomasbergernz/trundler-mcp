// Standalone smoke test: spawn the built MCP server over stdio, list tools,
// and exercise a couple of them against the stored login. Terminates on its own.
//   node smoke-test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
const client = new Client({ name: 'trundler-smoke-test', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('Tools:', tools.map((t) => t.name).join(', '));

async function call(name, args = {}) {
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  console.log(text.length > 1600 ? text.slice(0, 1600) + '\n...(truncated)' : text);
}

await call('check_login');
await call('search_products', { query: 'eggs', specialsOnly: true, maxProducts: 5 });

await client.close();
process.exit(0);
