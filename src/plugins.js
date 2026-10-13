'use strict';
// Plugins: integrações opcionais que ganham uma aba própria na barra e uma seção
// nas configurações (ex.: sistemas de chamados). O núcleo do TopWatch é o Zabbix.
//
// Um plugin é uma pasta com um index.js que exporta:
//
//   module.exports = {
//     apiVersion: 1,
//     id: 'meu-plugin',               // letras minúsculas, números e hífen
//     name: 'Meu Sistema',
//     version: '1.0.0',
//     tab: { label: 'Chamados', singular: 'chamado', plural: 'chamados',
//            empty: 'Nenhum chamado aberto.', openLabel: 'Abrir chamado' },
//     fields: [                       // vira a seção do plugin nas configurações
//       { key: 'url', type: 'url', label: 'URL', placeholder: 'https://…', hint: '…' },
//       { key: 'token', type: 'secret', label: 'Token' },      // salvo criptografado
//       { key: 'onlyMine', type: 'checkbox', label: 'Só os meus', default: true },
//       { key: 'limit', type: 'number', label: 'Limite', default: 50 },
//       { key: 'login', type: 'text', label: 'Login', optional: true },
//     ],
//     create(ctx) {                   // ctx.request = cliente HTTP do TopWatch
//       return {
//         async fetch(cfg) { return [item, …] },   // cfg = valores dos fields
//         async test(cfg) { return 'Conectado…' },
//         demo() { return [item, …] },             // opcional: dados do modo demo
//         async close(cfg) {},                     // opcional: ao sair do app
//       };
//     },
//   };
//
// Cada item: { id, title, level (0–5, a cor), levelLabel, tag, detail, since, updated, url }
//
// Plugins rodam no processo principal, com acesso total ao computador:
// instale só plugins de quem você confia.

const fs = require('node:fs');
const path = require('node:path');

const API_VERSION = 1;
const ID_RE = /^[a-z0-9-]{1,32}$/;
const RESERVED = new Set(['zabbix', 'both', 'all']);
const FIELD_TYPES = new Set(['text', 'url', 'secret', 'checkbox', 'number']);

function validate(mod) {
  if (!mod || typeof mod !== 'object') return 'não exporta um objeto';
  if (mod.apiVersion !== API_VERSION) return `apiVersion ${mod.apiVersion} não suportada (esperado ${API_VERSION})`;
  if (typeof mod.id !== 'string' || !ID_RE.test(mod.id) || RESERVED.has(mod.id)) return 'id inválido';
  if (typeof mod.name !== 'string' || !mod.name.trim()) return 'sem name';
  if (typeof mod.create !== 'function') return 'sem create()';
  if (!mod.tab || typeof mod.tab.label !== 'string') return 'sem tab.label';
  if (!Array.isArray(mod.fields)) return 'fields precisa ser uma lista';
  for (const f of mod.fields) {
    if (!f || typeof f.key !== 'string' || !/^[a-zA-Z0-9_]{1,40}$/.test(f.key)) return 'campo com key inválida';
    if (!FIELD_TYPES.has(f.type)) return `campo "${f.key}" com tipo inválido`;
  }
  return null;
}

// Só o que é seguro mandar pra interface (sem funções).
function describe(mod) {
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return {
    id: mod.id,
    name: str(mod.name, 40),
    version: str(mod.version, 20) || '',
    tab: {
      label: str(mod.tab.label, 24),
      singular: str(mod.tab.singular, 24) || 'item',
      plural: str(mod.tab.plural, 24) || 'itens',
      empty: str(mod.tab.empty) || 'Nada pendente.',
      openLabel: str(mod.tab.openLabel, 24) || 'Abrir',
    },
    fields: mod.fields.map((f) => ({
      key: f.key,
      type: f.type,
      label: str(f.label, 60) || f.key,
      placeholder: str(f.placeholder, 80) || '',
      hint: str(f.hint, 300) || '',
      optional: !!f.optional,
      default: f.default,
    })),
  };
}

// Padrões dos campos de um plugin (sem os segredos).
function defaultsFor(mod) {
  const out = { enabled: false };
  for (const f of mod.fields) {
    if (f.default !== undefined) out[f.key] = f.default;
    else out[f.key] = f.type === 'checkbox' ? false : '';
  }
  return out;
}

function secretKeys(mod) {
  return mod.fields.filter((f) => f.type === 'secret').map((f) => f.key);
}

// Item vindo do plugin -> formato que a barra desenha. Campos estranhos ficam de fora.
function normalizeItem(mod, raw, i) {
  const level = Math.min(5, Math.max(0, Math.round(Number(raw.level) || 0)));
  const url = typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url : null;
  const t = (v, max = 300) => (v === undefined || v === null ? '' : String(v).slice(0, max));
  const ts = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    id: `${mod.id}-${t(raw.id, 80) || i}`,
    source: mod.id,
    title: t(raw.title) || '(sem título)',
    level,
    levelLabel: t(raw.levelLabel, 40),
    tag: t(raw.tag, 40),
    detail: t(raw.detail, 80),
    since: ts(raw.since),
    updated: ts(raw.updated),
    url,
  };
}

function pluginDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name))
      .filter((dir) => fs.existsSync(path.join(dir, 'index.js')));
  } catch {
    return []; // pasta ainda não existe
  }
}

// Carrega todos os plugins das pastas. Plugin quebrado não derruba o app: vai pra "errors".
function loadPlugins(roots, { log = () => {} } = {}) {
  const plugins = [];
  const errors = [];
  const seen = new Set();
  for (const root of roots.filter(Boolean)) {
    for (const dir of pluginDirs(root)) {
      const entry = path.join(dir, 'index.js');
      try {
        delete require.cache[require.resolve(entry)]; // permite recarregar depois de instalar
        const mod = require(entry);
        const problem = validate(mod);
        if (problem) throw new Error(problem);
        if (seen.has(mod.id)) throw new Error(`id "${mod.id}" repetido`);
        seen.add(mod.id);
        plugins.push({ mod, dir, info: describe(mod) });
      } catch (err) {
        errors.push({ dir, message: err.message });
        log(`plugin ignorado (${dir}): ${err.message}`);
      }
    }
  }
  return { plugins, errors };
}

// Copia a pasta de um plugin pra pasta de plugins do app (botão "Instalar plugin…").
function installPlugin(srcDir, pluginsRoot) {
  const entry = path.join(srcDir, 'index.js');
  if (!fs.existsSync(entry)) throw new Error('Essa pasta não tem um index.js de plugin.');
  delete require.cache[require.resolve(entry)];
  const mod = require(entry);
  const problem = validate(mod);
  if (problem) throw new Error(`Plugin inválido: ${problem}.`);
  const dest = path.join(pluginsRoot, mod.id);
  if (path.resolve(srcDir) === path.resolve(dest)) return mod.id; // já está lá
  fs.mkdirSync(pluginsRoot, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  return mod.id;
}

module.exports = { loadPlugins, installPlugin, validate, describe, defaultsFor, secretKeys, normalizeItem, API_VERSION };
