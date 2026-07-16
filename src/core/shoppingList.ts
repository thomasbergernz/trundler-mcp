import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { configDir } from './config.js';
import type { CompareItem } from './compareList.js';

/**
 * A persisted "regular shopping list" — a plain list of item queries the shopper
 * reuses week to week. Provider-agnostic (just keywords + quantities), stored as
 * a single JSON file alongside the other trundler config (never in the repo).
 */
function listPath(): string {
  return join(configDir(), 'list.json');
}

/** Save (overwrite) the regular list. Returns how many items were stored. */
export async function saveList(items: CompareItem[]): Promise<{ count: number }> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(listPath(), JSON.stringify({ items }, null, 2), 'utf8');
  return { count: items.length };
}

/** Load the saved list. Returns an empty list if none has been saved yet. */
export async function getList(): Promise<{ items: CompareItem[] }> {
  try {
    const data = JSON.parse(await readFile(listPath(), 'utf8')) as { items?: CompareItem[] };
    return { items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { items: [] };
  }
}
