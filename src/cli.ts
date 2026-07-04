#!/usr/bin/env node
/**
 * Standalone CLI for first-time setup and session management, independent of the
 * MCP transport. Usage:
 *   trundler login   [provider]   — open a browser to sign in
 *   trundler check   [provider]   — verify the stored session
 *   trundler logout  [provider]   — delete stored session
 *   trundler providers            — list supported providers
 */
import { TokenStore } from './core/tokenStore.js';
import { buildRegistry, DEFAULT_PROVIDER } from './providers/index.js';

async function main(): Promise<void> {
  const [command, providerArg] = process.argv.slice(2);
  const registry = buildRegistry();
  const providerId = providerArg ?? DEFAULT_PROVIDER;

  switch (command) {
    case 'login': {
      const provider = registry.get(providerId);
      console.log(`Signing in to ${provider.name}...`);
      const result = await provider.interactiveLogin();
      console.log(`Logged in as ${result.email ?? 'unknown'} (expires ${result.expiresAt}).`);
      break;
    }
    case 'check': {
      const provider = registry.get(providerId);
      const status = await provider.checkLogin();
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case 'logout': {
      registry.get(providerId); // validate id
      await new TokenStore(providerId).clear();
      console.log(`Cleared stored session for "${providerId}".`);
      break;
    }
    case 'providers': {
      console.log(registry.ids().join('\n'));
      break;
    }
    default:
      console.log(
        [
          'trundler — local grocery MCP',
          '',
          'Usage:',
          '  trundler login   [provider]   open a browser to sign in',
          '  trundler check   [provider]   verify the stored session',
          '  trundler logout  [provider]   delete stored session',
          '  trundler providers            list supported providers',
          '',
          `Default provider: ${DEFAULT_PROVIDER}`,
        ].join('\n'),
      );
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
