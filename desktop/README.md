# Trundler Desktop

Tauri v2 desktop shell for the [`web/`](../web) chat app. **No bundled
Chromium**: the window is the OS system webview (WKWebView on macOS, WebView2
on Windows, WebKitGTK on Linux), patched by the OS/browser vendor — not by us.
The backend is the unmodified web server, bundled and spawned as a **Node
sidecar**; the shell just picks a free localhost port, starts it, waits for it
to listen, and opens a window.

```
Trundler.app
├─ trundler-desktop (Rust shell, ~6 MB)
├─ node             (official Node runtime sidecar)
└─ Resources/server/
   ├─ server.mjs    (esbuild bundle of web/server.ts)
   ├─ public/       (the web UI)
   └─ node_modules/playwright{,-core}   (kept on disk — the Woolworths login
                                         resolves playwright's cli.js at runtime)
```

Woolworths login is unchanged: the sidecar launches Playwright's own headed
Chromium for you to sign in (first login downloads it, ~150 MB). LLM keys and
sessions live where the web app keeps them (`~/.config/trundler/`).

## Build & run

Prereqs: Node ≥ 20, Rust (rustup). Linux additionally needs `libwebkit2gtk-4.1-dev`.

```bash
# once, from repo root
npm install

# desktop
cd desktop
npm install
npm run fetch-node     # downloads the Node sidecar for this machine
npm run dev            # dev build + window
npm run build          # → src-tauri/target/release/bundle/macos/Trundler.app
```

`npm run fetch-node -- --all` fetches sidecars for all targets
(mac arm64/x64, Windows x64, Linux x64) for cross-builds.

### Dev tips

- The frontend is served by the sidecar — UI changes only need
  `node scripts/build-server.mjs` (or restart `npm run dev`, which runs it).
- To iterate against a live web dev server instead of the bundled sidecar:
  run `cd web && npm run dev`, then
  `TRUNDLER_DESKTOP_EXTERNAL=http://127.0.0.1:4173 npm run dev`.

## Caveats (v1)

- Unsigned builds: macOS Gatekeeper needs right-click → Open the first time.
  Signing/notarization and auto-update are out of scope for now.
- The Playwright login Chromium is a separate, user-facing browser used only
  for sign-in; refresh it occasionally with `npx playwright install chromium`.
- Server binds `127.0.0.1` on a random free port; the API is reachable by
  other local processes (same trust model as the web app).
