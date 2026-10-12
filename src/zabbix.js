'use strict';
// Cliente da API JSON-RPC do Zabbix.
// Zabbix 6.4+ autentica com o header "Authorization: Bearer <token>".
// Versões anteriores usam o campo "auth" no corpo (opção legacyAuth).

const { request } = require('./http');

const SEVERITY_LABELS = ['Não classificado', 'Informação', 'Atenção', 'Média', 'Alta', 'Desastre'];

function baseUrl(apiUrl) {
  return String(apiUrl)
    .replace(/\/api_jsonrpc\.php\/?$/i, '')
    .replace(/\/+$/, '');
}

function normalizeApiUrl(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /api_jsonrpc\.php$/i.test(trimmed) ? trimmed : `${trimmed}/api_jsonrpc.php`;
}

async function call(cfg, method, params, { auth = true } = {}) {
  const url = normalizeApiUrl(cfg.url);
  if (!url) throw new Error('Zabbix: URL não configurada');
  const body = { jsonrpc: '2.0', method, params, id: Date.now() };
  const headers = {};
  if (auth) {
    if (!cfg.token) throw new Error('Zabbix: token não configurado');
    if (cfg.legacyAuth) body.auth = cfg.token;
    else headers.Authorization = `Bearer ${cfg.token}`;
  }

  const res = await request(url, { method: 'POST', headers, body, insecure: !!cfg.insecure });
  if (res.json === undefined || res.json === null) {
    throw new Error(`Zabbix respondeu HTTP ${res.status} sem JSON. A URL aponta para o frontend do Zabbix?`);
  }
  if (res.json.error) {
    const e = res.json.error;
    throw new Error(`Zabbix: ${e.message}${e.data ? ` (${e.data})` : ''}`);
  }
  return res.json.result;
}

async function version(cfg) {
  // apiinfo.version precisa ser chamado SEM autenticação.
  return call(cfg, 'apiinfo.version', {}, { auth: false });
}

async function fetchProblems(cfg) {
  const minSeverity = Math.min(5, Math.max(0, Number(cfg.minSeverity ?? 2)));
  const severities = [];
  for (let s = minSeverity; s <= 5; s++) severities.push(s);

  const problems = await call(cfg, 'problem.get', {
    output: ['eventid', 'objectid', 'name', 'severity', 'clock', 'acknowledged'],
    source: 0, // eventos de trigger
    object: 0,
    severities,
    suppressed: false,
    recent: false,
    sortfield: ['eventid'],
    sortorder: 'DESC',
    limit: Number(cfg.limit ?? 50),
  });

  // problem.get não traz o host; buscamos pelos triggers.
  const triggerIds = [...new Set(problems.map((p) => p.objectid))];
  const hostsByTrigger = {};
  if (triggerIds.length) {
    const triggers = await call(cfg, 'trigger.get', {
      triggerids: triggerIds,
      output: ['triggerid'],
      selectHosts: ['hostid', 'host', 'name'],
    });
    for (const t of triggers) {
      hostsByTrigger[t.triggerid] = (t.hosts || []).map((h) => h.name || h.host);
    }
  }

  const base = baseUrl(normalizeApiUrl(cfg.url));
  return problems.map((p) => {
    const severity = Number(p.severity);
    return {
      id: `zbx-${p.eventid}`,
      eventid: p.eventid,
      source: 'zabbix',
      title: p.name,
      severity,
      severityLabel: SEVERITY_LABELS[severity] || String(severity),
      hosts: hostsByTrigger[p.objectid] || [],
      since: Number(p.clock) * 1000,
      acknowledged: String(p.acknowledged) === '1',
      url: `${base}/tr_events.php?triggerid=${encodeURIComponent(p.objectid)}&eventid=${encodeURIComponent(p.eventid)}`,
    };
  });
}

// Reconhece (ack) um evento. O token precisa ter permissão de escrita no host.
async function acknowledge(cfg, eventid, message) {
  const params = { eventids: [String(eventid)], action: 2 }; // 2 = reconhecer
  if (message) {
    params.action = 2 | 4; // reconhecer + adicionar mensagem
    params.message = message;
  }
  return call(cfg, 'event.acknowledge', params);
}

async function test(cfg) {
  let v = null;
  try {
    v = await version(cfg);
  } catch {
    // alguns proxies bloqueiam chamadas sem auth; segue o teste mesmo assim
  }
  const items = await fetchProblems({ ...cfg, limit: 5 });
  return `Conectado${v ? ` ao Zabbix ${v}` : ''}. ${items.length ? `${items.length}+ problemas visíveis.` : 'Nenhum problema aberto.'}`;
}

module.exports = { fetchProblems, acknowledge, test, version, normalizeApiUrl, SEVERITY_LABELS };
