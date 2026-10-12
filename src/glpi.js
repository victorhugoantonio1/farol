'use strict';
// Cliente da API REST "clássica" do GLPI (apirest.php), presente no GLPI 9.5, 10 e 11.
// Fluxo: initSession (user_token + App-Token) -> search/Ticket -> reusa a sessão.

const { request } = require('./http');

const STATUS = {
  1: 'Novo',
  2: 'Em atendimento',
  3: 'Planejado',
  4: 'Pendente',
  5: 'Solucionado',
  6: 'Fechado',
};
const PRIORITY = {
  1: 'Muito baixa',
  2: 'Baixa',
  3: 'Média',
  4: 'Alta',
  5: 'Muito alta',
  6: 'Crítica',
};

// Números dos campos na busca do GLPI (iguais desde o 9.x)
const F = { name: '1', id: '2', priority: '3', status: '12', date: '15', dateMod: '19', technician: '5' };

function normalizeApiUrl(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /apirest\.php$/i.test(trimmed) ? trimmed : `${trimmed}/apirest.php`;
}

function webBase(apiUrl) {
  return apiUrl.replace(/\/apirest\.php$/i, '');
}

function glpiError(res, prefix) {
  if (Array.isArray(res.json) && res.json.length) return new Error(`${prefix}: ${res.json.join(' – ')}`);
  return new Error(`${prefix}: HTTP ${res.status}`);
}

function parseGlpiDate(value) {
  if (!value) return null;
  // GLPI devolve "AAAA-MM-DD HH:MM:SS" no fuso do servidor.
  const t = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? null : t;
}

function createGlpiClient() {
  let session = null; // { key, token }

  function sessionKey(cfg) {
    return `${normalizeApiUrl(cfg.url)}|${cfg.userToken}|${cfg.appToken}`;
  }

  function baseHeaders(cfg) {
    const h = {};
    if (cfg.appToken) h['App-Token'] = cfg.appToken;
    return h;
  }

  async function initSession(cfg) {
    const api = normalizeApiUrl(cfg.url);
    if (!api) throw new Error('GLPI: URL não configurada');
    if (!cfg.userToken) throw new Error('GLPI: token de usuário não configurado');
    const res = await request(`${api}/initSession`, {
      headers: { ...baseHeaders(cfg), Authorization: `user_token ${cfg.userToken}` },
      insecure: !!cfg.insecure,
    });
    if (res.status !== 200 || !res.json || !res.json.session_token) throw glpiError(res, 'GLPI (login)');
    session = { key: sessionKey(cfg), token: res.json.session_token };
    return session.token;
  }

  async function getSession(cfg) {
    if (session && session.key === sessionKey(cfg)) return session.token;
    return initSession(cfg);
  }

  async function searchTickets(cfg, token) {
    const api = normalizeApiUrl(cfg.url);
    const limit = Number(cfg.limit ?? 50);
    const q = new URLSearchParams();
    let i = 0;
    q.set(`criteria[${i}][field]`, F.status);
    q.set(`criteria[${i}][searchtype]`, 'equals');
    q.set(`criteria[${i}][value]`, 'notold'); // "não solucionados"
    i++;
    if (cfg.onlyMine) {
      q.set(`criteria[${i}][link]`, 'AND');
      q.set(`criteria[${i}][field]`, F.technician);
      q.set(`criteria[${i}][searchtype]`, 'equals');
      q.set(`criteria[${i}][value]`, 'myself');
      i++;
    }
    [F.name, F.id, F.priority, F.status, F.date, F.dateMod].forEach((f, k) => q.set(`forcedisplay[${k}]`, f));
    q.set('sort', F.dateMod);
    q.set('order', 'DESC');
    q.set('range', `0-${Math.max(0, limit - 1)}`);

    return request(`${api}/search/Ticket?${q.toString()}`, {
      headers: { ...baseHeaders(cfg), 'Session-Token': token },
      insecure: !!cfg.insecure,
    });
  }

  async function fetchTickets(cfg) {
    let token = await getSession(cfg);
    let res = await searchTickets(cfg, token);
    if (res.status === 401) {
      // sessão expirou: faz login de novo uma vez
      session = null;
      token = await initSession(cfg);
      res = await searchTickets(cfg, token);
    }
    if (res.status !== 200 && res.status !== 206) throw glpiError(res, 'GLPI (busca)');

    const rows = (res.json && res.json.data) || [];
    const base = webBase(normalizeApiUrl(cfg.url));
    return rows.map((r) => {
      const id = r[F.id];
      const status = Number(r[F.status]);
      const priority = Number(r[F.priority]);
      return {
        id: `glpi-${id}`,
        source: 'glpi',
        number: id,
        title: r[F.name] || `Chamado #${id}`,
        status,
        statusLabel: STATUS[status] || String(r[F.status] ?? ''),
        priority,
        priorityLabel: PRIORITY[priority] || String(r[F.priority] ?? ''),
        since: parseGlpiDate(r[F.date]),
        updated: parseGlpiDate(r[F.dateMod]),
        url: `${base}/front/ticket.form.php?id=${encodeURIComponent(id)}`,
      };
    });
  }

  async function test(cfg) {
    session = null;
    const items = await fetchTickets({ ...cfg, limit: 5 });
    return `Conectado ao GLPI. ${items.length ? `${items.length}+ chamados abertos${cfg.onlyMine ? ' com você' : ''}.` : 'Nenhum chamado aberto.'}`;
  }

  async function close(cfg) {
    if (!session) return;
    const api = normalizeApiUrl(cfg.url);
    try {
      await request(`${api}/killSession`, {
        headers: { ...baseHeaders(cfg), 'Session-Token': session.token },
        insecure: !!cfg.insecure,
        timeoutMs: 3000,
      });
    } catch {
      // saindo do app, não importa
    }
    session = null;
  }

  return { fetchTickets, test, close };
}

module.exports = { createGlpiClient, normalizeApiUrl, STATUS, PRIORITY };
