#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log } from './core/config.js';
import { buildServer } from './mcp/server.js';

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // NB: never write to stdout — it carries the MCP protocol. Logs go to stderr.
  log('trundler MCP server running on stdio');
}

main().catch((err) => {
  log('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
