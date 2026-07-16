# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@auckland-ai-collective/trundler-mcp` — a local stdio MCP server for NZ grocery shopping providers (Countdown/Woolworths with full login+cart, New World and Pak'nSave read-only). The published bin `trundler-mcp` is the stdio server; `trundler` is the setup CLI. The server id and on-disk folder use the short name `trundler`.

## Commands

```bash
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm run dev            # run stdio server from TS source (tsx src/index.ts)
npm run cli login      # Countdown browser login (or: node dist/cli.js login)
npm run cli check      # verify stored session
node smoke-test.mjs    # spawns built server over stdio, lists tools, exercises a couple (needs build + stored login)
node pns-test.mjs      # exercises Pak'nSave provider directly against dist/ (needs build)
```

There is no test framework or linter — verification is `npm run typecheck` plus the standalone `*.mjs` smoke scripts (which hit live provider APIs).

## Architecture

Provider-plugin design: MCP tools are provider-agnostic and dispatch by an optional `provider` argument (default `countdown`).

- `src/core/provider.ts` — `ShoppingProvider` interface (the contract) and `ProviderRegistry`. Optional capabilities (`listStores`/`setStore`) are optional methods; unsupported capabilities throw, which surfaces as a tool error.
- `src/core/types.ts` — shared domain types (`Product`, `Cart`, `ProductList`, …) that providers normalize their native APIs into.
- `src/providers/index.ts` — `buildRegistry()` registers all providers; `DEFAULT_PROVIDER`.
- `src/providers/countdown/` — authenticated provider. `login.ts` opens a real Playwright browser (persistent profile, user signs in themselves, no password stored); `session.ts` stores captured cookies + XSRF token; API calls are plain `fetch()` afterwards, with silent headless refresh when tokens go stale. Only provider with a **writable cart** (`cartAdd/Update/Remove/Get` plus batch `cartAddMany`/`cartClear`/`reorderUsuals`). Cart-write is Countdown-only; **checkout, delivery-slot booking and payment are deliberately out of scope** — the batch results carry a `reviewUrl` (the trolley page) and the shopper finishes there. The server instructions encode this hard boundary.
- `src/providers/foodstuffs/` — one `FoodstuffsProvider` class parameterized by a banner config (`banners.ts` defines New World and Pak'nSave). Anonymous guest token minted by loading the store homepage **via `curl`** (Cloudflare rejects Node's `fetch` for that page), cached ~30 min. Pricing is per-store; the selected store is persisted per provider.
- `src/providers/shopify/` — generic `ShopifyProvider` over any Shopify storefront's public JSON (`products.json`, `collections.json`, `search/suggest.json`); `stores.ts` defines Ceres. Read-only, anonymous. Search uses `suggest.json` fast-path (≤10, no unit price) and falls back to a cached full-catalog crawl for larger/specials queries; specials = variant `compare_at_price > price`.
- `src/providers/woocommerce/` — generic `WooCommerceProvider` over the public `wc/store/v1` REST API; `stores.ts` defines Naturally Organic. Read-only, anonymous; specials via `on_sale=true`; totals from the `X-WP-Total` header. Uses the `curl` helper (host serves a broken TLS chain).
- `src/providers/warehouse/` — one-off `WarehouseProvider` for The Warehouse (Salesforce Commerce Cloud / SFRA). No public product JSON, so it scrapes the `data-gtm-product` payload SFRA embeds in each result tile (`/search?q=` or `?cgid=foodhouseholdpets`, 32/page). Read-only, anonymous; fetches via `curlGet` (the Cloudflare edge 403s Node's fetch) with 429 back-off. Results filtered to the `foodhouseholdpets` department (spans food/household/pets); no reliable was-price for specials.
- `src/providers/farro/` — one-off `FarroProvider` for Farro's bespoke "Olympic Trader" Blazor backend. `POST /api/ViewModel/Search/Search` (header `x-tradingentity-id: Olympic-1234`) for search/browse (Category facet); specials are the `onSale` products scanned from that catalog (no server-side specials filter exists).
- `src/core/curl.ts` — shared `curlGet()` (status + headers + body) for hosts whose incomplete TLS chain Node's `fetch` rejects (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Same no-extra-deps escape hatch as the Foodstuffs token mint.
- `src/mcp/server.ts` — `buildServer()` registers all tools and the server-level presentation instructions (letter labels, unit-price sorting, product links). Version is read from `package.json` at runtime.
- Entry points: `src/index.ts` (stdio server bin), `src/cli.ts` (setup CLI), `src/lib.ts` (side-effect-free library export: `buildServer`, `buildRegistry`, types).

Session/config state lives outside the repo: `~/.config/trundler/<provider>/` (macOS/Linux) or `%LOCALAPPDATA%\trundler\<provider>\` (Windows).

## Rules that matter here

- **Never write to stdout in server code** — stdout carries the MCP protocol. Use `log()` from `src/core/config.ts` (stderr).
- After changing server-level code (tool schemas, instructions), rebuild and **reconnect** the MCP client — instructions/tool lists are sent once at connect time.
- ESM throughout (`"type": "module"`, NodeNext): intra-project imports need `.js` extensions.
- Chromium is downloaded lazily on first `login`, never at install time. Keep the package lightweight; don't add postinstall downloads.
- `TRUNDLER_NEWWORLD_STORE_ID` / `TRUNDLER_PAKNSAVE_STORE_ID` env vars are test-only overrides — never make them a shipped default.

## Adding a provider

Implement `ShoppingProvider` in `src/providers/<name>/`, register in `src/providers/index.ts`. Adding a store on an existing platform is config-only: a Foodstuffs banner (`foodstuffs/banners.ts`), a Shopify store (`shopify/stores.ts`), or a WooCommerce shop (`woocommerce/stores.ts`).
