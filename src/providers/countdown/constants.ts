export const COUNTDOWN = {
  id: 'countdown',
  name: 'Countdown / Woolworths NZ',
  origin: 'https://www.woolworths.co.nz',
  homeUrl: 'https://www.woolworths.co.nz/',
  /** Where the shopper reviews the trolley and completes slot + payment themselves. */
  trolleyUrl: 'https://www.woolworths.co.nz/shop/trolley',
  // Initiating OIDC sign-in as the FIRST navigation avoids HTTP/2 connection-reuse
  // issues and lands directly on the Auth0 login form.
  signinUrl:
    'https://www.woolworths.co.nz/api/v1/bff/initiate-oidc-signin?redirectUrl=https%3A%2F%2Fwww.woolworths.co.nz%2F',

  /** Tokens are treated as valid for this long after capture before a refresh. */
  tokenTtlMs: 3.5 * 60 * 60 * 1000,

  /** Anonymous guest sessions are shorter-lived — re-mint conservatively. */
  guestTtlMs: 25 * 60 * 1000,

  /** Store selection (Click & Collect) — reverse-engineered from the web app and
   *  HAR-verified. All work on an anonymous guest session (no login, no XSRF):
   *  list the pickup addresses, then pin one by PUTting the method + address. */
  stores: {
    /** GET — every Click & Collect pickup address, grouped into regional areas. */
    list: '/api/v1/addresses/pickup-addresses',
    /** PUT (body `{}`) — set the guest fulfilment method to pickup first. */
    setMethod: '/api/v1/fulfilment/my/methods/pickup',
    /** PUT (body `{ addressId }`) — pin the pickup store; prices then follow it. */
    setStore: '/api/v1/fulfilment/my/pickup-addresses',
  },

  /** Headers required by the Woolworths BFF/API. */
  headers: {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'OnlineShopping.WebApp',
    'x-ui-ver': '7.70.51',
    Referer: 'https://www.woolworths.co.nz/',
  } as Record<string, string>,
} as const;
