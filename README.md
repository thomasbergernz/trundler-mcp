# trundler-mcp

[![npm version](https://img.shields.io/npm/v/@auckland-ai-collective/trundler-mcp.svg)](https://www.npmjs.com/package/@auckland-ai-collective/trundler-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@auckland-ai-collective/trundler-mcp.svg)](https://www.npmjs.com/package/@auckland-ai-collective/trundler-mcp)
[![license](https://img.shields.io/npm/l/@auckland-ai-collective/trundler-mcp.svg)](./LICENSE)

A **local** MCP server for grocery shopping. Runs entirely on your own machine and
residential connection — no cloud services, no datacenter IPs, no bot-detection
logistics.

> **Published on npm:** [`@auckland-ai-collective/trundler-mcp`](https://www.npmjs.com/package/@auckland-ai-collective/trundler-mcp)
> (repo `trundler-mcp`). Install with `npm install @auckland-ai-collective/trundler-mcp`
> or run it straight away with `npx @auckland-ai-collective/trundler-mcp`.
>
> The running server, its tools, and the on-disk session folder keep the shorter name
> **`trundler`** (the MCP server id is `trundler`, sessions live under `…/trundler/`).

Supported providers:

- **Countdown / Woolworths NZ** — full account access (login + cart + order history)
- **New World** (Foodstuffs) — anonymous price/product browsing
- **Pak'nSave** (Foodstuffs) — anonymous price/product browsing
- **Ceres Organics** — anonymous price/product browsing (Shopify)
- **Farro Fresh** — anonymous price/product browsing
- **Naturally Organic** — anonymous price/product browsing (WooCommerce)

## Providers at a glance

Different chains expose different things, so trundler's capabilities vary by provider.

| Provider | id | Login | Add to cart | Search / specials / browse | Store selection |
|----------|-----|:-----:|:-----------:|:--------------------------:|-----------------|
| Countdown / Woolworths NZ | `countdown` | Not required for reads; browser login for cart + history | ✅ (after login) | ✅ (anonymous) | **Per-store** (guest) — pick one with `set_store`; account store when logged in |
| New World | `newworld` | Not required | ❌ No (read-only) | ✅ (anonymous) | **Per-store** — pick one with `set_store` |
| Pak'nSave | `paknsave` | Not required | ❌ No (read-only) | ✅ (anonymous) | **Per-store** — pick one with `set_store` |
| Ceres Organics | `ceres` | Not required | ❌ No (read-only) | ✅ (anonymous) | National — no store selection |
| Farro Fresh | `farro` | Not required | ❌ No (read-only) | ✅ (anonymous) | National — no store selection |
| Naturally Organic | `naturallyorganic` | Not required | ❌ No (read-only) | ✅ (anonymous) | National — no store selection |

In short:

- **Countdown / Woolworths** — search, specials and browse work with **no login**
  (anonymous guest session). Prices default to Woolworths' IP-located store, or pin a
  specific branch with `list_stores` / `set_store` (still no login). Log in once in a
  real browser to **add items to a real cart** and read your order history; a logged-in
  session prices at your own account store.
- **New World & Pak'nSave** — **no login needed** to search and compare prices, but
  they are **read-only**: you cannot add to a cart or see order history (yet). Because
  Foodstuffs pricing is per-store, you must choose a store first with `set_store`.
- **Ceres, Farro & Naturally Organic** — specialty / organic grocers, also **read-only**
  and **no login needed**. Pricing is national (single online catalogue), so there's no
  store to select — just `search_products`, `get_specials` and `browse_products`.

> **Why the difference?** Countdown authenticates a real user session, which unlocks
> the cart. The Foodstuffs (New World / Pak'nSave) read APIs serve anonymous guests,
> so browsing needs no login — but the cart requires an authenticated session that
> isn't wired up yet (see [Roadmap](#roadmap)).

## How it works

Everything lives in one local process over **stdio** — the agent launches trundler
as a subprocess. No ports, no CORS, no session server. There are two auth models
depending on the provider:

**Countdown / Woolworths — browser-assisted login**

- `login` opens a real browser window; you sign in yourself (handling any
  MFA/captcha), and trundler captures the session. **No password is stored.** Because
  the login happens in a real browser on your home connection, it's the most
  bot-resistant approach.
- Everything after that is authenticated `fetch()` using the captured cookies + XSRF
  token — no browser needed.
- **Silent refresh** renews short-lived tokens by briefly relaunching a headless
  browser with the saved session. If it has fully expired, tools tell the agent to
  run `login` again.

**New World / Pak'nSave — anonymous guest token**

- No login. trundler mints an anonymous guest token by loading the store homepage and
  reading the session cookie it hands out, then calls the read API with plain
  `fetch()`. The token is cached and refreshed automatically (~30-minute life).
- The homepage sits behind Cloudflare bot-management that rejects Node's `fetch`, so
  the token mint shells out to **`curl`** (which passes). `curl` ships with Windows 10
  1803+, macOS, and Linux — no extra install needed on a normal machine.
- Pricing is **per-store**: use `list_stores` to find one and `set_store` to select
  it. Your choice is persisted per provider.

Session/config data is stored per provider outside the repo:

- Windows: `%LOCALAPPDATA%\trundler\<provider>\`
- macOS/Linux: `~/.config/trundler/<provider>/`

## Install

From npm (no build step needed — ships compiled):

```bash
npm install @auckland-ai-collective/trundler-mcp
```

Or run the server directly without installing:

```bash
npx @auckland-ai-collective/trundler-mcp
```

Chromium (used **only** for the Countdown login) is **not** downloaded at install
time. The first time you run `login`, trundler fetches it once (~150 MB) if it's
missing — so merely depending on the package stays lightweight, and New World /
Pak'nSave (which never need a browser) pull nothing extra. To pre-fetch it yourself:
`npx playwright install chromium`.

Building from source instead:

```bash
npm install
npm run build
```

## Register with your agent

Add to your MCP config (e.g. `.mcp.json`). The simplest form runs the published
server straight from npm — no clone, no build:

```json
{
  "mcpServers": {
    "trundler": {
      "command": "npx",
      "args": ["-y", "@auckland-ai-collective/trundler-mcp"]
    }
  }
}
```

Or point at a local build:

```json
{
  "mcpServers": {
    "trundler": {
      "command": "node",
      "args": ["D:/Projects/MCP/trundler-mcp/dist/index.js"]
    }
  }
}
```

During development you can point it at the TypeScript source instead:

```json
{
  "mcpServers": {
    "trundler": {
      "command": "npx",
      "args": ["tsx", "D:/Projects/MCP/trundler-mcp/src/index.ts"]
    }
  }
}
```

> After changing server-level code (including the presentation instructions), rebuild
> (`npm run build`) and **reconnect** the MCP — instructions and tool lists are sent
> once at connection time.

## Use as a library

If you're embedding trundler in your own app (e.g. a shell that mounts the MCP
server in-process rather than spawning it), import from the package root. This entry
point has **no side effects** — importing it starts nothing:

```ts
import {
  buildServer,        // -> McpServer, ready to .connect(transport)
  buildRegistry,      // -> ProviderRegistry of all providers
  DEFAULT_PROVIDER,   // -> "countdown"
} from '@auckland-ai-collective/trundler-mcp';

// Mount on your own transport:
const server = buildServer();
await server.connect(myTransport);

// …or drive a provider directly, bypassing MCP entirely:
const cart = await buildRegistry().get('countdown').cartGet();
```

Types (`ShoppingProvider`, `Cart`, `Product`, …) are exported too. The package ships
its own `.d.ts` declarations. Prefer spawning the process instead? The published
`trundler-mcp` bin is the stdio server; `trundler` is the setup CLI (below).

## Setup per provider

**Countdown / Woolworths** — log in once:

```bash
trundler login             # installed package (bin)
# or, from a source checkout:
npm run cli login          # or: node dist/cli.js login   (after build)
```

A browser window opens — sign in to Woolworths; it closes once the session is
captured. Verify any time with `trundler check` (or `npm run cli check`). The first
`login` also downloads Chromium once if it isn't already present.

**New World / Pak'nSave** — no login; just pick a store. Via your agent:

```
list_stores  { "provider": "newworld", "query": "auckland" }
set_store    { "provider": "newworld", "storeId": "<id from list_stores>" }
```

Do the same with `"provider": "paknsave"` for Pak'nSave. Until a store is set, the
read tools return a "no store selected" error.

For local testing you can pre-seed a store via env var instead of `set_store`:
`TRUNDLER_NEWWORLD_STORE_ID` / `TRUNDLER_PAKNSAVE_STORE_ID`. These are test overrides
only — never a shipped default.

## Tools

Every tool takes an optional `provider` argument (default: `countdown`).

| Tool | Purpose | Providers |
|------|---------|-----------|
| `search_products` | Search by keyword | all |
| `get_specials` | Current specials (paginated) | all |
| `browse_products` | Browse by department / category | all |
| `list_stores` | List a provider's stores (per-store-pricing providers) | newworld, paknsave, countdown |
| `set_store` | Select the active store (persisted) | newworld, paknsave, countdown |
| `login` | Open a browser to sign in | countdown |
| `check_login` | Verify the stored session | countdown |
| `cart_get` / `cart_add` / `cart_update` / `cart_remove` | Manage the cart | countdown |
| `cart_add_many` / `cart_clear` | Build/reset a whole cart at once | countdown |
| `reorder_usuals` | Add your most-frequent items in one call | countdown |
| `list_past_orders` / `list_past_order_items` / `get_order_items` | Order history | countdown |

Calling a login/cart/order tool on any read-only provider (New World, Pak'nSave,
Ceres, Farro, Naturally Organic) returns a clear "requires login — not yet
supported" error rather than failing silently.

## Delegated shopping

You can hand a whole shop to the agent — on Countdown, which is the only provider
with a writable cart. Two paths:

- **Restock your usuals:** `reorder_usuals` adds your most frequently purchased
  in-stock items (the exact SKUs you actually buy) in one call.
- **From a list:** the agent resolves each line with `search_products`, confirms
  anything ambiguous or new, then adds the chosen SKUs with `cart_add_many`
  (`cart_clear` first if you want the trolley to exactly match the list).

Every batch result carries a `reviewUrl` (your Woolworths trolley).

> **Where it stops — on purpose.** trundler fills the trolley and hands back. It
> **does not** pick a delivery slot, submit checkout, place the order, or handle
> payment — there are no tools for those, and the server instructions tell the agent
> not to attempt them. You open the `reviewUrl` to choose a time and pay yourself.

## Product listings

trundler ships server-level instructions telling the agent how to present product
lists: label each item with a capital letter (A, B, C…) for easy quantity-picking,
show **price per unit** and sort cheapest-per-unit first, and include a link to open
each product's photo/detail page. This makes cross-product and cross-chain price
comparison straightforward.

## Adding a provider

Implement `ShoppingProvider` (see `src/core/provider.ts`) in a new
`src/providers/<name>/` folder and register it in `src/providers/index.ts`. The MCP
tools are provider-agnostic and dispatch automatically.

Several providers are already generic over a platform, so adding another store on the
same platform is config-only:

- **Foodstuffs** banners (New World, Pak'nSave) share one `FoodstuffsProvider` — add
  a banner in `src/providers/foodstuffs/banners.ts`.
- **Shopify** storefronts share `ShopifyProvider` (public `products.json` /
  `collections.json` / `search/suggest.json`) — add a store in
  `src/providers/shopify/stores.ts`.
- **WooCommerce** shops share `WooCommerceProvider` (public `wc/store/v1` REST API) —
  add a store in `src/providers/woocommerce/stores.ts`.

Farro runs a bespoke "Olympic Trader" platform, so `FarroProvider` is a one-off.

Capabilities a provider doesn't support (e.g. cart on a read-only provider) simply
throw an error, which surfaces to the agent as a tool error.

> Some stores serve an incomplete TLS certificate chain that Node's `fetch` rejects
> (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). trundler routes those requests through the
> system `curl` (see `src/core/curl.ts`), the same no-extra-deps escape hatch the
> Foodstuffs guest-token mint uses.

## Roadmap

- **Foodstuffs cart & orders (Tier 2).** New World / Pak'nSave cart and order history
  need an authenticated session. Their login exchange is Cloudflare-protected against
  automated browsers, so it must be captured from a genuine browser (connect to your
  real Chrome), not Playwright's bundled Chromium. Not yet implemented.

## Trade-off

trundler refreshes on demand, not on a schedule — for Countdown it can't renew tokens
while your machine is off, and an expired session needs a quick manual `login`. That's
the cost of staying local and on a residential IP. If you later need unattended
scheduled runs, host it on an always-on machine at home (not a datacenter, or you
reintroduce the bot-detection problem).
