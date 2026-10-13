'use strict';

const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell,
  Notification,
  safeStorage,
  globalShortcut,
} = require('electron');
const path = require('node:path');

const { createStore } = require('./src/config');
const zabbix = require('./src/zabbix');
const { createGlpiClient } = require('./src/glpi');
const demo = require('./src/demo');

// Tamanho da janela da ilha. A janela é transparente e deixa o mouse passar,
// então esse retângulo todo não atrapalha nada quando a ilha está recolhida.
const ISLAND_W = 640;
const ISLAND_H = 330;
const FORCE_DEMO = process.argv.includes('--demo');

let island = null;
let settingsWin = null;
let tray = null;
let store = null;
let glpi = null;
let pollTimer = null;
let polling = false;
let hidden = false;
let pinned = false;
let firstPoll = true;
const seenProblems = new Set();
const allowedUrls = new Set();

let state = {
  demo: true,
  updatedAt: null,
  zabbix: { enabled: true, items: [], error: null, multi: false },
  glpi: { enabled: true, items: [], error: null },
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId('io.github.victorhugoantonio1.topwatch'); // notificações no Windows

// ---------- janelas ----------

function positionIsland() {
  if (!island) return;
  const { x, y, width } = screen.getPrimaryDisplay().bounds;
  island.setBounds({ x: Math.round(x + (width - ISLAND_W) / 2), y, width: ISLAND_W, height: ISLAND_H });
}

function setInteractive(on) {
  if (!island) return;
  if (process.platform === 'linux') return; // "forward" não existe no Linux; lá a janela fica sempre clicável
  island.setIgnoreMouseEvents(!on, { forward: true });
}

function createIsland() {
  island = new BrowserWindow({
    width: ISLAND_W,
    height: ISLAND_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false, // nunca rouba o foco do que você está fazendo
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  island.setAlwaysOnTop(true, 'screen-saver');
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setInteractive(false);
  island.loadFile(path.join(__dirname, 'renderer', 'island.html'));
  island.once('ready-to-show', () => {
    positionIsland();
    if (!hidden) island.showInactive();
  });
  island.webContents.on('will-navigate', (e) => e.preventDefault());
  island.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 520,
    title: 'TopWatch – Configurações',
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function setHidden(value) {
  hidden = value;
  if (!island) return;
  if (hidden) island.hide();
  else {
    positionIsland();
    island.showInactive();
  }
  buildTrayMenu();
}

function setPinned(value) {
  pinned = value;
  if (island) island.webContents.send('pinned', pinned);
  setInteractive(pinned);
}

// ---------- coleta ----------

function isDemo(cfg) {
  return FORCE_DEMO || cfg.demo;
}

// estado + preferências de exibição, que a ilha precisa pra se desenhar
function snapshotForUi() {
  return { ...state, ui: store ? store.get().ui : undefined };
}

function broadcast() {
  allowedUrls.clear();
  for (const it of [...state.zabbix.items, ...state.glpi.items]) if (it.url) allowedUrls.add(it.url);
  if (island && !island.isDestroyed()) island.webContents.send('state', snapshotForUi());
  updateTrayTooltip();
}

function notifyNewProblems(items) {
  const cfg = store.get();
  const fresh = items.filter((p) => !seenProblems.has(p.id));
  items.forEach((p) => seenProblems.add(p.id));
  if (firstPoll || !cfg.notify || !Notification.isSupported()) return;
  for (const p of fresh.filter((x) => x.severity >= 4).slice(0, 3)) {
    const n = new Notification({
      title: `${p.severityLabel}: ${p.hosts.join(', ') || 'Zabbix'}`,
      body: p.title,
      silent: false,
    });
    n.on('click', () => {
      if (allowedUrls.has(p.url)) shell.openExternal(p.url);
    });
    n.show();
  }
  if (fresh.some((x) => x.severity >= 4) && island) island.webContents.send('alert');
}

async function poll() {
  if (polling) return;
  polling = true;
  const cfg = store.get();
  try {
    if (isDemo(cfg)) {
      const snap = demo.snapshot();
      state = {
        demo: true,
        updatedAt: Date.now(),
        zabbix: { enabled: true, items: snap.problems, error: null, multi: true },
        glpi: { enabled: true, items: snap.tickets, error: null },
      };
    } else {
      const [z, g] = await Promise.allSettled([
        cfg.zabbix.enabled ? zabbix.fetchAll(cfg.zabbix) : Promise.resolve({ items: [], errors: [], servers: 0 }),
        cfg.glpi.enabled ? glpi.fetchTickets(cfg.glpi) : Promise.resolve([]),
      ]);
      // servidor que falhou nesta rodada mantém os alertas da rodada anterior (sem piscar a lista)
      const zr = z.status === 'fulfilled' ? z.value : { items: [], errors: [{ serverId: '*', message: z.reason.message }], servers: 0 };
      const failed = new Set(zr.errors.map((er) => er.serverId));
      const kept = state.zabbix.items.filter((it) => failed.has(it.serverId) || failed.has('*'));
      state = {
        demo: false,
        updatedAt: Date.now(),
        zabbix: {
          enabled: cfg.zabbix.enabled,
          items: [...zr.items, ...kept],
          error: zr.errors.length ? zr.errors.map((er) => er.message).join(' · ') : null,
          multi: zabbix.activeServers(cfg.zabbix).length > 1,
        },
        glpi: {
          enabled: cfg.glpi.enabled,
          items: g.status === 'fulfilled' ? g.value : state.glpi.items,
          error: g.status === 'rejected' ? g.reason.message : null,
        },
      };
    }
    notifyNewProblems(state.zabbix.items);
    firstPoll = false;
  } finally {
    polling = false;
    broadcast();
  }
}

function restartPolling() {
  clearInterval(pollTimer);
  firstPoll = true;
  seenProblems.clear();
  poll();
  pollTimer = setInterval(poll, store.get().pollSeconds * 1000);
}

// ---------- bandeja ----------

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function updateTrayTooltip() {
  if (!tray) return;
  const z = state.zabbix.items.length;
  const g = state.glpi.items.length;
  tray.setToolTip(`TopWatch – ${z} alerta${z === 1 ? '' : 's'}, ${g} chamado${g === 1 ? '' : 's'}${state.demo ? ' (demo)' : ''}`);
}

function buildTrayMenu() {
  if (!tray) return;
  const cfg = store.get();
  const login = app.getLoginItemSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hidden ? 'Mostrar a barra' : 'Esconder a barra', click: () => setHidden(!hidden) },
      { label: 'Atualizar agora', click: () => poll() },
      { type: 'separator' },
      { label: 'Configurações…', click: openSettings },
      {
        label: 'Modo demo',
        type: 'checkbox',
        checked: isDemo(cfg),
        enabled: !FORCE_DEMO,
        click: (item) => {
          store.setFlag('demo', item.checked);
          restartPolling();
        },
      },
      {
        label: 'Iniciar com o Windows',
        type: 'checkbox',
        visible: process.platform === 'win32',
        checked: login.openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ])
  );
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', () => setHidden(!hidden));
  buildTrayMenu();
  updateTrayTooltip();
}

// ---------- IPC ----------

function fromWindow(e, win) {
  return win && !win.isDestroyed() && e.sender === win.webContents;
}

ipcMain.on('island:interactive', (e, on) => {
  if (!fromWindow(e, island)) return;
  if (pinned) return;
  setInteractive(!!on);
});

ipcMain.handle('island:state', () => snapshotForUi());
ipcMain.on('island:refresh', () => poll());
ipcMain.on('island:settings', () => openSettings());
ipcMain.on('island:unpin', (e) => {
  if (fromWindow(e, island)) setPinned(false);
});

ipcMain.on('open-url', (_e, url) => {
  // Só abre links que vieram dos próprios dados (nada de URL arbitrária).
  if (typeof url === 'string' && allowedUrls.has(url) && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('zabbix:ack', async (e, itemId) => {
  if (!fromWindow(e, island)) return { ok: false, message: 'Origem inválida' };
  // só aceita alertas que estão na lista atual; o id já diz de qual servidor ele veio
  const item = state.zabbix.items.find((p) => p.id === itemId);
  if (!item) return { ok: false, message: 'Esse alerta não está mais aberto.' };
  try {
    if (state.demo) demo.acknowledge(item.eventid);
    else {
      const server = store.get().zabbix.servers.find((s) => s.id === item.serverId);
      if (!server) return { ok: false, message: 'O servidor desse alerta foi removido das configurações.' };
      await zabbix.acknowledge(server, item.eventid);
    }
    item.acknowledged = true;
    broadcast();
    setTimeout(poll, 1500);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('settings:get', (e) => {
  if (!fromWindow(e, settingsWin)) return null;
  return { ...store.getMasked(), forcedDemo: FORCE_DEMO };
});

ipcMain.handle('settings:save', (e, changes) => {
  if (!fromWindow(e, settingsWin)) return { ok: false, message: 'Origem inválida' };
  const before = store.get();
  store.save(changes);
  buildTrayMenu();
  // mudou só a aparência? redesenha na hora, sem refazer a coleta
  const after = store.get();
  const onlyUi = JSON.stringify({ ...before, ui: null }) === JSON.stringify({ ...after, ui: null });
  if (onlyUi) broadcast();
  else restartPolling();
  return { ok: true };
});

ipcMain.handle('settings:test', async (e, which, changes, serverId) => {
  if (!fromWindow(e, settingsWin)) return { ok: false, message: 'Origem inválida' };
  const cfg = store.withChanges(changes); // testa o que está na tela, sem salvar
  try {
    let message;
    if (which === 'zabbix') {
      const server = cfg.zabbix.servers.find((s) => s.id === serverId);
      if (!server) throw new Error('Servidor não encontrado.');
      message = await zabbix.test(server, { minSeverity: cfg.zabbix.minSeverity });
    } else {
      message = await createGlpiClient().test(cfg.glpi);
    }
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

// ---------- ciclo de vida ----------

app.on('second-instance', () => setHidden(false));

app.whenReady().then(() => {
  store = createStore({ dir: app.getPath('userData'), safeStorage });
  glpi = createGlpiClient();

  createIsland();
  createTray();

  // Ctrl+Alt+F: fixa a barra aberta (pra usar sem depender do hover)
  globalShortcut.register('CommandOrControl+Alt+F', () => {
    if (hidden) setHidden(false);
    setPinned(!pinned);
  });

  screen.on('display-metrics-changed', positionIsland);
  screen.on('display-added', positionIsland);
  screen.on('display-removed', positionIsland);

  restartPolling();

  const cfg = store.get();
  if (!FORCE_DEMO && cfg.demo && !cfg.zabbix.servers.length && !cfg.glpi.url) {
    // primeira vez: mostra a ilha em demo e abre as configurações
    setTimeout(openSettings, 800);
  }
});

app.on('window-all-closed', (e) => e.preventDefault()); // vive na bandeja

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(pollTimer);
  if (glpi && store) glpi.close(store.get().glpi);
});
