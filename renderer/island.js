'use strict';
/* global topwatch */

const $ = (id) => document.getElementById(id);
const island = $('island');

let state = null;
let tab = 'zabbix';
let pinned = false;
let openTimer = null;
let closeTimer = null;
let heroItem = null;

// o vigia: um no card de destaque, outro no estado calmo
const heroBot = createBot($('hero-bot'));
const calmBot = createBot($('calm-bot'));
calmBot.setMood('sleep');

const UI_DEFAULT = { display: 'both', highlight: true, mascot: true };

function ui(s) {
  return { ...UI_DEFAULT, ...((s && s.ui) || {}) };
}

// o que cada modo de exibição considera
function shows(s, source) {
  const d = ui(s).display;
  return d === 'both' || d === source;
}

// prioridade do GLPI virando "nível" da luz quando a barra mostra só chamados
const PRIO_LEVEL = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 5, 6: 5 };

// ---------- utilidades ----------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // sempre textContent: nada de HTML vindo da API
  return n;
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'agora';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

function sevColor(sev) {
  return `var(--sev-${Math.min(5, Math.max(0, sev))})`;
}

// prioridade do GLPI (1–6) na mesma escala de cor dos alertas
function prioColor(p) {
  return sevColor({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 5, 6: 5 }[p] ?? 0);
}

function openProblems(s) {
  return s.zabbix.items.filter((p) => !p.acknowledged);
}

function sortedProblems(items) {
  return items.slice().sort((a, b) => a.acknowledged - b.acknowledged || b.severity - a.severity || b.since - a.since);
}

function sortedTickets(items) {
  return items.slice().sort((a, b) => b.priority - a.priority || (b.updated || 0) - (a.updated || 0));
}

// ---------- abrir / fechar ----------

function expand() {
  clearTimeout(closeTimer);
  island.classList.add('expanded');
  $('panel').setAttribute('aria-hidden', 'false');
}

function collapse() {
  if (pinned) return;
  island.classList.remove('expanded');
  $('panel').setAttribute('aria-hidden', 'true');
}

island.addEventListener('mouseenter', () => {
  topwatch.setInteractive(true);
  clearTimeout(closeTimer);
  openTimer = setTimeout(expand, 140); // passar o mouse por cima sem querer não abre
});

island.addEventListener('mouseleave', () => {
  clearTimeout(openTimer);
  if (pinned) return;
  closeTimer = setTimeout(() => {
    collapse();
    topwatch.setInteractive(false);
  }, 400);
});

// ---------- pílula ----------

function worstLevel(s) {
  if (shows(s, 'zabbix')) {
    const open = openProblems(s);
    if (open.length) return String(Math.max(...open.map((p) => p.severity)));
  } else if (s.glpi.items.length) {
    return String(Math.max(...s.glpi.items.map((t) => PRIO_LEVEL[t.priority] ?? 0)));
  }
  if ((shows(s, 'zabbix') && s.zabbix.error) || (shows(s, 'glpi') && s.glpi.error)) return 'error';
  return 'ok';
}

function renderSummary(s) {
  const summary = $('summary');
  summary.textContent = '';
  island.classList.remove('alerting');

  if (!s.zabbix.enabled && !s.glpi.enabled) {
    summary.append(el('span', null, 'Configure o TopWatch'));
    return;
  }

  // alerta grave aberto: a pílula mostra qual é (se essa opção estiver ligada)
  const worst = sortedProblems(openProblems(s))[0];
  if (ui(s).highlight && shows(s, 'zabbix') && worst && worst.severity >= 4) {
    island.classList.add('alerting');
    summary.append(el('b', null, worst.severityLabel));
    summary.append(el('span', 'sep', '·'));
    summary.append(el('span', null, worst.hosts[0] || worst.title));
    return;
  }

  const z = openProblems(s).length;
  const g = s.glpi.items.length;
  const parts = [];
  if (s.zabbix.enabled && shows(s, 'zabbix')) parts.push(`${z} alerta${z === 1 ? '' : 's'}`);
  if (s.glpi.enabled && shows(s, 'glpi')) parts.push(`${g} chamado${g === 1 ? '' : 's'}`);
  if (!parts.length) parts.push(shows(s, 'zabbix') ? 'Zabbix desativado' : 'GLPI desativado');
  parts.forEach((p, i) => {
    if (i) summary.append(el('span', 'sep', '·'));
    summary.append(el('span', null, p));
  });
}

// ---------- painel ----------

function renderHero(item) {
  heroItem = item;
  const hero = $('hero');
  hero.classList.toggle('hidden', !item);
  if (!item) return;

  const mascot = ui(state).mascot;
  $('hero-bot').classList.toggle('hidden', !mascot);
  $('hero-orb').classList.toggle('hidden', mascot);
  heroBot.setMood(item.source === 'zabbix' && item.severity >= 4 ? 'alarm' : 'watch');

  const meta = $('hero-meta');
  meta.textContent = '';
  const ack = $('hero-ack');

  if (item.source === 'zabbix') {
    hero.style.setProperty('--c', sevColor(item.severity));
    hero.classList.toggle('pulse', item.severity >= 4);
    meta.append(el('span', 'sev', item.severityLabel));
    meta.append(el('span', null, '·'));
    meta.append(el('span', 'host', item.hosts.join(', ') || '—'));
    if (state.zabbix.multi && item.serverName) meta.append(el('span', 'srv', item.serverName));
    meta.append(el('span', null, '·'));
    meta.append(el('span', null, ago(item.since)));
    ack.classList.remove('hidden');
    ack.disabled = false;
    ack.textContent = 'Reconhecer';
    $('hero-open').textContent = 'Abrir';
  } else {
    hero.style.setProperty('--c', prioColor(item.priority));
    hero.classList.toggle('pulse', item.priority >= 5);
    meta.append(el('span', 'sev', item.priorityLabel));
    meta.append(el('span', null, '·'));
    meta.append(el('span', 'host', `#${item.number}`));
    meta.append(el('span', null, '·'));
    meta.append(el('span', null, item.statusLabel));
    ack.classList.add('hidden');
    $('hero-open').textContent = 'Abrir chamado';
  }
  $('hero-title').textContent = item.title;
}

function row(item) {
  const li = el('li', `row${item.acknowledged ? ' ack' : ''}`);
  li.title = item.title;
  li.style.setProperty('--c', item.source === 'zabbix' ? sevColor(item.severity) : prioColor(item.priority));
  li.append(el('span', 'dot'));
  li.append(el('span', 'title', item.title));
  const where = el('span', 'where', item.source === 'zabbix' ? item.hosts.join(', ') : `#${item.number} · ${item.statusLabel}`);
  if (item.source === 'zabbix' && state.zabbix.multi && item.serverName) where.prepend(el('span', 'srv', item.serverName));
  li.append(where);
  li.append(el('span', 'age', ago(item.source === 'zabbix' ? item.since : item.updated || item.since)));
  li.addEventListener('click', () => topwatch.openUrl(item.url));
  li.addEventListener('mouseenter', () => {
    const r = li.getBoundingClientRect();
    heroBot.lookAt(r.left + r.width * 0.35, r.top + r.height / 2);
  });
  return li;
}

function renderPanel(s) {
  const src = s[tab];

  const errBox = $('error');
  errBox.classList.toggle('hidden', !src.error);
  errBox.textContent = src.error || '';

  let items;
  let hero = null;
  if (tab === 'zabbix') {
    items = sortedProblems(src.items);
    if (items[0] && !items[0].acknowledged) hero = items.shift();
  } else {
    items = sortedTickets(src.items);
    hero = items.shift() || null;
  }

  renderHero(hero);

  const list = $('list');
  list.textContent = '';
  items.forEach((it) => list.append(row(it)));

  // calmo = nada pendente nessa aba
  const calm = !hero && !src.error;
  const quiet = calm && items.length === 0;
  $('calm').classList.toggle('hidden', !quiet);
  island.classList.toggle('quiet', quiet);
  const mascot = ui(s).mascot;
  $('calm-bot').classList.toggle('hidden', !mascot);
  $('calm-orb').classList.toggle('hidden', mascot);
  if (!src.enabled) $('calm-text').textContent = `${tab === 'zabbix' ? 'Zabbix' : 'GLPI'} desativado nas configurações.`;
  else if (tab === 'zabbix') $('calm-text').textContent = 'Nenhum alerta pendente. Tudo calmo.';
  else $('calm-text').textContent = 'Nenhum chamado aberto.';
}

function applyDisplay(s) {
  const d = ui(s).display;
  if (d !== 'both' && tab !== d) {
    tab = d;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  }
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('hidden', !shows(s, x.dataset.tab)));
}

function renderHeader(s) {
  const zHot = openProblems(s).some((p) => p.severity >= 4);
  $('count-zabbix').textContent = openProblems(s).length;
  $('count-zabbix').classList.toggle('hot', zHot);
  $('count-glpi').textContent = s.glpi.items.length;
  $('updated').textContent = s.updatedAt ? (ago(s.updatedAt) === 'agora' ? 'atualizado agora' : `há ${ago(s.updatedAt)}`) : '';
  $('demo-badge').classList.toggle('hidden', !s.demo);
}

function render() {
  if (!state) return;
  applyDisplay(state);
  island.dataset.level = worstLevel(state);
  renderSummary(state);
  renderHeader(state);
  renderPanel(state);
}

// ---------- eventos ----------

document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    render();
  })
);

$('btn-refresh').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.classList.remove('spin');
  void btn.offsetWidth;
  btn.classList.add('spin');
  topwatch.refresh();
});

$('btn-settings').addEventListener('click', () => topwatch.openSettings());
$('btn-unpin').addEventListener('click', () => topwatch.unpin());

$('hero-open').addEventListener('click', () => {
  if (heroItem) topwatch.openUrl(heroItem.url);
});

$('hero-ack').addEventListener('click', async () => {
  if (!heroItem || heroItem.source !== 'zabbix') return;
  const btn = $('hero-ack');
  btn.disabled = true;
  btn.textContent = 'Reconhecendo…';
  const res = await topwatch.acknowledge(heroItem.id);
  if (res.ok) heroBot.celebrate();
  if (!res.ok) {
    btn.disabled = false;
    btn.textContent = 'Reconhecer';
    const errBox = $('error');
    errBox.textContent = `Não deu pra reconhecer: ${res.message}`;
    errBox.classList.remove('hidden');
  }
  // em caso de sucesso o processo principal manda o estado novo
});

$('panel').addEventListener('mousemove', (e) => {
  if (e.target.closest('.row')) return; // nas linhas, ela olha pra linha
  heroBot.lookAt(e.clientX, e.clientY);
});
$('list').addEventListener('mouseleave', () => heroBot.lookDown());
island.addEventListener('mouseleave', () => heroBot.lookDown());

topwatch.onState((s) => {
  state = s;
  render();
});

topwatch.onPinned((p) => {
  pinned = p;
  $('btn-unpin').classList.toggle('hidden', !p);
  if (p) expand();
  else collapse();
});

topwatch.onAlert(() => {
  heroBot.jolt();
  island.classList.remove('ping');
  void island.offsetWidth;
  island.classList.add('ping');
});

// atualiza os "há X min" sem esperar a próxima coleta
setInterval(render, 30000);

topwatch.getState().then((s) => {
  state = s;
  render();
});
