# Trundler Web

A **local, single-user** chat web app for the trundler grocery providers. It
reproduces the Claude Code experience — search, multi-store price comparison,
budget specials basket, and Woolworths browser login — driven by your own
**free Groq or OpenRouter tokens**.

It reuses the parent library in-process (no stdio MCP, no changes to the
published `trundler-mcp` package).

## Run

```bash
# from the repo root — build the library once so web/ can import it
npm install
npm run build          # optional in dev; web/ imports ../src via tsx

# then start the web app
cd web
npm install
npm run dev            # → http://127.0.0.1:4173  (override port: TRUNDLER_WEB_PORT)
```

Open http://127.0.0.1:4173. On first run the Settings dialog opens — pick a
provider, paste a free API key, and choose a **tool-capable** model:

- **Groq**: `llama-3.3-70b-versatile` (default) works most of the time, but the
  Llama models occasionally emit a malformed tool call that Groq rejects
  (`tool_use_failed`). The app retries once, then asks you to switch. For the
  most reliable tool calling on Groq use **`openai/gpt-oss-20b`** (or `120b`).
- **OpenRouter**: your choice — but note some free models do **not** support
  tool calling and won't work.

Then try the example chips, e.g. *"find 1L Sunflower Oil price for shops close
to me"*. The assistant will ask for your suburb, then price it across nearby
stores.

### Woolworths (Countdown)

Click **Log in to Woolworths** (top-right). A real Chrome window opens; sign in
yourself (no password is ever stored). Once signed in, Woolworths appears as a
column in comparisons. **Log out** clears the stored session
(`~/.config/trundler/countdown/`); your remembered browser profile stays so the
next sign-in is quick.

New World, Pak'nSave and The Warehouse need no login.

## How it works

- `mcpBridge.ts` boots the real `buildServer()` and connects an in-process MCP
  `Client` over a linked in-memory transport. Tool schemas and the presentation
  instructions come straight from `src/mcp/server.ts` — one source of truth.
- `agent.ts` runs an OpenAI-style tool loop over the exposed read/compare/basket
  tools and streams progress to the browser over SSE.
- `llm.ts` talks to Groq / OpenRouter (OpenAI-compatible `/chat/completions`).
- The frontend (`public/`) is dependency-free vanilla JS with a small built-in
  markdown renderer (tables + links), so it works fully offline.

Cart writes and checkout are intentionally **out of scope** here.

## Security & privacy

- **Bound to `127.0.0.1` only.** The server holds your LLM API key and can drive
  a logged-in grocery session. Do not expose it off-machine (no reverse proxy /
  `0.0.0.0`).
- **API key is stored in plaintext** at `<configDir>/web.json` (e.g.
  `~/.config/trundler/web.json`), created with mode `0600`. Don't commit it.
- **Your chat messages and tool results — including your suburb and shopping
  lists — are sent to the LLM provider** you configure (Groq or OpenRouter).
  Woolworths credentials are entered directly in the Playwright window and are
  never seen by this app.
