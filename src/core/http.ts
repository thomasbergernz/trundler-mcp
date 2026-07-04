/**
 * Akamai bot-detection cookies embed browser TLS-fingerprint data. When Node's
 * fetch() replays them, its TLS fingerprint doesn't match, so Akamai hangs or
 * blocks the request. Stripping them leaves the session/auth cookies intact and
 * the API responds normally. (Discovered in the original chrome-cdp build.)
 */
const AKAMAI_COOKIE_NAMES = new Set(['_abck', 'ak_bmsc', 'bm_sv', 'bm_sz']);

export function filterCookies(cookieHeader: string): string {
  return cookieHeader
    .split('; ')
    .filter((c) => !AKAMAI_COOKIE_NAMES.has(c.split('=')[0]))
    .join('; ');
}
