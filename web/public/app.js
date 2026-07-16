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
const dialog = document.getElementById('settingsDialog');

const history = []; // {role:'user'|'assistant', content}

function scrollDown() { chat.scrollTop = chat.scrollHeight; }

function addBubble(role) {
  welcome?.remove();
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
      body: JSON.stringify({ messages: history }),
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
document.querySelectorAll('.chip').forEach((c) =>
  c.addEventListener('click', () => { send(c.textContent); }));

// ---------- login pill ----------
async function refreshLogin() {
  try {
    const s = await (await fetch('/api/login-status')).json();
    if (s.isLoggedIn) {
      loginPill.textContent = 'Woolworths: ' + (s.email || 'signed in');
      loginPill.classList.add('in');
      loginPill.dataset.state = 'in';
    } else {
      loginPill.textContent = 'Log in to Woolworths';
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

// ---------- settings ----------
async function loadSettings() {
  const s = await (await fetch('/api/settings')).json();
  document.getElementById('providerSel').value = s.provider;
  document.getElementById('modelInput').value = s.model;
  document.getElementById('keyHint').textContent = s.hasKey
    ? 'A key is saved. Leave blank to keep it.'
    : 'No key saved yet — paste one to start.';
}
settingsBtn.addEventListener('click', async () => { await loadSettings(); dialog.showModal(); });
document.getElementById('saveSettings').addEventListener('click', async (e) => {
  e.preventDefault();
  const payload = {
    provider: document.getElementById('providerSel').value,
    model: document.getElementById('modelInput').value,
    apiKey: document.getElementById('keyInput').value,
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  document.getElementById('keyInput').value = '';
  dialog.close();
});

// ---------- boot ----------
refreshLogin();
// nudge the user to set a key on first run
(async () => {
  const s = await (await fetch('/api/settings')).json();
  if (!s.hasKey) { await loadSettings(); dialog.showModal(); }
})();
