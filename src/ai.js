/* ai.js — the chat panel and settings modal.
   The model never touches the data directly: it returns a JSON list of ops,
   which we run through the same applyOps() the buttons use. Every AI turn is
   snapshotted first, so a bad edit is one Undo away. */
'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const history = [];      // {role, content} pairs sent to the provider
  let settings = { provider: 'anthropic', hasAnthropic: false, hasOpenAI: false, model: '', encryptionAvailable: true };

  /* ---------- prompt ---------- */
  function treeSnapshot() {
    return {
      today: new Date().toISOString().slice(0, 10),
      projects: window.Store.State.data.projects.map(p => ({
        id: p.id,
        name: p.name,
        tasks: p.tasks.map(t => ({ id: t.id, name: t.name, status: t.status, due: t.due || null }))
      }))
    };
  }

  const SYSTEM = `You are the built-in assistant for TaskBranch, a desktop app that shows a person's projects and tasks as a horizontal tree. You help them inspect and edit that tree.

You MUST reply with a single JSON object and nothing else — no prose outside the JSON, no markdown fences. Shape:
{"reply": "<a short, friendly sentence or two for the user>", "ops": [ ...zero or more operations... ]}

Available operations:
{"op":"add_project","name":"..."}
{"op":"rename_project","project":"<id or name>","name":"..."}
{"op":"delete_project","project":"<id or name>"}
{"op":"add_task","project":"<id or name>","name":"...","status":"Not started|In progress|Done","due":"YYYY-MM-DD or empty"}
{"op":"update_task","task":"<id or name>","name":"...","status":"...","due":"YYYY-MM-DD or empty","project":"<id or name to move it to>"}
{"op":"delete_task","task":"<id or name>"}

Rules:
- Prefer ids over names when you have them; ids are exact.
- Only include the fields you are actually changing in update_task.
- Status must be exactly one of: Not started, In progress, Done.
- Dates are absolute YYYY-MM-DD. Resolve relative dates ("next Friday", "in a month") against the "today" field in the tree data.
- If the user only asks a question (e.g. "what's overdue?"), answer it in "reply" and return an empty ops array.
- If a request is ambiguous or you cannot find the item, do not guess destructively: return empty ops and ask a clarifying question in "reply".
- Never delete anything unless the user clearly asked for a deletion.
- Keep "reply" brief. The app shows the user a separate list of what changed, so do not enumerate the edits again.`;

  function parseResponse(text) {
    let s = (text || '').trim();
    // Models sometimes wrap JSON in fences despite instructions.
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Model did not return JSON.');
    const obj = JSON.parse(s.slice(start, end + 1));
    return { reply: obj.reply || '', ops: Array.isArray(obj.ops) ? obj.ops : [] };
  }

  /* ---------- rendering ---------- */
  function addMsg(role, text, extras) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const who = role === 'user' ? 'You' : role === 'err' ? 'Error' : 'Assistant';
    wrap.innerHTML = `<div class="who">${who}</div><div class="bubble"></div>`;
    wrap.querySelector('.bubble').textContent = text;

    if (extras && (extras.applied?.length || extras.failed?.length)) {
      const ops = document.createElement('div');
      ops.className = 'ops';
      for (const a of extras.applied || []) {
        const d = document.createElement('div');
        d.innerHTML = '✓ ';
        d.appendChild(document.createTextNode(a));
        ops.appendChild(d);
      }
      for (const f of extras.failed || []) {
        const d = document.createElement('div');
        d.style.color = 'var(--overdue)';
        d.textContent = '✕ ' + f;
        ops.appendChild(d);
      }
      if (extras.applied?.length) {
        const b = document.createElement('button');
        b.className = 'ghost undoBtn';
        b.textContent = 'Undo these changes';
        b.onclick = () => {
          if (window.Store.undo()) { b.disabled = true; b.textContent = 'Undone'; }
        };
        ops.appendChild(b);
      }
      wrap.querySelector('.bubble').appendChild(ops);
    }

    $('log').appendChild(wrap);
    $('log').scrollTop = $('log').scrollHeight;
    return wrap;
  }

  /* ---------- send ---------- */
  async function send() {
    const box = $('input');
    const text = box.value.trim();
    if (!text) return;

    const hasKey = settings.provider === 'anthropic' ? settings.hasAnthropic : settings.hasOpenAI;
    if (!hasKey) {
      addMsg('err', `No API key saved for ${settings.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}. Click Settings to add one.`);
      openSettings();
      return;
    }

    box.value = '';
    addMsg('user', text);
    const thinking = addMsg('assistant', '…');
    $('send').disabled = true;

    // The tree is re-sent every turn so the model always sees current state.
    const userTurn = `Current tree:\n${JSON.stringify(treeSnapshot())}\n\nUser message: ${text}`;
    history.push({ role: 'user', content: userTurn });

    const res = await window.api.ai.chat({ system: SYSTEM, messages: history.slice(-8) });
    $('send').disabled = false;
    thinking.remove();

    if (!res.ok) { addMsg('err', res.error); history.pop(); return; }

    let parsed;
    try {
      parsed = parseResponse(res.text);
    } catch (e) {
      addMsg('err', e.message + '\n\nRaw response:\n' + (res.text || '').slice(0, 500));
      return;
    }
    history.push({ role: 'assistant', content: res.text });

    let extras = null;
    if (parsed.ops.length) {
      window.Store.snapshot();
      extras = window.Store.applyOps(parsed.ops);
      if (!extras.applied.length) window.Store.State.undoStack.pop(); // nothing changed
      window.Store.refresh();
    }
    addMsg('assistant', parsed.reply || 'Done.', extras);
  }

  /* ---------- settings ---------- */
  async function loadSettings() {
    settings = await window.api.settings.load();
    const label = settings.provider === 'anthropic' ? 'Claude' : 'ChatGPT';
    const hasKey = settings.provider === 'anthropic' ? settings.hasAnthropic : settings.hasOpenAI;
    $('provPill').textContent = hasKey ? label + (settings.model ? ` · ${settings.model}` : '') : 'not configured';
  }

  function openSettings() {
    $('setProvider').value = settings.provider;
    $('setModel').value = settings.model || '';
    $('setKey').value = '';
    updateKeyState();
    $('encNote').innerHTML = settings.encryptionAvailable
      ? 'Keys are encrypted at rest using the macOS Keychain.'
      : '<span class="warn">Keychain encryption is unavailable on this system — the key would be stored as plain text in the app support folder.</span>';
    $('modalWrap').classList.add('show');
    setTimeout(() => $('setKey').focus(), 50);
  }

  function updateKeyState() {
    const p = $('setProvider').value;
    const has = p === 'anthropic' ? settings.hasAnthropic : settings.hasOpenAI;
    $('keyState').textContent = has
      ? 'A key is already saved. Leave blank to keep it.'
      : (p === 'anthropic'
        ? 'Get one at console.anthropic.com → API Keys.'
        : 'Get one at platform.openai.com → API Keys.');
    $('setKey').placeholder = p === 'anthropic' ? 'sk-ant-…' : 'sk-…';
  }

  async function saveSettings() {
    const provider = $('setProvider').value;
    const key = $('setKey').value.trim();
    const patch = { provider, model: $('setModel').value.trim(), keys: {} };
    if (key) patch.keys[provider === 'anthropic' ? 'anthropic' : 'openai'] = key;
    await window.api.settings.save(patch);
    await loadSettings();
    $('modalWrap').classList.remove('show');
  }

  /* ---------- wiring ---------- */
  function boot() {
    $('send').onclick = send;
    $('input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    document.querySelectorAll('.chip').forEach(c => {
      c.onclick = () => { $('input').value = c.textContent; $('input').focus(); };
    });
    $('clearChat').onclick = () => { history.length = 0; $('log').textContent = ''; };

    $('chatBtn').onclick = () => {
      const hidden = $('chat').classList.toggle('hidden');
      $('chatBtn').classList.toggle('on', !hidden);
      setTimeout(() => window.Store.fit(), 30);
    };
    $('settingsBtn').onclick = openSettings;
    $('setCancel').onclick = () => $('modalWrap').classList.remove('show');
    $('setSave').onclick = saveSettings;
    $('setProvider').onchange = updateKeyState;
    $('modalWrap').addEventListener('click', e => {
      if (e.target === $('modalWrap')) $('modalWrap').classList.remove('show');
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $('modalWrap').classList.remove('show');
    });

    window.api.on('menu:settings', openSettings);
    window.api.on('menu:toggle-chat', () => $('chatBtn').click());

    loadSettings();
    addMsg('assistant', 'Tell me what to change and I\'ll edit the tree — "mark the dental clinic task done", "add a Thesis Defense project with three tasks", "push everything in Bureaucratic to next month". You can also ask questions like "what\'s overdue?".\n\nAdd your Claude or OpenAI key in Settings first.');
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
