/**
 * Local web backend for trundler. Bound to 127.0.0.1 only — it holds the LLM
 * API key and can drive a logged-in Woolworths session, so it must never be
 * reachable off-machine.
 */
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getRegistry } from './mcpBridge.js';
import { runAgent } from './agent.js';
import { loadConfig, saveConfig, type LlmProvider } from './config.js';
import { TokenStore } from '../src/lib.js';
import type { ChatMessage } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TRUNDLER_WEB_PORT) || 4173;
const HOST = '127.0.0.1';
const COUNTDOWN = 'countdown';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

// --- Settings (never returns the raw key) ---
function publicSettings(cfg: Awaited<ReturnType<typeof loadConfig>>) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    hasKey: Boolean(cfg.apiKey),
    region: cfg.region,
    stores: cfg.stores,
  };
}

app.get('/api/settings', async (_req, res) => {
  res.json(publicSettings(await loadConfig()));
});

app.post('/api/settings', async (req, res) => {
  const { provider, model, apiKey, region, stores } = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (provider === 'groq' || provider === 'openrouter') patch.provider = provider as LlmProvider;
  if (typeof model === 'string' && model.trim()) patch.model = model.trim();
  if (typeof apiKey === 'string' && apiKey.length > 0) patch.apiKey = apiKey;
  if (typeof region === 'string') patch.region = region.trim();
  if (Array.isArray(stores)) {
    patch.stores = stores
      .filter((s) => s && typeof s.provider === 'string')
      .slice(0, 5)
      .map((s) => ({
        provider: String(s.provider),
        storeId: typeof s.storeId === 'string' ? s.storeId : undefined,
        label: typeof s.label === 'string' ? s.label : undefined,
      }));
  }
  res.json(publicSettings(await saveConfig(patch)));
});

// --- Store lookup for the Settings picker ---
app.get('/api/stores', async (req, res) => {
  const provider = String(req.query.provider ?? '');
  const query = typeof req.query.query === 'string' ? req.query.query : undefined;
  try {
    const p = (await getRegistry()).get(provider);
    if (!p.listStores) return res.json({ stores: [], count: 0 });
    res.json(await p.listStores(query));
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err), stores: [], count: 0 });
  }
});

// --- Woolworths (countdown) auth ---
app.get('/api/login-status', async (_req, res) => {
  try {
    const status = await (await getRegistry()).get(COUNTDOWN).checkLogin();
    res.json(status);
  } catch (err) {
    res.status(500).json({ isLoggedIn: false, error: String((err as Error).message ?? err) });
  }
});

app.post('/api/login', async (_req, res) => {
  try {
    const provider = (await getRegistry()).get(COUNTDOWN);
    await provider.interactiveLogin(); // headed browser; resolves when signed in
    res.json(await provider.checkLogin());
  } catch (err) {
    res.status(500).json({ isLoggedIn: false, error: String((err as Error).message ?? err) });
  }
});

app.post('/api/logout', async (_req, res) => {
  try {
    await new TokenStore(COUNTDOWN).clear();
    res.json({ ok: true, isLoggedIn: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err as Error).message ?? err) });
  }
});

// --- Chat (SSE) ---
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const emit = (event: string, data: Record<string, unknown> = {}) => {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  };

  try {
    const cfg = await loadConfig();
    if (!cfg.apiKey) {
      emit('error', { message: 'No API key set. Open Settings and paste a Groq or OpenRouter key.' });
      emit('done');
      return res.end();
    }

    const history = (req.body?.messages ?? []) as ChatMessage[];
    if (!Array.isArray(history) || history.length === 0) {
      emit('error', { message: 'No messages provided.' });
      emit('done');
      return res.end();
    }

    await runAgent(history, cfg, emit);
    emit('done');
    res.end();
  } catch (err) {
    emit('error', { message: String((err as Error).message ?? err) });
    emit('done');
    res.end();
  }
});

app.listen(PORT, HOST, () => {
  // stderr, to match the parent's stdout discipline.
  console.error(`[trundler-web] listening on http://${HOST}:${PORT}`);
});
