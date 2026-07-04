import { chromium, type BrowserContext } from 'playwright';
import { log } from '../../core/config.js';
import type { TokenStore } from '../../core/tokenStore.js';
import type { Tokens } from '../../core/types.js';
import { COUNTDOWN } from './constants.js';
import { buildTokens, verifyTokens } from './session.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Assisted login: open a real (headed) browser on the user's own connection,
 * let them sign in (handling MFA/captcha themselves), then capture the session.
 * This is the most bot-resistant approach and stores no password.
 */
export async function interactiveLogin(store: TokenStore): Promise<Tokens> {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    log('Opening Woolworths sign-in — please complete login in the browser window...');
    await page.goto(COUNTDOWN.signinUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const tokens = await waitForLogin(context, 5 * 60_000);

    await store.saveState(await context.storageState());
    await store.saveTokens(tokens);
    log(`Login captured for ${tokens.email ?? 'unknown account'}.`);
    return tokens;
  } finally {
    await browser.close();
  }
}

/**
 * Silent refresh: relaunch headless with the saved storageState and renew the
 * short-lived cookies/XSRF without user interaction. Throws if the underlying
 * session has expired (the caller then prompts for interactiveLogin).
 */
export async function silentRefresh(store: TokenStore): Promise<Tokens> {
  const state = await store.loadState();
  if (!state) throw new Error('no saved session');

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: state as never });
    const page = await context.newPage();
    await page.goto(COUNTDOWN.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3_000);

    const cookies = await context.cookies(COUNTDOWN.origin);
    const tokens = buildTokens(cookies);
    const check = await verifyTokens(tokens);
    if (!check.isLoggedIn) throw new Error('saved session is no longer valid');
    tokens.email = check.email;

    await store.saveState(await context.storageState());
    await store.saveTokens(tokens);
    return tokens;
  } finally {
    await browser.close();
  }
}

/**
 * Poll the browser until a genuine logged-in session appears. A guest session
 * already carries an XSRF-TOKEN, so the real signal is the get-user API check —
 * not the mere presence of a cookie.
 */
async function waitForLogin(context: BrowserContext, timeoutMs: number): Promise<Tokens> {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    const cookies = await context.cookies(COUNTDOWN.origin);
    const hasXsrf = cookies.some((c) => c.name === 'XSRF-TOKEN');

    if (hasXsrf) {
      const tokens = buildTokens(cookies);
      const check = await verifyTokens(tokens);
      if (check.isLoggedIn) {
        tokens.email = check.email;
        return tokens;
      }
      if (polls % 5 === 0) log('Waiting for you to finish signing in...');
    } else if (polls % 5 === 0) {
      log('Waiting for the sign-in page to load...');
    }

    polls++;
    await sleep(2_000);
  }
  throw new Error('Timed out after 5 minutes waiting for login. Please run login again.');
}
