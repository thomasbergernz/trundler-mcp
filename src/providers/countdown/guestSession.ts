import { curlGet } from '../../core/curl.js';
import type { Tokens } from '../../core/types.js';
import { COUNTDOWN } from './constants.js';
import type { RawCookie } from './session.js';

/**
 * Mint an anonymous guest session for read-only Woolworths calls (search,
 * specials, browse). The read API accepts requests with just the app headers —
 * no login, no prior cookies (verified live: /api/v1/products returns 200 with
 * real prices). Prices are bound to Woolworths' DEFAULT fulfilment context for
 * the connection (roughly IP-geolocated) — unless a store is pinned here.
 *
 * We still capture the session cookies the first response sets (aga,
 * ASP.NET_SessionId, …) and replay them on subsequent calls, so paginated
 * requests (specials pages) stay within one server-side session/store context
 * instead of minting a new one per request. XSRF is not needed for GETs.
 *
 * When `pinAddressId` is supplied, the freshly minted session is pinned to that
 * Click & Collect store (`PUT methods/pickup` then `PUT pickup-addresses`,
 * HAR-verified as the site's own flow) so subsequent reads price at that
 * branch. These PUTs run on the ANONYMOUS session only — never a logged-in one,
 * where they would mutate the shopper's real account fulfilment.
 *
 * Cart and order history are NOT available to a guest — those keep the
 * interactive login.
 */
export async function mintGuestTokens(pinAddressId?: string): Promise<Tokens> {
  const probe = `${COUNTDOWN.origin}/api/v1/bff/get-user`;

  // Primary: plain Node fetch (works today). Fallback: system curl, in case
  // Akamai starts rejecting Node's TLS fingerprint like the Foodstuffs homepage.
  let setCookies: string[] | null = null;
  try {
    const res = await fetch(probe, {
      headers: COUNTDOWN.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) setCookies = res.headers.getSetCookie();
  } catch {
    /* fall through to curl */
  }
  if (setCookies === null) {
    const res = await curlGet(probe, { http11: true });
    if (res.status !== 200) {
      throw new Error(
        `${COUNTDOWN.name}: could not mint a guest session (HTTP ${res.status}) — ` +
          `possible bot-management block or site change. Reads need the "login" tool until this works.`,
      );
    }
    setCookies = res.setCookies;
  }

  const jar = new CookieJar(parseSetCookies(setCookies));
  if (pinAddressId) await pinStore(jar, pinAddressId);

  const now = Date.now();
  return {
    cookies: jar.header(),
    // GET-only usage — no XSRF header required (and guests get one lazily anyway).
    xsrfToken: '',
    email: null,
    capturedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + COUNTDOWN.guestTtlMs).toISOString(),
  };
}

/** Pin the guest session to a pickup store, merging any cookies each PUT sets. */
async function pinStore(jar: CookieJar, addressId: string): Promise<void> {
  await guestPut(jar, COUNTDOWN.stores.setMethod, {});
  await guestPut(jar, COUNTDOWN.stores.setStore, { addressId: Number(addressId) });
}

async function guestPut(jar: CookieJar, endpoint: string, body: unknown): Promise<void> {
  const res = await fetch(`${COUNTDOWN.origin}${endpoint}`, {
    method: 'PUT',
    headers: { ...COUNTDOWN.headers, Cookie: jar.header() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  // A failed pin is not fatal — reads still work at the default store — but the
  // caller loses the chosen branch, so surface it.
  if (!res.ok) {
    throw new Error(`${COUNTDOWN.name}: could not pin store (HTTP ${res.status} on ${endpoint}).`);
  }
  jar.merge(res.headers.getSetCookie());
}

/** A tiny mutable cookie jar: last write per name wins, emits a Cookie header. */
class CookieJar {
  private readonly map = new Map<string, string>();
  constructor(initial: RawCookie[]) {
    for (const c of initial) this.map.set(c.name, c.value);
  }
  merge(setCookies: string[]): void {
    for (const c of parseSetCookies(setCookies)) this.map.set(c.name, c.value);
  }
  header(): string {
    return [...this.map].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** `Set-Cookie: name=value; Path=/; …` values → name/value pairs. */
function parseSetCookies(setCookies: string[]): RawCookie[] {
  const out: RawCookie[] = [];
  for (const line of setCookies) {
    const first = line.split(';', 1)[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() });
  }
  return out;
}
