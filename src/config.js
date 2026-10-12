'use strict';
// Configuração salva em JSON na pasta de dados do app.
// Tokens são criptografados com o safeStorage do Electron (DPAPI no Windows),
// e nunca voltam em texto puro para a tela de configurações.

const fs = require('node:fs');
const path = require('node:path');

const SECRETS = [
  ['zabbix', 'token'],
  ['glpi', 'userToken'],
  ['glpi', 'appToken'],
];

const DEFAULTS = {
  demo: true,
  pollSeconds: 30,
  notify: true,
  zabbix: { enabled: false, url: '', token: '', legacyAuth: false, insecure: false, minSeverity: 2 },
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
    const cfg = merge(DEFAULTS, raw);
    for (const [section, key] of SECRETS) cfg[section][key] = decode(cfg[section][key]);
    return cfg;
  }

  function persist() {
    const out = clone(current);
    for (const [section, key] of SECRETS) out[section][key] = encode(out[section][key]);
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
    return { config: out, hasSecret: has, encryptionAvailable: canEncrypt };
  }

  // Aplica o que veio da tela. Campo secreto vazio = manter o atual.
  function withChanges(changes) {
    const next = merge(current, changes);
    for (const [section, key] of SECRETS) {
      const incoming = changes && changes[section] ? changes[section][key] : undefined;
      if (incoming === undefined || incoming === '') next[section][key] = current[section][key];
    }
    next.pollSeconds = Math.min(600, Math.max(10, Number(next.pollSeconds) || 30));
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

module.exports = { createStore, DEFAULTS };
