import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { providerDir } from '../../core/config.js';
import { filterCookies } from '../../core/http.js';
import type { StoreInfo } from '../../core/provider.js';
import { COUNTDOWN } from './constants.js';

/**
 * A Woolworths Click & Collect pickup store. The `id` is the addressId the
 * fulfilment API expects when pinning a store; the guest reads then price at
 * that branch. Some entries are community pickup points ("… outside The Well
 * Cafe") rather than full supermarkets — they still reprice, the label is just
 * unusual.
 */
export interface CountdownStore extends StoreInfo {
  /** addressId — pass to the set-store PUT and to searchProducts({ storeId }). */
  id: string;
}

interface RawPickupArea {
  id?: number;
  name?: string;
  storeAddresses?: Array<{ id?: number; name?: string; address?: string }>;
}

interface PickupAddressesPayload {
  storeAreas?: RawPickupArea[];
}

/** The "All Pick up locations" area duplicates the regional areas; skip it so
 *  each store's `region` comes from its real regional area, not this catch-all. */
const CATCH_ALL_AREA = /all pick ?up locations/i;

/**
 * Fetch every pickup store on an anonymous guest session, deduped by id with the
 * region carried from the named regional area. `guestCookies` come from a minted
 * guest session (any store pin is irrelevant — this list is store-independent).
 */
export async function fetchPickupStores(guestCookies: string): Promise<CountdownStore[]> {
  const payload = await getJson(COUNTDOWN.stores.list, guestCookies);
  const areas = (payload as PickupAddressesPayload).storeAreas ?? [];

  const byId = new Map<string, CountdownStore>();
  for (const area of areas) {
    const isCatchAll = CATCH_ALL_AREA.test(area.name ?? '');
    for (const s of area.storeAddresses ?? []) {
      if (s.id == null) continue;
      const id = String(s.id);
      const existing = byId.get(id);
      // Prefer a real regional area's name for `region`; only let the catch-all
      // area seed an entry we haven't seen from a regional area yet.
      if (existing && (isCatchAll || existing.region)) continue;
      byId.set(id, {
        id,
        name: s.name?.trim() || parseName(s.address) || `Store ${id}`,
        region: isCatchAll ? existing?.region : area.name,
        suburb: parseSuburb(s.address),
        address: s.address,
      });
    }
  }
  return [...byId.values()];
}

/** Filter stores by a free-text query against name, suburb, region and address. */
export function filterStores(stores: CountdownStore[], query?: string): CountdownStore[] {
  const q = query?.trim().toLowerCase();
  if (!q) return stores;
  return stores.filter((s) =>
    `${s.name} ${s.suburb ?? ''} ${s.region ?? ''} ${s.address ?? ''}`.toLowerCase().includes(q),
  );
}

// The pickup `address` is a messy comma-joined string, e.g.
//   "4 Williamson Avenue,Ponsonby,Ponsonby Click and Collect,1021,Ponsonby"
// The second field is usually the suburb; the store `name` field is cleaner, so
// these parsers are only best-effort fallbacks for display/matching.
function parseSuburb(address?: string): string | undefined {
  const parts = address?.split(',').map((p) => p.trim()).filter(Boolean);
  return parts && parts.length > 1 ? parts[1] : undefined;
}

function parseName(address?: string): string | undefined {
  const parts = address?.split(',').map((p) => p.trim()).filter(Boolean);
  return parts?.[0];
}

async function getJson(endpoint: string, cookies: string): Promise<unknown> {
  const res = await fetch(`${COUNTDOWN.origin}${endpoint}`, {
    headers: { ...COUNTDOWN.headers, Cookie: filterCookies(cookies) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${COUNTDOWN.name}: could not list stores (HTTP ${res.status}).`);
  return res.json();
}

/** The chosen guest store, persisted to `<configDir>/countdown/store.json`.
 *  Name is stored alongside the id so `getStore()` needs no network call. */
export class CountdownStoreConfig {
  private path(): string {
    return join(providerDir(COUNTDOWN.id), 'store.json');
  }

  async resolve(): Promise<StoreInfo | null> {
    try {
      const saved = JSON.parse(await readFile(this.path(), 'utf8')) as Partial<StoreInfo>;
      if (saved.id) return saved as StoreInfo;
    } catch {
      /* not set yet */
    }
    return null;
  }

  async set(store: StoreInfo): Promise<void> {
    await mkdir(providerDir(COUNTDOWN.id), { recursive: true });
    await writeFile(this.path(), JSON.stringify(store, null, 2), 'utf8');
  }
}
