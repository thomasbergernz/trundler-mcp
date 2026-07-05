# trundler-mcp

A **local** MCP server for grocery shopping. Runs entirely on your own machine and
residential connection — no cloud services, no datacenter IPs, no bot-detection
logistics.

> Package: **`@auckland-ai-collective/trundler-mcp`** (repo `trundler-mcp`). The
> running server, its tools, and the on-disk session folder keep the shorter name
> **`trundler`** (the MCP server id is `trundler`, sessions live under `…/trundler/`).

Supported providers:

- **Countdown / Woolworths NZ** — full account access (login + cart + order history)
- **New World** (Foodstuffs) — anonymous price/product browsing
- **Pak'nSave** (Foodstuffs) — anonymous price/product browsing

## Providers at a glance

Different chains expose different things, so trundler's capabilities vary by provider.

| Provider | id | Login | Add to cart | Search / specials / browse | Store selection |
|----------|-----|:-----:|:-----------:|:--------------------------:|-----------------|
| Countdown / Woolworths NZ | `countdown` | **Required** (browser) | ✅ Yes | ✅ (after login) | Automatic (by fulfilment region) |
| New World | `newworld` | Not required | ❌ No (read-only) | ✅ (anonymous) | **Per-store** — pick one with `set_store` |
| Pak'nSave | `paknsave` | Not required | ❌ No (read-only) | ✅ (anonymous) | **Per-store** — pick one with `set_store` |

In short:

- **Countdown / Woolworths** — you log in once in a real browser; after that you can
  search, view specials, and **add items to a real cart** and read your order history.
- **New World & Pak'nSave** — **no login needed** to search and compare prices, but
  they are **read-only**: you cannot add to a cart or see order history (yet). Because
  Foodstuffs pricing is per-store, you must choose a store first with `set_store`.

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

Add to your MCP config (e.g. `.mcp.json`). Once published, the simplest form runs the
server straight from npm:

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
| `list_stores` | List a provider's stores (per-store-pricing providers) | newworld, paknsave |
| `set_store` | Select the active store (persisted) | newworld, paknsave |
| `login` | Open a browser to sign in | countdown |
| `check_login` | Verify the stored session | countdown |
| `cart_get` / `cart_add` / `cart_update` / `cart_remove` | Manage the cart | countdown |
| `list_past_orders` / `list_past_order_items` / `get_order_items` | Order history | countdown |

Calling a login/cart/order tool on New World or Pak'nSave returns a clear
"requires login — not yet supported" error rather than failing silently.

## Product listings

trundler ships server-level instructions telling the agent how to present product
lists: label each item with a capital letter (A, B, C…) for easy quantity-picking,
show **price per unit** and sort cheapest-per-unit first, and include a link to open
each product's photo/detail page. This makes cross-product and cross-chain price
comparison straightforward.

## Adding a provider

Implement `ShoppingProvider` (see `src/core/provider.ts`) in a new
`src/providers/<name>/` folder and register it in `src/providers/index.ts`. The MCP
tools are provider-agnostic and dispatch automatically. Foodstuffs banners (New
World, Pak'nSave) share one `FoodstuffsProvider` parameterised by a banner config —
adding another Foodstuffs banner is a few lines in `src/providers/foodstuffs/banners.ts`.

Capabilities a provider doesn't support (e.g. cart on a read-only provider) simply
throw an error, which surfaces to the agent as a tool error.

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
