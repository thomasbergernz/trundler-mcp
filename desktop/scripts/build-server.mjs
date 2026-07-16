/**
 * Bundle the web backend for the Tauri sidecar.
 *
 * Output layout (bundled as the app's `server` resource):
 *   server-dist/server/
 *     server.mjs         — esbuild bundle of web/server.ts (express, MCP SDK,
 *                          zod etc. inlined; playwright kept EXTERNAL)
 *     public/            — the web UI, served by express
 *     node_modules/
 *       playwright/      — shipped verbatim: countdown login resolves
 *       playwright-core/   playwright/package.json via createRequire and runs
 *                          its cli.js with process.execPath (the sidecar node),
 *                          so it must exist on disk (see src/providers/countdown/login.ts).
 */
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..'); // repo root
const OUT = join(__dirname, '..', 'server-dist', 'server');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [join(ROOT, 'web', 'server.ts')],
  outfile: join(OUT, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['playwright', 'playwright-core'],
  // CJS deps (express) referenced from an ESM bundle need a require shim.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Static UI, served by express relative to the bundle (__dirname/public).
cpSync(join(ROOT, 'web', 'public'), join(OUT, 'public'), { recursive: true });

// Playwright must be a real on-disk package (not inlined) — see header note.
for (const pkg of ['playwright', 'playwright-core']) {
  cpSync(join(ROOT, 'node_modules', pkg), join(OUT, 'node_modules', pkg), {
    recursive: true,
    dereference: true,
  });
}

console.log(`✓ server bundle at ${OUT}`);
