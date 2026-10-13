'use strict';
// Configuração salva em JSON na pasta de dados do app.
// Tokens são criptografados com o safeStorage do Electron (DPAPI no Windows),
// e nunca voltam em texto puro para a tela de configurações.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// segredos de caminho fixo; os tokens dos servidores Zabbix são tratados à parte
const SECRETS = [
  ['glpi', 'userToken'],
  ['glpi', 'appToken'],
];

const AUTH_MODES = ['auto', 'header', 'body'];

const DEFAULTS = {
  demo: true,
  pollSeconds: 60,
  notify: true,
  // display: 'both' | 'zabbix' | 'glpi'; highlight: alerta grave toma a pílula; mascot: Vigia
  ui: { display: 'both', highlight: true, mascot: true },
  // servers: [{ id, name, url, token, auth: 'auto'|'header'|'body', insecure, enabled }]
  zabbix: { enabled: false, minSeverity: 2, servers: [] },
  glpi: { enabled: false, url: '', userToken: '', appToken: '', onlyMine: true, insecure: false },
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

// Intervalo da coleta: no mínimo 30 s pra não pesar no Zabbix/GLPI de ninguém.
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

// Configuração antiga (um Zabbix só, com url/token direto em "zabbix") vira o primeiro servidor.
function migrate(raw) {
  const z = raw && raw.zabbix;
  if (!z || Array.isArray(z.servers)) return raw;
  const out = clone(raw);
  const { url, token, legacyAuth, insecure, ...rest } = z;
  out.zabbix = { ...rest, servers: url || token ? [{ id: 'principal', name: 'Zabbix', url, token, auth: legacyAuth ? 'body' : 'auto', insecure }] : [] };
  return out;
}

function createStore({ dir, safeStorage }) {
  const file = path.join(dir, 'config.json');
  const canEncrypt = !!(safeStorage && safeStorage.isEncryptionAvailable());

  function encode(value) {
    if (!value) return '';
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

  let current = load();

  function load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // primeiro uso
    }
    const cfg = merge(DEFAULTS, migrate(raw));
    for (const [section, key] of SECRETS) cfg[section][key] = decode(cfg[section][key]);
    cfg.zabbix.servers = (cfg.zabbix.servers || []).map((s, i) => normalizeServer({ ...s, token: decode(s.token) }, i));
    cfg.pollSeconds = clampPoll(cfg.pollSeconds);
    return cfg;
  }

  function persist() {
    const out = clone(current);
    for (const [section, key] of SECRETS) out[section][key] = encode(out[section][key]);
    out.zabbix.servers = out.zabbix.servers.map((s) => ({ ...s, token: encode(s.token) }));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  }

  function get() {
    return clone(current);
  }

  // Versão segura para a tela: segredos viram "tem/não tem".
  function getMasked() {
    const out = get();
    const has = {};
    for (const [section, key] of SECRETS) {
      has[`${section}.${key}`] = !!out[section][key];
      out[section][key] = '';
    }
    out.zabbix.servers = out.zabbix.servers.map((s) => {
      has[`zabbix.servers.${s.id}.token`] = !!s.token;
      return { ...s, token: '' };
    });
    return { config: out, hasSecret: has, encryptionAvailable: canEncrypt };
  }

  // Aplica o que veio da tela. Campo secreto vazio = manter o atual.
  function withChanges(changes) {
    const next = merge(current, changes);
    for (const [section, key] of SECRETS) {
      const incoming = changes && changes[section] ? changes[section][key] : undefined;
      if (incoming === undefined || incoming === '') next[section][key] = current[section][key];
    }

    const incomingServers = changes && changes.zabbix && Array.isArray(changes.zabbix.servers) ? changes.zabbix.servers : null;
    if (incomingServers) {
      const byId = new Map(current.zabbix.servers.map((s) => [s.id, s]));
      next.zabbix.servers = incomingServers.slice(0, 10).map((s, i) => {
        const old = byId.get(s.id);
        return normalizeServer({ ...s, token: s.token || (old ? old.token : '') }, i);
      });
    } else {
      next.zabbix.servers = clone(current.zabbix.servers);
    }

    next.pollSeconds = clampPoll(next.pollSeconds);
    if (!['both', 'zabbix', 'glpi'].includes(next.ui.display)) next.ui.display = 'both';
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

  return { get, getMasked, withChanges, save, setFlag, file, canEncrypt };
}

module.exports = { createStore, DEFAULTS, migrate, normalizeServer };
