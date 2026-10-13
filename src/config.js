'use strict';
// Configuração salva em JSON na pasta de dados do app.
// Tokens são criptografados com o safeStorage do Electron (DPAPI no Windows),
// e nunca voltam em texto puro para a tela de configurações.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AUTH_MODES = ['auto', 'header', 'body'];

const DEFAULTS = {
  demo: true,
  pollSeconds: 60,
  notify: true,
  // display: 'both' (tudo) | 'zabbix' | id de um plugin; highlight: alerta grave toma a pílula; mascot: Vigia
  ui: { display: 'both', highlight: true, mascot: true },
  // servers: [{ id, name, url, token, auth: 'auto'|'header'|'body', insecure, enabled }]
  zabbix: { enabled: false, minSeverity: 2, servers: [] },
  // configuração de cada plugin, pelo id: { enabled, ...campos do plugin }
  plugins: {},
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function merge(base, extra) {
  const out = clone(base);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = { ...out[k], ...v };
    } else if (k in out) {
      out[k] = v;
    }
  }
  return out;
}

// Intervalo da coleta: no mínimo 30 s pra não pesar nos servidores de ninguém.
function clampPoll(v) {
  return Math.min(600, Math.max(30, Number(v) || 60));
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

// Limpa e completa um servidor vindo do disco ou da tela.
function normalizeServer(s, i) {
  return {
    id: typeof s.id === 'string' && /^[a-z0-9-]{1,32}$/i.test(s.id) ? s.id : newId(),
    name: String(s.name || '').trim().slice(0, 40) || `Zabbix ${i + 1}`,
    url: String(s.url || '').trim(),
    token: s.token || '',
    auth: AUTH_MODES.includes(s.auth) ? s.auth : 'auto',
    insecure: !!s.insecure,
    enabled: s.enabled !== false,
  };
}

// Configurações antigas:
// - um Zabbix só, com url/token direto em "zabbix" -> vira o primeiro servidor;
// - seção "glpi" do tempo em que o GLPI era parte do núcleo -> vira a config do plugin "glpi".
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let out = raw;
  const z = raw.zabbix;
  if (z && !Array.isArray(z.servers)) {
    out = clone(out);
    const { url, token, legacyAuth, insecure, ...rest } = z;
    out.zabbix = { ...rest, servers: url || token ? [{ id: 'principal', name: 'Zabbix', url, token, auth: legacyAuth ? 'body' : 'auto', insecure }] : [] };
  }
  if (out.glpi && typeof out.glpi === 'object') {
    out = clone(out);
    out.plugins = { ...(out.plugins || {}) };
    if (!out.plugins.glpi) out.plugins.glpi = out.glpi;
    delete out.glpi;
  }
  return out;
}

// plugins: [{ id, fields }] dos plugins instalados (pra saber quais campos são segredos)
function createStore({ dir, safeStorage, plugins = [] }) {
  const file = path.join(dir, 'config.json');
  const canEncrypt = !!(safeStorage && safeStorage.isEncryptionAvailable());
  let known = new Map();

  function setKnown(list) {
    known = new Map(list.map((p) => [p.id, p]));
  }
  setKnown(plugins);

  function pluginDefaults(def) {
    const out = { enabled: false };
    for (const f of def.fields) out[f.key] = f.default !== undefined ? f.default : f.type === 'checkbox' ? false : '';
    return out;
  }

  const secretsOf = (def) => def.fields.filter((f) => f.type === 'secret').map((f) => f.key);

  function encode(value) {
    if (!value) return '';
    if (typeof value === 'object') return value; // já criptografado (plugin não instalado agora)
    if (canEncrypt) return { enc: safeStorage.encryptString(value).toString('base64') };
    return { plain: value };
  }

  function decode(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (value.enc && canEncrypt) {
      try {
        return safeStorage.decryptString(Buffer.from(value.enc, 'base64'));
      } catch {
        return ''; // perfil do Windows mudou, por ex.
      }
    }
    return value.plain || '';
  }

  // Campo do plugin no tipo certo; o que não está nos fields é descartado.
  function cleanPlugin(def, values) {
    const out = pluginDefaults(def);
    if (values && 'enabled' in values) out.enabled = !!values.enabled;
    for (const f of def.fields) {
      if (!values || !(f.key in values)) continue;
      const v = values[f.key];
      if (f.type === 'checkbox') out[f.key] = !!v;
      else if (f.type === 'number') out[f.key] = Number.isFinite(Number(v)) ? Number(v) : out[f.key];
      else if (f.type === 'secret') out[f.key] = v || '';
      else out[f.key] = String(v ?? '').trim().slice(0, 500);
    }
    return out;
  }

  let current = load();

  function load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // primeiro uso
    }
    const migrated = migrate(raw) || {};
    const cfg = merge(DEFAULTS, migrated);
    cfg.zabbix.servers = (cfg.zabbix.servers || []).map((s, i) => normalizeServer({ ...s, token: decode(s.token) }, i));
    cfg.pollSeconds = clampPoll(cfg.pollSeconds);
    // plugins instalados: decodifica os segredos; não instalados: guarda como veio (criptografado)
    const plugins = {};
    for (const [id, values] of Object.entries(migrated.plugins || {})) {
      const def = known.get(id);
      if (!def) {
        plugins[id] = values;
        continue;
      }
      const decoded = { ...values };
      for (const key of secretsOf(def)) decoded[key] = decode(values[key]);
      plugins[id] = cleanPlugin(def, decoded);
    }
    for (const def of known.values()) if (!plugins[def.id]) plugins[def.id] = pluginDefaults(def);
    cfg.plugins = plugins;
    return cfg;
  }

  function persist() {
    const out = clone(current);
    out.zabbix.servers = out.zabbix.servers.map((s) => ({ ...s, token: encode(s.token) }));
    for (const [id, values] of Object.entries(out.plugins)) {
      const def = known.get(id);
      if (!def) continue;
      for (const key of secretsOf(def)) values[key] = encode(values[key]);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  }

  function get() {
    return clone(current);
  }

  // Versão segura para a tela: segredos viram "tem/não tem"; plugin não instalado não aparece.
  function getMasked() {
    const out = get();
    const has = {};
    out.zabbix.servers = out.zabbix.servers.map((s) => {
      has[`zabbix.servers.${s.id}.token`] = !!s.token;
      return { ...s, token: '' };
    });
    for (const id of Object.keys(out.plugins)) {
      const def = known.get(id);
      if (!def) {
        delete out.plugins[id];
        continue;
      }
      for (const key of secretsOf(def)) {
        has[`plugins.${id}.${key}`] = !!out.plugins[id][key];
        out.plugins[id][key] = '';
      }
    }
    return { config: out, hasSecret: has, encryptionAvailable: canEncrypt };
  }

  // Aplica o que veio da tela. Campo secreto vazio = manter o atual.
  function withChanges(changes) {
    const { plugins: pluginChanges, ...rest } = changes || {};
    const next = merge(current, rest);
    next.plugins = clone(current.plugins);

    const incomingServers = rest.zabbix && Array.isArray(rest.zabbix.servers) ? rest.zabbix.servers : null;
    if (incomingServers) {
      const byId = new Map(current.zabbix.servers.map((s) => [s.id, s]));
      next.zabbix.servers = incomingServers.slice(0, 10).map((s, i) => {
        const old = byId.get(s.id);
        return normalizeServer({ ...s, token: s.token || (old ? old.token : '') }, i);
      });
    } else {
      next.zabbix.servers = clone(current.zabbix.servers);
    }

    for (const [id, values] of Object.entries(pluginChanges || {})) {
      const def = known.get(id);
      if (!def || !values || typeof values !== 'object') continue;
      const merged = { ...current.plugins[id], ...values };
      for (const key of secretsOf(def)) {
        if (values[key] === undefined || values[key] === '') merged[key] = current.plugins[id] ? current.plugins[id][key] : '';
      }
      next.plugins[id] = cleanPlugin(def, merged);
    }

    next.pollSeconds = clampPoll(next.pollSeconds);
    if (!['both', 'zabbix', ...known.keys()].includes(next.ui.display)) next.ui.display = 'both';
    return next;
  }

  function save(changes) {
    current = withChanges(changes);
    persist();
    return get();
  }

  function setFlag(key, value) {
    current[key] = value;
    persist();
  }

  // Depois de instalar um plugin: relê o arquivo pra decodificar a config dele.
  function setPlugins(list) {
    setKnown(list);
    current = load();
  }

  return { get, getMasked, withChanges, save, setFlag, setPlugins, file, canEncrypt };
}

module.exports = { createStore, DEFAULTS, migrate, normalizeServer };
