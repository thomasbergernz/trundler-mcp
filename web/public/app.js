'use strict';

// ---------- tiny markdown renderer (escape-first, safe innerHTML) ----------
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s) {
  // operates on already-escaped text
  return s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function isTableSep(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html += '<p>' + inline(escapeHtml(para.join(' '))) + '</p>';
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (/^```/.test(line)) {
      flushPara();
      i++;
      let code = [];
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // closing fence
      html += '<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>';
      continue;
    }

    // table: header row + separator
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const header = splitRow(line);
      i += 2;
      let rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      html += '<table><thead><tr>' +
        header.map((h) => '<th>' + inline(escapeHtml(h)) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' +
          r.map((c) => '<td>' + inline(escapeHtml(c)) + '</td>').join('') +
          '</tr>').join('') +
        '</tbody></table>';
      continue;
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      html += `<h${level}>` + inline(escapeHtml(h[2])) + `</h${level}>`;
      i++;
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      let items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      html += '<ul>' + items.map((it) => '<li>' + inline(escapeHtml(it)) + '</li>').join('') + '</ul>';
      continue;
    }

    // blank line
    if (line.trim() === '') { flushPara(); i++; continue; }

    para.push(line);
    i++;
  }
  flushPara();
  return html;
}

// ---------- DOM helpers ----------
const chat = document.getElementById('chat');
const welcome = document.getElementById('welcome');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const composer = document.getElementById('composer');
const loginPill = document.getElementById('loginPill');
const settingsBtn = document.getElementById('settingsBtn');
const newBtn = document.getElementById('newBtn');
const dialog = document.getElementById('settingsDialog');

const welcomeHTML = welcome ? welcome.outerHTML : '';
let history = []; // {role:'user'|'assistant', content}
let sessionOverride = null; // per-chat store override; null => use pinned/region

function scrollDown() { chat.scrollTop = chat.scrollHeight; }

function addBubble(role) {
  document.getElementById('welcome')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  wrap.innerHTML = `<div class="who">${role === 'user' ? '🧑' : '🛒'}</div><div class="body"></div>`;
  chat.appendChild(wrap);
  scrollDown();
  return wrap.querySelector('.body');
}

// ---------- chat send + SSE ----------
let busy = false;

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;

  history.push({ role: 'user', content: text });
  const userBody = addBubble('user');
  userBody.textContent = text;

  const body = addBubble('assistant');
  const status = document.createElement('div');
  status.className = 'status';
  status.innerHTML = '<span class="dot">●</span> thinking…';
  body.appendChild(status);

  let finalContent = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        storesOverride: sessionOverride || undefined,
      }),
    });
    if (!res.ok || !res.body) throw new Error('chat request failed (' + res.status + ')');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const evt = JSON.parse(dataLine.slice(6));
        handleEvent(evt, status, body, (c) => { finalContent = c; });
      }
    }
  } catch (err) {
    status.remove();
    body.innerHTML = renderMarkdown('⚠️ ' + (err.message || String(err)));
  } finally {
    if (finalContent) history.push({ role: 'assistant', content: finalContent });
    busy = false;
    sendBtn.disabled = false;
    scrollDown();
  }
}

function handleEvent(evt, status, body, setFinal) {
  switch (evt.event) {
    case 'thinking':
      status.innerHTML = '<span class="dot">●</span> planning' +
        (evt.tools?.length ? ' — ' + evt.tools.join(', ') : '') + '…';
      break;
    case 'tool_call':
      status.innerHTML = '<span class="dot">🔧</span> ' + evt.name +
        '(' + shortArgs(evt.args) + ')…';
      scrollDown();
      break;
    case 'tool_result':
      status.innerHTML = '<span class="dot">' + (evt.isError ? '⚠️' : '✓') + '</span> ' +
        evt.name + (evt.isError ? ' failed' : ' done');
      break;
    case 'login_required':
      status.innerHTML += ' — <em>Woolworths needs login (top-right)</em>';
      break;
    case 'rate_limited':
      status.innerHTML = '<span class="dot">⏳</span> rate limit — waiting ' +
        (evt.seconds || '?') + 's (free tier)…';
      scrollDown();
      break;
    case 'message':
      status.remove();
      setFinal(evt.content || '');
      body.innerHTML = renderMarkdown(evt.content || '');
      break;
    case 'error':
      status.remove();
      body.innerHTML = renderMarkdown('⚠️ ' + (evt.message || 'error'));
      break;
    case 'done':
      break;
  }
  scrollDown();
}

function shortArgs(args) {
  try {
    const s = JSON.stringify(args);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  } catch { return ''; }
}

// ---------- composer wiring ----------
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  input.style.height = 'auto';
  send(text);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composer.requestSubmit(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});
function wireChips() {
  document.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { send(c.textContent); }));
}
wireChips();

// ---------- new session ----------
function newSession() {
  if (busy) return;
  history = [];
  sessionOverride = null;
  updateScopeBar();
  chat.innerHTML = welcomeHTML;
  wireChips();
  input.value = '';
  input.style.height = 'auto';
  input.focus();
}
newBtn.addEventListener('click', newSession);

// ---------- login pill ----------
async function refreshLogin() {
  try {
    const s = await (await fetch('/api/login-status')).json();
    if (s.isLoggedIn) {
      loginPill.textContent = '⏻ Log out · ' + (s.email || 'Woolworths');
      loginPill.title = 'Signed in to Woolworths — click to log out';
      loginPill.classList.add('in');
      loginPill.dataset.state = 'in';
    } else {
      loginPill.textContent = 'Log in to Woolworths';
      loginPill.title = 'Open a browser window to sign in to Woolworths';
      loginPill.classList.remove('in');
      loginPill.dataset.state = 'out';
    }
  } catch {
    loginPill.textContent = 'Woolworths: ?';
  }
}

loginPill.addEventListener('click', async () => {
  if (loginPill.classList.contains('busy')) return;
  const state = loginPill.dataset.state;
  if (state === 'in' && !confirm('Log out of Woolworths? You will need to sign in again to price Woolworths.')) {
    return;
  }
  loginPill.classList.add('busy');
  try {
    if (state === 'in') {
      await fetch('/api/logout', { method: 'POST' });
    } else {
      loginPill.textContent = 'Opening browser… sign in there';
      await fetch('/api/login', { method: 'POST' });
    }
  } catch { /* surfaced via refresh */ }
  loginPill.classList.remove('busy');
  refreshLogin();
});

// ---------- store picker factory (shared by Settings + per-chat override) ----------
const NATIONAL = { countdown: 'Woolworths', warehouse: 'The Warehouse' };
const storeKey = (s) => s.provider + '|' + (s.storeId || '');
const byId = (id) => document.getElementById(id);

function createPicker(ids) {
  let stores = [];
  const sync = () => {
    byId(ids.tglC).checked = stores.some((s) => s.provider === 'countdown');
    byId(ids.tglW).checked = stores.some((s) => s.provider === 'warehouse');
  };
  const render = () => {
    const box = byId(ids.selected);
    box.innerHTML = '';
    for (const s of stores) {
      const chip = document.createElement('span');
      chip.className = 'store-chip';
      chip.textContent = s.label || s.provider;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.addEventListener('click', () => remove(storeKey(s)));
      chip.appendChild(x);
      box.appendChild(chip);
    }
    byId(ids.hint).textContent = `${stores.length}/5 ${ids.hintSuffix}`;
    sync();
  };
  const add = (s) => {
    if (stores.length >= 5) { alert('Up to 5 stores.'); return false; }
    if (stores.some((x) => storeKey(x) === storeKey(s))) return false;
    stores.push(s);
    render();
    return true;
  };
  const remove = (key) => { stores = stores.filter((s) => storeKey(s) !== key); render(); };

  byId(ids.searchBtn).addEventListener('click', async () => {
    const provider = byId(ids.provider).value;
    const query = byId(ids.query).value.trim();
    const ul = byId(ids.results);
    ul.innerHTML = '<li class="muted">searching…</li>';
    try {
      const url = '/api/stores?provider=' + provider + (query ? '&query=' + encodeURIComponent(query) : '');
      const data = await (await fetch(url)).json();
      ul.innerHTML = '';
      if (!data.stores?.length) { ul.innerHTML = '<li class="muted">no matches</li>'; return; }
      for (const st of data.stores.slice(0, 25)) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = st.name + (st.suburb ? ' · ' + st.suburb : '');
        const addb = document.createElement('button');
        addb.type = 'button';
        addb.textContent = 'Add';
        addb.addEventListener('click', () => add({ provider, storeId: st.id, label: st.name }));
        li.append(name, addb);
        ul.appendChild(li);
      }
    } catch {
      ul.innerHTML = '<li class="muted">lookup failed</li>';
    }
  });

  const wireTgl = (id, provider) =>
    byId(id).addEventListener('change', (e) => {
      if (e.target.checked) { if (!add({ provider, label: NATIONAL[provider] })) e.target.checked = false; }
      else remove(provider + '|');
    });
  wireTgl(ids.tglC, 'countdown');
  wireTgl(ids.tglW, 'warehouse');

  return {
    get: () => stores.slice(),
    set: (a) => { stores = Array.isArray(a) ? a.slice() : []; byId(ids.results).innerHTML = ''; render(); },
  };
}

const settingsPicker = createPicker({
  provider: 'storeProvider', query: 'storeQuery', searchBtn: 'storeSearchBtn', results: 'storeResults',
  tglC: 'tglCountdown', tglW: 'tglWarehouse', selected: 'selectedStores', hint: 'storeHint',
  hintSuffix: 'stores pinned. Pinned override region.',
});
const scopePicker = createPicker({
  provider: 'scProvider', query: 'scQuery', searchBtn: 'scSearchBtn', results: 'scResults',
  tglC: 'scTglCountdown', tglW: 'scTglWarehouse', selected: 'scSelected', hint: 'scHint',
  hintSuffix: 'stores for this chat.',
});

// ---------- settings ----------
let pinnedStores = [];
let savedRegion = '';

async function refreshSettingsCache() {
  const s = await (await fetch('/api/settings')).json();
  pinnedStores = Array.isArray(s.stores) ? s.stores : [];
  savedRegion = s.region || '';
  updateScopeBar();
  return s;
}

async function loadSettings() {
  const s = await refreshSettingsCache();
  byId('providerSel').value = s.provider;
  byId('modelInput').value = s.model;
  byId('regionInput').value = s.region || '';
  byId('keyHint').textContent = s.hasKey
    ? 'A key is saved. Leave blank to keep it.'
    : 'No key saved yet — paste one to start.';
  settingsPicker.set(s.stores || []);
}
settingsBtn.addEventListener('click', async () => { await loadSettings(); dialog.showModal(); });
byId('cancelSettings').addEventListener('click', () => dialog.close());
byId('saveSettings').addEventListener('click', async (e) => {
  e.preventDefault();
  const payload = {
    provider: byId('providerSel').value,
    model: byId('modelInput').value,
    apiKey: byId('keyInput').value,
    region: byId('regionInput').value,
    stores: settingsPicker.get(),
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  byId('keyInput').value = '';
  dialog.close();
  refreshSettingsCache();
});

// ---------- per-chat store override ----------
const labelsOf = (list) => list.map((s) => s.label || s.provider).join(', ');

function updateScopeBar() {
  const reset = byId('scopeReset');
  const text = byId('scopeText');
  if (sessionOverride && sessionOverride.length) {
    text.textContent = 'This chat: ' + labelsOf(sessionOverride);
    reset.hidden = false;
  } else if (pinnedStores.length) {
    text.textContent = 'Stores: ' + labelsOf(pinnedStores);
    reset.hidden = true;
  } else if (savedRegion) {
    text.textContent = 'Region: ' + savedRegion;
    reset.hidden = true;
  } else {
    text.textContent = "No stores set — I'll ask, or pin some in ⚙️";
    reset.hidden = true;
  }
}

byId('scopeEdit').addEventListener('click', () => {
  scopePicker.set(sessionOverride ?? pinnedStores);
  byId('scopeDialog').showModal();
});
byId('scCancel').addEventListener('click', () => byId('scopeDialog').close());
byId('scApply').addEventListener('click', (e) => {
  e.preventDefault();
  const chosen = scopePicker.get();
  sessionOverride = chosen.length ? chosen : null;
  updateScopeBar();
  byId('scopeDialog').close();
});
byId('scopeReset').addEventListener('click', () => { sessionOverride = null; updateScopeBar(); });

// ---------- boot ----------
refreshLogin();
refreshSettingsCache();
// nudge the user to set a key on first run
(async () => {
  const s = await (await fetch('/api/settings')).json();
  if (!s.hasKey) { await loadSettings(); dialog.showModal(); }
})();
