/**
 * Web-app settings persisted to <configDir>/web.json (reusing the parent's
 * config location). Holds the chosen LLM provider, model and API key.
 *
 * SECURITY: the API key is stored in plaintext on local disk. The file is
 * written with mode 0600 (owner read/write only). This app is a local,
 * single-user tool bound to 127.0.0.1 — do not expose it off-machine.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { configDir } from '../src/core/config.js';

export type LlmProvider = 'groq' | 'openrouter';

/** A store the user has pinned. Foodstuffs entries carry a storeId; national
 *  providers (countdown/warehouse) have none. */
export interface SavedStore {
  provider: string;
  storeId?: string;
  label?: string;
}

export interface WebConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  /** Free-text location (postcode or suburb) used to resolve stores when no
   *  explicit stores are pinned. */
  region: string;
  /** Up to 5 pinned stores. When non-empty these take precedence over region. */
  stores: SavedStore[];
}

const DEFAULTS: WebConfig = {
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  apiKey: '',
  region: '',
  stores: [],
};

function configPath(): string {
  return join(configDir(), 'web.json');
}

export async function loadConfig(): Promise<WebConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<WebConfig>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(patch: Partial<WebConfig>): Promise<WebConfig> {
  const next = { ...(await loadConfig()), ...patch };
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next;
}
