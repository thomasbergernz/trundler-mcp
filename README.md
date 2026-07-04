# trundler

A **local** MCP server for grocery shopping. Runs entirely on your own machine and
residential connection — no cloud services, no datacenter IPs, no bot-detection
logistics. Currently supports **Countdown / Woolworths NZ**, with a provider
abstraction so more supermarkets can be added later.

## How it works

Everything lives in one local process:

- **Browser-assisted login** — `login` opens a real browser window; you sign in
  yourself (handling any MFA/captcha), and trundler captures the session. No
  password is stored. Because the login happens in a real browser on your home
  connection, it's the most bot-resistant approach.
- **Plain HTTP for everything else** — search, specials, cart, and orders are
  authenticated `fetch()` calls using the captured cookies + XSRF token. No
  browser is needed once you're logged in.
- **Silent refresh** — short-lived tokens are renewed by briefly relaunching a
  headless browser with the saved session. If the session has fully expired,
  tools tell the agent to run `login` again.
- **stdio transport** — the agent launches trundler as a subprocess. No ports,
  no CORS, no session server.

Session data is stored per provider outside the repo:

- Windows: `%LOCALAPPDATA%\trundler\<provider>\`
- macOS/Linux: `~/.config/trundler/<provider>/`

## Install

```bash
npm install          # also downloads the Chromium browser (via postinstall)
npm run build
```

If the browser didn't download automatically, run `npx playwright install chromium`.

## First-time login

```bash
npm run cli login          # or: node dist/cli.js login   (after build)
```

A browser window opens — sign in to Woolworths, and the window closes once the
session is captured. Verify any time with:

```bash
npm run cli check
```

## Register with your agent

Add to your MCP config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "trundler": {
      "command": "node",
      "args": ["D:/Projects/MCP/trundler/dist/index.js"]
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
      "args": ["tsx", "D:/Projects/MCP/trundler/src/index.ts"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `login` | Open a browser to sign in |
| `check_login` | Verify the stored session |
| `search_products` | Search by keyword |
| `get_specials` | Current specials (paginated) |
| `browse_products` | Browse by department |
| `cart_get` / `cart_add` / `cart_update` / `cart_remove` | Manage the cart |
| `list_past_orders` / `list_past_order_items` / `get_order_items` | Order history |

Every tool takes an optional `provider` argument (default: `countdown`).

## Adding a provider

Implement `ShoppingProvider` (see `src/core/provider.ts`) in a new
`src/providers/<name>/` folder and register it in `src/providers/index.ts`. The
MCP tools are provider-agnostic and will dispatch to it automatically.

## Trade-off

trundler refreshes on demand, not on a schedule — it can't renew tokens while
your machine is off, and an expired session needs a quick manual `login`. That's
the cost of staying local and on a residential IP. If you later need unattended
scheduled runs, host it on an always-on machine at home (not a datacenter, or
you reintroduce the bot-detection problem).
