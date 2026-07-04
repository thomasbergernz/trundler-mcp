import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { providerDir } from './config.js';
import type { Tokens } from './types.js';

/**
 * Persists a provider's auth material to disk:
 *  - tokens.json  — cookies + XSRF (used by plain fetch calls)
 *  - state.json   — Playwright storageState (used for silent headless refresh)
 */
export class TokenStore {
  constructor(private readonly providerId: string) {}

  private dir(): string {
    return providerDir(this.providerId);
  }
  private tokensPath(): string {
    return join(this.dir(), 'tokens.json');
  }
  private statePath(): string {
    return join(this.dir(), 'state.json');
  }

  async saveTokens(tokens: Tokens): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.tokensPath(), JSON.stringify(tokens, null, 2), 'utf8');
  }

  async loadTokens(): Promise<Tokens | null> {
    try {
      return JSON.parse(await readFile(this.tokensPath(), 'utf8')) as Tokens;
    } catch {
      return null;
    }
  }

  /** storageState is an opaque Playwright blob; we don't type its internals. */
  async saveState(state: unknown): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.statePath(), JSON.stringify(state), 'utf8');
  }

  async loadState(): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await readFile(this.statePath(), 'utf8'));
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    await rm(this.dir(), { recursive: true, force: true });
  }
}
