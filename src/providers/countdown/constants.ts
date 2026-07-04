export const COUNTDOWN = {
  id: 'countdown',
  name: 'Countdown / Woolworths NZ',
  origin: 'https://www.woolworths.co.nz',
  homeUrl: 'https://www.woolworths.co.nz/',
  // Initiating OIDC sign-in as the FIRST navigation avoids HTTP/2 connection-reuse
  // issues and lands directly on the Auth0 login form.
  signinUrl:
    'https://www.woolworths.co.nz/api/v1/bff/initiate-oidc-signin?redirectUrl=https%3A%2F%2Fwww.woolworths.co.nz%2F',

  /** Tokens are treated as valid for this long after capture before a refresh. */
  tokenTtlMs: 3.5 * 60 * 60 * 1000,

  /** Headers required by the Woolworths BFF/API. */
  headers: {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'OnlineShopping.WebApp',
    'x-ui-ver': '7.70.51',
    Referer: 'https://www.woolworths.co.nz/',
  } as Record<string, string>,
} as const;
