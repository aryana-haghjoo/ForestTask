'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const USER_DIR = () => app.getPath('userData');
const DATA_FILE = () => path.join(USER_DIR(), 'taskbranch-data.json');
const SETTINGS_FILE = () => path.join(USER_DIR(), 'taskbranch-settings.json');
const SEED_FILE = path.join(__dirname, '..', 'src', 'seed.json');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('read failed', file, e);
  }
  return fallback;
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

async function callAnthropic(key, model, system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-5',
      max_tokens: 2000,
      system,
      messages
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

async function callOpenAI(key, model, system, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: [{ role: 'system', content: system }, ...messages],
      response_format: { type: 'json_object' }
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.choices?.[0]?.message?.content || '';
}

function loadSettingsRaw() {
  return readJSON(SETTINGS_FILE(), { provider: 'anthropic', model: '', keys: {}, encrypted: false });
}

function decryptKey(stored, encrypted) {
  if (!stored) return '';
  if (!encrypted) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch (e) {
    return '';
  }
}

function setupIPCHandlers() {
  ipcMain.handle('data:load', () => {
    const existing = readJSON(DATA_FILE(), null);
    if (existing && Array.isArray(existing.projects)) return existing;
    const seed = readJSON(SEED_FILE, { version: 1, projects: [] });
    writeJSON(DATA_FILE(), seed);
    return seed;
  });

  ipcMain.handle('data:save', (_e, data) => writeJSON(DATA_FILE(), data));

  ipcMain.handle('data:reseed', () => {
    const seed = readJSON(SEED_FILE, { version: 1, projects: [] });
    writeJSON(DATA_FILE(), seed);
    return seed;
  });

  ipcMain.handle('data:path', () => DATA_FILE());
  ipcMain.handle('data:reveal', () => { shell.showItemInFolder(DATA_FILE()); });

  ipcMain.handle('data:export', async (_e, data) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export tree',
      defaultPath: 'taskbranch-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import tree',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths.length) return { ok: false };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      if (!Array.isArray(parsed.projects)) throw new Error('Missing "projects" array');
      return { ok: true, data: parsed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('settings:load', () => {
    const s = loadSettingsRaw();
    const anthropic = decryptKey(s.keys.anthropic, s.encrypted);
    const openai = decryptKey(s.keys.openai, s.encrypted);
    return {
      provider: s.provider || 'anthropic',
      model: s.model || '',
      hasAnthropic: !!anthropic,
      hasOpenAI: !!openai,
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    };
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const s = loadSettingsRaw();
    const canEncrypt = safeStorage.isEncryptionAvailable();
    const out = {
      provider: patch.provider || s.provider || 'anthropic',
      model: patch.model !== undefined ? patch.model : s.model || '',
      keys: { ...s.keys },
      encrypted: canEncrypt
    };
    for (const p of ['anthropic', 'openai']) {
      const incoming = patch.keys && patch.keys[p];
      let plain;
      if (incoming !== undefined && incoming !== null) plain = incoming;
      else plain = decryptKey(s.keys[p], s.encrypted);
      if (!plain) { delete out.keys[p]; continue; }
      out.keys[p] = canEncrypt ? safeStorage.encryptString(plain).toString('base64') : plain;
    }
    writeJSON(SETTINGS_FILE(), out);
    return { ok: true, encryptionAvailable: canEncrypt };
  });

  ipcMain.handle('ai:chat', async (_e, { system, messages }) => {
    const s = loadSettingsRaw();
    const provider = s.provider || 'anthropic';
    const key = decryptKey(s.keys[provider === 'anthropic' ? 'anthropic' : 'openai'], s.encrypted);
    if (!key) return { ok: false, error: `No API key saved for ${provider}. Open Settings and add one.` };
    try {
      const text = provider === 'anthropic'
        ? await callAnthropic(key, s.model, system, messages)
        : await callOpenAI(key, s.model, system, messages);
      return { ok: true, text, provider };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function buildMenu() {
  const send = channel => () => win && win.webContents.send(channel);
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: send('menu:new-project') },
        { label: 'New Task…', accelerator: 'CmdOrCtrl+T', click: send('menu:new-task') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+O', click: send('menu:import') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+S', click: send('menu:export') },
        { type: 'separator' },
        { label: 'Reveal Data File', click: () => shell.showItemInFolder(DATA_FILE()) }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Fit to Window', accelerator: 'CmdOrCtrl+0', click: send('menu:fit') },
        { label: 'Toggle Chat', accelerator: 'CmdOrCtrl+J', click: send('menu:toggle-chat') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('menu:settings') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  setupIPCHandlers();
  createWindow();
  buildMenu();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
