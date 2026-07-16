/**
 * Download the official Node.js runtime for Tauri sidecar use.
 *
 * Tauri resolves `externalBin: ["binaries/node"]` to `binaries/node-<target-triple>`
 * at build time, so we place one renamed Node binary per target there.
 *
 * By default only the host platform's binary is fetched (enough for local dev
 * and host builds). Pass --all for every supported target.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '22.22.3'; // LTS; keep in sync with engines >=20

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src-tauri', 'binaries');
const TMP = join(__dirname, '..', 'server-dist', '.node-tmp');

/** target-triple -> nodejs.org dist descriptor */
const TARGETS = {
  'aarch64-apple-darwin': { dist: `node-v${NODE_VERSION}-darwin-arm64`, archive: 'tar.gz', bin: 'bin/node', suffix: '' },
  'x86_64-apple-darwin': { dist: `node-v${NODE_VERSION}-darwin-x64`, archive: 'tar.gz', bin: 'bin/node', suffix: '' },
  'x86_64-pc-windows-msvc': { dist: `node-v${NODE_VERSION}-win-x64`, archive: 'zip', bin: 'node.exe', suffix: '.exe' },
  'x86_64-unknown-linux-gnu': { dist: `node-v${NODE_VERSION}-linux-x64`, archive: 'tar.gz', bin: 'bin/node', suffix: '' },
};

function hostTriple() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (platform === 'linux') return 'x86_64-unknown-linux-gnu';
  throw new Error(`Unsupported host: ${platform}/${arch}`);
}

async function fetchTarget(triple) {
  const t = TARGETS[triple];
  if (!t) throw new Error(`Unknown target triple: ${triple}`);
  const out = join(OUT_DIR, `node-${triple}${t.suffix}`);
  if (existsSync(out)) {
    console.log(`✓ ${triple} already present`);
    return;
  }

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${t.dist}.${t.archive}`;
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const archivePath = join(TMP, `${t.dist}.${t.archive}`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(archivePath, buf);

  // bsdtar (macOS/Linux/Windows 10+) extracts both tar.gz and zip.
  execFileSync('tar', ['-xf', archivePath, '-C', TMP], { stdio: 'inherit' });

  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(join(TMP, t.dist, t.bin), out);
  if (!t.suffix) chmodSync(out, 0o755);
  rmSync(TMP, { recursive: true, force: true });
  console.log(`✓ ${out}`);
}

const wanted = process.argv.includes('--all') ? Object.keys(TARGETS) : [hostTriple()];
for (const triple of wanted) await fetchTarget(triple);
