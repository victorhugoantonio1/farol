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
  dialog,
} = require('electron');
const path = require('node:path');

const { createStore } = require('./src/config');
const zabbix = require('./src/zabbix');
const { request } = require('./src/http');
const pluginKit = require('./src/plugins');
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
// plugins carregados: [{ mod, dir, info, instance }]
let plugins = [];
let pluginErrors = [];
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
  // uma entrada por plugin instalado: { id, name, tab, enabled, items, error }
  plugins: [],
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId('io.github.victorhugoantonio1.topwatch'); // notificações no Windows

// ---------- plugins ----------

function pluginsRoot() {
  return path.join(app.getPath('userData'), 'plugins');
}

// TOPWATCH_PLUGINS: pastas extras (separadas por ; ou :) pra desenvolver plugins sem instalar
function pluginRoots() {
  const extra = (process.env.TOPWATCH_PLUGINS || '').split(path.delimiter).filter(Boolean);
  return [pluginsRoot(), ...extra];
}

function loadAllPlugins() {
  for (const p of plugins) closePlugin(p);
  const res = pluginKit.loadPlugins(pluginRoots(), { log: (m) => console.warn(`[TopWatch] ${m}`) });
  pluginErrors = res.errors;
  plugins = res.plugins.map((p) => {
    let instance = null;
    try {
      instance = p.mod.create({ request, version: app.getVersion() });
    } catch (err) {
      pluginErrors.push({ dir: p.dir, message: `create() falhou: ${err.message}` });
    }
    return { ...p, instance };
  }).filter((p) => p.instance);
  if (store) store.setPlugins(plugins.map((p) => p.mod));
}

function closePlugin(p) {
  try {
    if (p.instance && typeof p.instance.close === 'function') p.instance.close(store ? store.get().plugins[p.mod.id] : {});
  } catch {
    // saindo, não importa
  }
}

function pluginState(p, cfg, extra) {
  return {
    id: p.info.id,
    name: p.info.name,
    tab: p.info.tab,
    enabled: !!(cfg.plugins[p.info.id] && cfg.plugins[p.info.id].enabled),
    items: [],
    error: null,
    ...extra,
  };
}

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
  for (const it of [...state.zabbix.items, ...state.plugins.flatMap((p) => p.items)]) if (it.url) allowedUrls.add(it.url);
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
        // no demo, plugin com demo() aparece com os dados de exemplo dele
        plugins: plugins
          .filter((p) => typeof p.instance.demo === 'function')
          .map((p) => {
            let items = [];
            try {
              items = (p.instance.demo() || []).map((it, i) => pluginKit.normalizeItem(p.mod, it, i));
            } catch {
              // demo quebrado: aba vazia
            }
            return pluginState(p, cfg, { enabled: true, items });
          }),
      };
    } else {
      const active = plugins.filter((p) => cfg.plugins[p.mod.id] && cfg.plugins[p.mod.id].enabled);
      const [z, ...pr] = await Promise.allSettled([
        cfg.zabbix.enabled ? zabbix.fetchAll(cfg.zabbix) : Promise.resolve({ items: [], errors: [], servers: 0 }),
        ...active.map((p) => p.instance.fetch(cfg.plugins[p.mod.id])),
      ]);
      // servidor que falhou nesta rodada mantém os alertas da rodada anterior (sem piscar a lista)
      const zr = z.status === 'fulfilled' ? z.value : { items: [], errors: [{ serverId: '*', message: z.reason.message }], servers: 0 };
      const failed = new Set(zr.errors.map((er) => er.serverId));
      const kept = state.zabbix.items.filter((it) => failed.has(it.serverId) || failed.has('*'));
      const previous = new Map(state.plugins.map((p) => [p.id, p.items]));
      state = {
        demo: false,
        updatedAt: Date.now(),
        zabbix: {
          enabled: cfg.zabbix.enabled,
          items: [...zr.items, ...kept],
          error: zr.errors.length ? zr.errors.map((er) => er.message).join(' · ') : null,
          multi: zabbix.activeServers(cfg.zabbix).length > 1,
        },
        plugins: plugins.map((p) => {
          const i = active.indexOf(p);
          if (i < 0) return pluginState(p, cfg);
          const r = pr[i];
          if (r.status === 'fulfilled') {
            const items = (Array.isArray(r.value) ? r.value : []).slice(0, 200).map((it, k) => pluginKit.normalizeItem(p.mod, it, k));
            return pluginState(p, cfg, { items });
          }
          const msg = (r.reason && r.reason.message) || String(r.reason);
          return pluginState(p, cfg, {
            items: previous.get(p.info.id) || [],
            error: msg.toLowerCase().startsWith(p.info.name.toLowerCase()) ? msg : `${p.info.name}: ${msg}`,
          });
        }),
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

// O ícone é o Vigia em miniatura (assets/tray, gerado por scripts/tray-icons.py).
// A cor do olho segue o pior alerta, ele pisca e olha pros lados de vez em quando,
// e o olho pulsa em Alta/Desastre.
const TRAY_DIR = path.join(__dirname, 'assets', 'tray');
const trayCache = new Map();
let trayLevelNow = null;
let trayFrameNow = null;
let trayIdleTimer = null;
let trayPoseTimer = null;
let trayPulseTimer = null;

function trayImage(level, frame) {
  const key = `${level}-${frame}`;
  if (!trayCache.has(key)) {
    // createFromPath pega sozinho as versões @1.5x e @2x pra telas com zoom
    const img = nativeImage.createFromPath(path.join(TRAY_DIR, `${key}.png`));
    trayCache.set(key, img.isEmpty() ? null : img);
  }
  return trayCache.get(key);
}

function trayIcon() {
  return trayImage('ok', 'open') || nativeImage.createEmpty();
}

function setTrayFrame(frame) {
  if (!tray || tray.isDestroyed()) return;
  if (frame === trayFrameNow) return;
  const img = trayImage(trayLevelNow || 'ok', frame);
  if (!img) return;
  tray.setImage(img);
  trayFrameNow = frame;
}

// mesma regra da luz da ilha: o que a barra está mostrando define a cor
function trayLevel() {
  const display = store ? store.get().ui.display : 'both';
  const plugin = state.plugins.find((p) => p.id === display && p.enabled);
  if (!plugin) {
    const open = state.zabbix.items.filter((p) => !p.acknowledged);
    if (open.length) return String(Math.max(...open.map((p) => p.severity)));
  } else if (plugin.items.length) {
    return String(Math.max(...plugin.items.map((it) => it.level)));
  }
  const errors = [state.zabbix.error, ...state.plugins.filter((p) => p.enabled).map((p) => p.error)];
  return errors.some(Boolean) ? 'error' : 'ok';
}

// pisca ou dá uma olhada pro lado a cada poucos segundos
function scheduleTrayIdle() {
  clearTimeout(trayIdleTimer);
  trayIdleTimer = setTimeout(() => {
    clearTimeout(trayPoseTimer);
    const pulsing = !!trayPulseTimer;
    const r = Math.random();
    if (pulsing || r < 0.65) {
      setTrayFrame('blink');
      trayPoseTimer = setTimeout(() => setTrayFrame('open'), 160);
    } else {
      setTrayFrame(r < 0.82 ? 'left' : 'right');
      trayPoseTimer = setTimeout(() => setTrayFrame('open'), 900);
    }
    scheduleTrayIdle();
  }, 3500 + Math.random() * 4500);
}

function updateTrayIcon() {
  const level = trayLevel();
  if (level === trayLevelNow) return;
  trayLevelNow = level;
  trayFrameNow = null;
  setTrayFrame('open');
  clearInterval(trayPulseTimer);
  trayPulseTimer = null;
  if (level === '4' || level === '5') {
    // Desastre pulsa mais rápido que Alta
    let on = true;
    trayPulseTimer = setInterval(() => {
      on = !on;
      setTrayFrame(on ? 'open' : 'dim');
    }, level === '5' ? 550 : 1000);
  }
}

function updateTrayTooltip() {
  if (!tray) return;
  const z = state.zabbix.items.length;
  const parts = [`${z} alerta${z === 1 ? '' : 's'}`];
  for (const p of state.plugins.filter((x) => x.enabled)) {
    const n = p.items.length;
    parts.push(`${n} ${n === 1 ? p.tab.singular : p.tab.plural}`);
  }
  tray.setToolTip(`TopWatch – ${parts.join(', ')}${state.demo ? ' (demo)' : ''}`);
  updateTrayIcon();
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
  scheduleTrayIdle();
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
  return {
    ...store.getMasked(),
    forcedDemo: FORCE_DEMO,
    plugins: plugins.map((p) => p.info),
    pluginErrors: pluginErrors.map((er) => ({ folder: path.basename(er.dir), message: er.message })),
  };
});

// "Instalar plugin…": escolhe a pasta do plugin, copia pra pasta de plugins e recarrega
ipcMain.handle('settings:install-plugin', async (e) => {
  if (!fromWindow(e, settingsWin)) return { ok: false, message: 'Origem inválida' };
  const pick = await dialog.showOpenDialog(settingsWin, {
    title: 'Escolha a pasta do plugin (a que tem o index.js)',
    properties: ['openDirectory'],
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
  try {
    const id = pluginKit.installPlugin(pick.filePaths[0], pluginsRoot());
    loadAllPlugins();
    restartPolling();
    const p = plugins.find((x) => x.mod.id === id);
    if (!p) {
      const er = pluginErrors.find((x) => path.basename(x.dir) === id);
      throw new Error(er ? er.message : 'o plugin não carregou');
    }
    return { ok: true, message: `Plugin ${p.info.name} ${p.info.version} instalado.` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.on('settings:open-plugins-folder', (e) => {
  if (!fromWindow(e, settingsWin)) return;
  require('node:fs').mkdirSync(pluginsRoot(), { recursive: true });
  shell.openPath(pluginsRoot());
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

// which = 'zabbix' (id = servidor) ou 'plugin' (id = plugin)
ipcMain.handle('settings:test', async (e, which, changes, id) => {
  if (!fromWindow(e, settingsWin)) return { ok: false, message: 'Origem inválida' };
  const cfg = store.withChanges(changes); // testa o que está na tela, sem salvar
  try {
    let message;
    if (which === 'zabbix') {
      const server = cfg.zabbix.servers.find((s) => s.id === id);
      if (!server) throw new Error('Servidor não encontrado.');
      message = await zabbix.test(server, { minSeverity: cfg.zabbix.minSeverity });
    } else {
      const p = plugins.find((x) => x.mod.id === id);
      if (!p) throw new Error('Plugin não encontrado.');
      if (typeof p.instance.test !== 'function') throw new Error('Esse plugin não tem teste de conexão.');
      message = String(await p.instance.test(cfg.plugins[id]));
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
  loadAllPlugins();

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
  if (!FORCE_DEMO && cfg.demo && !cfg.zabbix.servers.length) {
    // primeira vez: mostra a ilha em demo e abre as configurações
    setTimeout(openSettings, 800);
  }
});

app.on('window-all-closed', (e) => e.preventDefault()); // vive na bandeja

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(pollTimer);
  clearInterval(trayPulseTimer);
  clearTimeout(trayIdleTimer);
  clearTimeout(trayPoseTimer);
  for (const p of plugins) closePlugin(p);
});
