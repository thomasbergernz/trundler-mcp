import { filterCookies } from '../../core/http.js';
import type { Tokens } from '../../core/types.js';
import { COUNTDOWN } from './constants.js';

export interface RawCookie {
  name: string;
  value: string;
}

/** Build persisted Tokens from a Playwright cookie jar. */
export function buildTokens(cookies: RawCookie[]): Tokens {
  const xsrf = cookies.find((c) => c.name === 'XSRF-TOKEN');
  if (!xsrf) {
    throw new Error('XSRF-TOKEN cookie not found — login did not complete');
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const now = Date.now();
  return {
    cookies: cookieHeader,
    xsrfToken: decodeURIComponent(xsrf.value),
    email: null,
    capturedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + COUNTDOWN.tokenTtlMs).toISOString(),
  };
}

/**
 * Confirm the captured cookies represent a logged-in shopper (not just a guest
 * session, which also carries an XSRF token). Runs from Node — a real residential
 * connection — so in-page fetch restrictions don't apply.
 */
export async function verifyTokens(
  tokens: Tokens,
): Promise<{ isLoggedIn: boolean; email: string | null }> {
  const res = await fetch(`${COUNTDOWN.origin}/api/v1/bff/get-user`, {
    headers: {
      'X-Requested-With': 'OnlineShopping.WebApp',
      Cookie: filterCookies(tokens.cookies),
    },
  });
  if (!res.ok) return { isLoggedIn: false, email: null };
  const data = (await res.json().catch(() => ({}))) as {
    isLoggedIn?: boolean;
    email?: string;
  };
  return { isLoggedIn: Boolean(data?.isLoggedIn), email: data?.email ?? null };
}

/** A token is considered stale one minute before its real expiry. */
export function isExpired(tokens: Tokens): boolean {
  return new Date(tokens.expiresAt).getTime() < Date.now() + 60_000;
}
