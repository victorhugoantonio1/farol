'use strict';
// Cliente da API JSON-RPC do Zabbix, com suporte a vários servidores.
//
// Autenticação por token:
//   - Zabbix 6.4+ aceita "Authorization: Bearer <token>" no cabeçalho;
//   - Zabbix 5.4 a 6.2 só aceita o token no campo "auth" do corpo.
// Com auth = 'auto' (padrão), o app pergunta a versão (apiinfo.version, sem login)
// e escolhe sozinho. 'header' e 'body' forçam um dos dois.

const { request } = require('./http');

const SEVERITY_LABELS = ['Não classificado', 'Informação', 'Atenção', 'Média', 'Alta', 'Desastre'];

// versão detectada por URL (vale enquanto o app estiver aberto)
const detected = new Map();

// hosts por trigger ("url#triggerid" -> nomes), pra não repetir trigger.get toda rodada
const hostCache = new Map();

function baseUrl(apiUrl) {
  return String(apiUrl)
    .replace(/\/api_jsonrpc\.php\/?$/i, '')
    .replace(/\/+$/, '');
}

// Aceita a URL do jeito que vier da barra do navegador:
// "https://zbx/zabbix.php?action=dashboard.view" -> "https://zbx/api_jsonrpc.php"
function normalizeApiUrl(url) {
  let u = String(url || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!u) return '';
  if (/\/api_jsonrpc\.php$/i.test(u)) return u;
  u = u.replace(/\/[^/]*\.php$/i, ''); // zabbix.php, index.php...
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return `${u}/api_jsonrpc.php`;
}

function label(server) {
  return server.name ? `Zabbix "${server.name}"` : 'Zabbix';
}

// "6.0.21" -> true se for anterior ao 6.4 (precisa do token no corpo)
function needsBodyAuth(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false; // versão desconhecida: não dá pra afirmar que é antiga
  const maj = Number(m[1]);
  const min = Number(m[2]);
  return maj < 6 || (maj === 6 && min < 4);
}

async function rawCall(server, method, params, authMode) {
  const url = normalizeApiUrl(server.url);
  if (!url) throw new Error(`${label(server)}: URL não configurada`);
  const body = { jsonrpc: '2.0', method, params, id: Date.now() };
  const headers = {};
  if (authMode) {
    if (!server.token) throw new Error(`${label(server)}: token não configurado`);
    if (authMode === 'body') body.auth = server.token;
    else headers.Authorization = `Bearer ${server.token}`;
  }

  const res = await request(url, { method: 'POST', headers, body, insecure: !!server.insecure });
  if (res.json === undefined || res.json === null) {
    throw new Error(`${label(server)} respondeu HTTP ${res.status} sem JSON. A URL aponta para o frontend do Zabbix?`);
  }
  if (!res.json.error && !('result' in res.json)) {
    throw new Error(`${label(server)} respondeu HTTP ${res.status} sem resultado.`);
  }
  if (res.json.error) {
    const e = res.json.error;
    const err = new Error(`${label(server)}: ${e.message}${e.data ? ` (${e.data})` : ''}`);
    err.zabbix = e;
    throw err;
  }
  return res.json.result;
}

async function version(server) {
  // apiinfo.version precisa ser chamado SEM autenticação.
  const v = await rawCall(server, 'apiinfo.version', {}, null);
  if (typeof v !== 'string' || !/^\d+\.\d+/.test(v)) throw new Error('versão ilegível');
  detected.set(normalizeApiUrl(server.url), v);
  return v;
}

// modo que funcionou de fato, por URL (vale mais que a versão)
const workingMode = new Map();

async function authModeFor(server) {
  if (server.auth === 'header' || server.auth === 'body') return server.auth;
  if (server.legacyAuth === true) return 'body'; // configuração antiga
  const key = normalizeApiUrl(server.url);
  if (workingMode.has(key)) return workingMode.get(key);
  let v = detected.get(key);
  if (v === undefined) {
    try {
      v = await version(server);
    } catch {
      v = null; // não deu pra saber; tenta o cabeçalho e cai pro corpo se recusar
      detected.set(key, v);
    }
  }
  return needsBodyAuth(v) ? 'body' : 'header';
}

function looksLikeAuthError(err) {
  const text = `${err.zabbix?.message || ''} ${err.zabbix?.data || ''}`.toLowerCase();
  return /not authori[sz]ed|session terminated|re-login|invalid params|unexpected parameter/.test(text);
}

async function call(server, method, params) {
  const key = normalizeApiUrl(server.url);
  const mode = await authModeFor(server);
  try {
    const result = await rawCall(server, method, params, mode);
    if (server.auth !== 'header' && server.auth !== 'body') workingMode.set(key, mode);
    return result;
  } catch (err) {
    // Modo automático e o token foi recusado: tenta o outro jeito uma vez.
    // Cobre proxy/Apache que remove o cabeçalho Authorization (o 7.0 ainda aceita o token no corpo)
    // e versão detectada errado.
    const forced = server.auth === 'header' || server.auth === 'body' || server.legacyAuth === true;
    if (forced || workingMode.has(key) || !looksLikeAuthError(err)) throw err;
    const other = mode === 'header' ? 'body' : 'header';
    try {
      const result = await rawCall(server, method, params, other);
      workingMode.set(key, other);
      return result;
    } catch {
      if (mode === 'header' && /not authori[sz]ed|session terminated/i.test(err.message)) {
        err.message += '. O token foi recusado no cabeçalho e no corpo: confira se o token está ativo e não expirou, e se o servidor web/proxy repassa o cabeçalho Authorization.';
      }
      throw err;
    }
  }
}

async function fetchProblems(server, { minSeverity = 2, limit = 50 } = {}) {
  const min = Math.min(5, Math.max(0, Number(minSeverity)));
  const severities = [];
  for (let s = min; s <= 5; s++) severities.push(s);

  const problems = await call(server, 'problem.get', {
    output: ['eventid', 'objectid', 'name', 'severity', 'clock', 'acknowledged'],
    source: 0, // eventos de trigger
    object: 0,
    severities,
    suppressed: false,
    recent: false,
    sortfield: ['eventid'],
    sortorder: 'DESC',
    limit: Number(limit),
  });

  // problem.get não traz o host; buscamos pelos triggers. Os hosts de um trigger não mudam,
  // então só pergunta pelos triggers que ainda não conhece (na maioria das rodadas, nenhum).
  const key = normalizeApiUrl(server.url);
  const missing = [...new Set(problems.map((p) => p.objectid))].filter((id) => !hostCache.has(`${key}#${id}`));
  if (missing.length) {
    const triggers = await call(server, 'trigger.get', {
      triggerids: missing,
      output: ['triggerid'],
      selectHosts: ['hostid', 'host', 'name'],
    });
    if (hostCache.size > 5000) hostCache.clear();
    for (const t of triggers) {
      hostCache.set(`${key}#${t.triggerid}`, (t.hosts || []).map((h) => h.name || h.host));
    }
  }
  const hostsOf = (triggerid) => hostCache.get(`${key}#${triggerid}`) || [];

  const base = baseUrl(normalizeApiUrl(server.url));
  return problems.map((p) => {
    const severity = Number(p.severity);
    return {
      id: `zbx-${server.id}-${p.eventid}`,
      eventid: p.eventid,
      serverId: server.id,
      serverName: server.name || 'Zabbix',
      source: 'zabbix',
      title: p.name,
      severity,
      severityLabel: SEVERITY_LABELS[severity] || String(severity),
      hosts: hostsOf(p.objectid),
      since: Number(p.clock) * 1000,
      acknowledged: String(p.acknowledged) === '1',
      url: `${base}/tr_events.php?triggerid=${encodeURIComponent(p.objectid)}&eventid=${encodeURIComponent(p.eventid)}`,
    };
  });
}

function activeServers(zcfg) {
  return (zcfg.servers || []).filter((s) => s.enabled !== false && s.url);
}

// Busca em todos os servidores ao mesmo tempo. Um fora do ar não derruba os outros.
async function fetchAll(zcfg) {
  const servers = activeServers(zcfg);
  const results = await Promise.allSettled(servers.map((s) => fetchProblems(s, { minSeverity: zcfg.minSeverity })));
  const items = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else {
      // erros de rede não citam o servidor; põe o nome na frente pra saber qual caiu
      const msg = r.reason.message;
      const name = label(servers[i]);
      errors.push({ serverId: servers[i].id, message: msg.startsWith(name) ? msg : `${name}: ${msg}` });
    }
  });
  return { items, errors, servers: servers.length };
}

// Reconhece (ack) um evento no servidor de onde ele veio.
async function acknowledge(server, eventid, message) {
  const params = { eventids: [String(eventid)], action: 2 }; // 2 = reconhecer
  if (message) {
    params.action = 2 | 4; // reconhecer + adicionar mensagem
    params.message = message;
  }
  return call(server, 'event.acknowledge', params);
}

async function test(server, { minSeverity = 2 } = {}) {
  const key = normalizeApiUrl(server.url);
  detected.delete(key); // testa do zero
  workingMode.delete(key);
  let v = null;
  try {
    v = await version(server);
  } catch {
    // alguns proxies bloqueiam chamadas sem auth; segue o teste mesmo assim
  }
  const items = await fetchProblems(server, { minSeverity, limit: 5 });
  const mode = await authModeFor(server);
  const how = mode === 'body' ? 'token no corpo' : 'token no cabeçalho';
  const head = `Conectado${v ? ` ao Zabbix ${v}` : ''} (${how}).`;
  if (items.length) return `${head} ${items.length}+ problemas visíveis.`;

  // Nada apareceu: tenta explicar o porquê.
  const hosts = Number(await call(server, 'host.get', { countOutput: true }));
  if (!hosts) {
    return `${head} Mas o usuário deste token não enxerga nenhum host. No Zabbix, dê permissão de leitura nos grupos de hosts pro grupo de usuários dele (ou use um usuário com papel Super admin).`;
  }
  const all = await call(server, 'problem.get', { countOutput: true, source: 0, object: 0 });
  const below = Number(all);
  if (below) {
    return `${head} ${hosts} hosts visíveis, mas os ${below} problemas abertos estão abaixo da severidade mínima ou em manutenção.`;
  }
  return `${head} ${hosts} hosts visíveis, nenhum problema aberto.`;
}

module.exports = {
  fetchProblems,
  fetchAll,
  acknowledge,
  test,
  version,
  normalizeApiUrl,
  needsBodyAuth,
  activeServers,
  SEVERITY_LABELS,
  _resetDetection: () => {
    detected.clear();
    workingMode.clear();
    hostCache.clear();
  },
};
