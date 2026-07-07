import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { log, configDir } from '../../core/config.js';
import type { TokenStore } from '../../core/tokenStore.js';
import type { Tokens } from '../../core/types.js';
import { COUNTDOWN } from './constants.js';
import { buildTokens, verifyTokens } from './session.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * On-disk Chrome profile for this app. Using a persistent profile means cookies /
 * "keep me signed in" / device trust survive between logins, so a returning user
 * isn't forced through a full cold sign-in every time.
 *
 * Kept OUTSIDE the provider dir (a sibling of it) so `logout` — which clears the
 * provider dir — does NOT wipe the browser profile. The account stays remembered
 * for the next sign-in even after logging out.
 */
function profileDir(): string {
  return join(configDir(), 'browser-profiles', COUNTDOWN.id);
}

/** Chromium locks a user-data-dir, so only one session may use the profile at a
 *  time. This guards against an interactive login and a silent refresh (or two
 *  logins) colliding on the same profile. */
let profileBusy = false;

/**
 * Ensure Playwright's Chromium is installed before we try to launch it. We do
 * this lazily on first use (instead of a postinstall hook) so that merely
 * depending on this package doesn't force a ~150 MB browser download.
 */
function ensureBrowser(): void {
  let executable: string | undefined;
  try {
    executable = chromium.executablePath();
  } catch {
    executable = undefined;
  }
  if (executable && existsSync(executable)) return;

  log('Chromium not found — downloading it once (first-time setup, ~150 MB)...');
  // playwright >=1.49 dropped './cli.js' from its package "exports" map, so
  // resolve the package dir (via the always-exported package.json) and join cli.js.
  const cli = join(
    dirname(createRequire(import.meta.url).resolve('playwright/package.json')),
    'cli.js',
  );
  execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
}

/**
 * Assisted login: open a real (headed) browser on the user's own connection,
 * let them sign in (handling MFA/captcha themselves), then capture the session.
 * This is the most bot-resistant approach and stores no password.
 */
export async function interactiveLogin(store: TokenStore): Promise<Tokens> {
  ensureBrowser();
  if (profileBusy) throw new Error('A browser session is already open for this profile.');
  profileBusy = true;
  // Persistent profile: reuses the on-disk Chrome profile so a returning user is
  // often still signed in (or only needs a light re-confirm) instead of a full
  // cold login.
  const context = await chromium.launchPersistentContext(profileDir(), { headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    log('Opening Woolworths sign-in — please complete login in the browser window...');
    await page.goto(COUNTDOWN.signinUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const tokens = await waitForLogin(context, 5 * 60_000);

    await store.saveState(await context.storageState());
    await store.saveTokens(tokens);
    log(`Login captured for ${tokens.email ?? 'unknown account'}.`);
    return tokens;
  } finally {
    await context.close();
    profileBusy = false;
  }
}

/**
 * Silent refresh: relaunch headless with the saved storageState and renew the
 * short-lived cookies/XSRF without user interaction. Throws if the underlying
 * session has expired (the caller then prompts for interactiveLogin).
 */
export async function silentRefresh(store: TokenStore): Promise<Tokens> {
  // The persistent profile holds the session; if it was never created there's
  // nothing to refresh (prompt an interactive login instead).
  if (!existsSync(profileDir())) throw new Error('no saved session');

  ensureBrowser();
  if (profileBusy) throw new Error('A browser session is already open for this profile.');
  profileBusy = true;
  const context = await chromium.launchPersistentContext(profileDir(), { headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
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
    await context.close();
    profileBusy = false;
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
