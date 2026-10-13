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
  let session = null; // { key, token, userId, login, profile, profileInterface, entities, techId }

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
    await prepareSession(cfg, api);
    return session.token;
  }

  // A sessão da API nasce no perfil e na entidade PADRÃO do usuário, sem as subentidades.
  // Num GLPI com entidades por cliente (TRADE > CONTRATO > ...), isso esconde quase tudo.
  // Aqui: ativa todas as entidades (com subentidades) e, se o perfil padrão for de
  // autoatendimento, troca pra um perfil técnico. Se a versão não suportar, segue como está.
  async function prepareSession(cfg, api) {
    const h = { ...baseHeaders(cfg), 'Session-Token': session.token };
    const opts = (extra) => ({ headers: h, insecure: !!cfg.insecure, ...extra });
    const allEntities = () =>
      request(`${api}/changeActiveEntities`, opts({ method: 'POST', body: { entities_id: 'all', is_recursive: true } }));
    const full = async () => {
      const r = await request(`${api}/getFullSession`, opts());
      return (r.status === 200 && r.json && r.json.session) || null;
    };
    try {
      await allEntities();
      let s = await full();
      if (s && s.glpiactiveprofile && s.glpiactiveprofile.interface === 'helpdesk') {
        const current = String(s.glpiactiveprofile.id);
        for (const id of Object.keys(s.glpiprofiles || {})) {
          if (id === current) continue;
          const ch = await request(`${api}/changeActiveProfile`, opts({ method: 'POST', body: { profiles_id: Number(id) } }));
          if (ch.status !== 200) continue;
          await allEntities(); // trocar de perfil volta pra entidade padrão
          const next = await full();
          if (next && next.glpiactiveprofile && next.glpiactiveprofile.interface === 'central') {
            s = next;
            break;
          }
        }
      }
      if (s) {
        session.userId = s.glpiID ? String(s.glpiID) : null;
        session.login = s.glpiname || null;
        session.profile = s.glpiactiveprofile ? s.glpiactiveprofile.name : null;
        session.profileInterface = s.glpiactiveprofile ? s.glpiactiveprofile.interface : null;
        session.entities = s.glpiactiveentities ? Object.keys(s.glpiactiveentities).length : null;
      }
    } catch {
      // GLPI antigo ou endpoint bloqueado: fica com o padrão da sessão
    }
  }

  // Login do técnico -> id. Guardado na sessão; refeito se o login mudar.
  async function technicianId(cfg, token) {
    const login = String(cfg.technician || '').trim();
    if (!login) return (session && session.userId) || 'myself';
    if (session && session.techLogin === login && session.techId) return session.techId;
    const api = normalizeApiUrl(cfg.url);
    const q = new URLSearchParams();
    q.set('criteria[0][field]', '1'); // login
    q.set('criteria[0][searchtype]', 'contains');
    q.set('criteria[0][value]', `^${login}$`);
    q.set('forcedisplay[0]', '2'); // id
    q.set('range', '0-1');
    const res = await request(`${api}/search/User?${q.toString()}`, {
      headers: { ...baseHeaders(cfg), 'Session-Token': token },
      insecure: !!cfg.insecure,
    });
    if (res.status === 401) return null; // sessão expirou; fetchTickets refaz o login
    if (res.status !== 200 && res.status !== 206) throw glpiError(res, 'GLPI (busca do técnico)');
    const row = res.json && res.json.data && res.json.data[0];
    if (!row || !row[2]) throw new Error(`GLPI: usuário "${login}" não encontrado. Use o login (o nome usado pra entrar no GLPI).`);
    session.techLogin = login;
    session.techId = String(row[2]);
    return session.techId;
  }

  async function getSession(cfg) {
    if (session && session.key === sessionKey(cfg)) return session.token;
    return initSession(cfg);
  }

  async function searchTickets(cfg, token) {
    const api = normalizeApiUrl(cfg.url);
    let tech = null;
    if (cfg.onlyMine) {
      tech = await technicianId(cfg, token);
      if (tech === null) return { status: 401 };
    }
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
      // o id do usuário é mais confiável que o "myself", que nem toda versão aceita na busca
      q.set(`criteria[${i}][value]`, tech);
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
    const info = [];
    if (session && session.login) info.push(`como ${session.login}`);
    if (session && session.profile) info.push(`perfil ${session.profile}`);
    if (session && session.entities) info.push(`${session.entities} ${session.entities === 1 ? 'entidade' : 'entidades'}`);
    const head = `Conectado ao GLPI${info.length ? ` (${info.join(', ')})` : ''}.`;
    if (items.length) return `${head} ${items.length}+ chamados abertos${cfg.onlyMine ? ' atribuídos a você' : ''}.`;
    if (session && session.profileInterface === 'helpdesk') {
      return `${head} Nenhum chamado: o perfil ativo é de autoatendimento e só enxerga chamados que você abriu. Peça um perfil técnico pro seu usuário no GLPI.`;
    }
    if (cfg.onlyMine && !String(cfg.technician || '').trim() && session && session.login) {
      return `${head} Nenhum chamado atribuído ao usuário "${session.login}", que é o dono deste token. Se esse não é você, preencha "Seu login no GLPI".`;
    }
    const who = String(cfg.technician || '').trim();
    return `${head} Nenhum chamado aberto${cfg.onlyMine ? ` atribuído a ${who ? `"${who}"` : 'você'} como técnico. Se o chamado está só no seu grupo, desmarque "só os meus"` : ''}.`;
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
