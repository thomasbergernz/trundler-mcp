import { execFile } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { devNull } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { providerDir } from '../../core/config.js';
import type { FoodstuffsBanner } from './banners.js';

const execFileAsync = promisify(execFile);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

interface GuestToken {
  token: string;
  /** Epoch ms when the JWT expires. */
  expEpochMs: number;
}

/** Decode a JWT payload's `exp` (seconds) without verifying the signature. */
function jwtExpMs(token: string): number {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (typeof json.exp === 'number') return json.exp * 1000;
  } catch {
    /* fall through */
  }
  return Date.now() + 25 * 60_000; // conservative default (tokens live ~30 min)
}

/**
 * Mint an anonymous guest token by loading the banner homepage and reading the
 * `fs-user-token` cookie the server sets. No login required — a single GET that
 * authorises all read APIs (search, specials, stores, categories).
 *
 * The homepage sits behind Cloudflare bot-management that rejects Node's fetch
 * (undici) TLS fingerprint with a 403, but lets curl through. So the mint shells
 * out to curl; the API calls afterwards use plain fetch. curl ships with Windows
 * 10 1803+, macOS and Linux.
 */
export async function mintGuestToken(banner: FoodstuffsBanner): Promise<GuestToken> {
  let headers: string;
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-s', '-D', '-', '-o', devNull, '--max-time', '20', '-H', `User-Agent: ${UA}`, banner.origin + '/'],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    headers = stdout;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${banner.name}: failed to fetch a guest token via curl (${reason}). ` +
        `curl must be installed and on PATH.`,
    );
  }

  const m = headers.match(/set-cookie:\s*fs-user-token=([^;]+)/i);
  if (!m) {
    throw new Error(
      `${banner.name}: no fs-user-token cookie returned from ${banner.origin} ` +
        `(possible Cloudflare block or site change).`,
    );
  }
  const token = m[1];
  return { token, expEpochMs: jwtExpMs(token) };
}

/** Per-banner store selection, persisted next to any auth material. */
export class StoreConfig {
  constructor(private readonly banner: FoodstuffsBanner) {}

  private path(): string {
    return join(providerDir(this.banner.id), 'store.json');
  }

  /** Resolve the active store id: persisted choice, else the test env var, else null. */
  async resolve(): Promise<string | null> {
    try {
      const saved = JSON.parse(await readFile(this.path(), 'utf8')) as { storeId?: string };
      if (saved.storeId) return saved.storeId;
    } catch {
      /* not set yet */
    }
    return process.env[this.banner.storeEnvVar] || null;
  }

  async set(storeId: string): Promise<void> {
    await mkdir(providerDir(this.banner.id), { recursive: true });
    await writeFile(this.path(), JSON.stringify({ storeId }, null, 2), 'utf8');
  }
}

export const FOODSTUFFS_UA = UA;
