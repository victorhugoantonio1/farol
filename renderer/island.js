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

// plugins com aba (ativos, ou com dados de exemplo no demo)
function pluginTabs(s) {
  return (s.plugins || []).filter((p) => p.enabled);
}

function pluginById(s, id) {
  return pluginTabs(s).find((p) => p.id === id) || null;
}

// modo de exibição: 'both' (tudo), 'zabbix' ou o id de um plugin
function display(s) {
  const d = ui(s).display;
  if (d === 'both' || d === 'zabbix' || pluginById(s, d)) return d;
  return 'both'; // plugin escolhido não está mais instalado/ativo
}

function shows(s, source) {
  const d = display(s);
  return d === 'both' || d === source;
}

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

function openProblems(s) {
  return s.zabbix.items.filter((p) => !p.acknowledged);
}

function sortedProblems(items) {
  return items.slice().sort((a, b) => a.acknowledged - b.acknowledged || b.severity - a.severity || b.since - a.since);
}

function sortedPluginItems(items) {
  return items.slice().sort((a, b) => b.level - a.level || (b.updated || b.since || 0) - (a.updated || a.since || 0));
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
  } else {
    const p = pluginById(s, display(s));
    if (p && p.items.length) return String(Math.max(...p.items.map((it) => it.level)));
  }
  const visibleErrors = [shows(s, 'zabbix') && s.zabbix.error, ...pluginTabs(s).map((p) => shows(s, p.id) && p.error)];
  if (visibleErrors.some(Boolean)) return 'error';
  return 'ok';
}

function renderSummary(s) {
  const summary = $('summary');
  summary.textContent = '';
  island.classList.remove('alerting');

  if (!s.zabbix.enabled && !pluginTabs(s).length) {
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
  const parts = [];
  if (s.zabbix.enabled && shows(s, 'zabbix')) parts.push(`${z} alerta${z === 1 ? '' : 's'}`);
  for (const p of pluginTabs(s)) {
    if (!shows(s, p.id)) continue;
    const n = p.items.length;
    parts.push(`${n} ${n === 1 ? p.tab.singular : p.tab.plural}`);
  }
  if (!parts.length) parts.push('Zabbix desativado');
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
    // item de plugin
    const p = pluginById(state, item.source);
    hero.style.setProperty('--c', sevColor(item.level));
    hero.classList.toggle('pulse', item.level >= 5);
    const bits = [item.levelLabel, item.tag, item.detail].filter(Boolean);
    bits.forEach((b, i) => {
      if (i) meta.append(el('span', null, '·'));
      meta.append(el('span', i === 0 ? 'sev' : i === 1 ? 'host' : null, b));
    });
    ack.classList.add('hidden');
    $('hero-open').textContent = (p && p.tab.openLabel) || 'Abrir';
    $('hero-open').classList.toggle('hidden', !item.url);
  }
  if (item.source === 'zabbix') $('hero-open').classList.remove('hidden');
  $('hero-title').textContent = item.title;
}

function row(item) {
  const li = el('li', `row${item.acknowledged ? ' ack' : ''}`);
  li.title = item.title;
  const isZbx = item.source === 'zabbix';
  li.style.setProperty('--c', sevColor(isZbx ? item.severity : item.level));
  li.append(el('span', 'dot'));
  li.append(el('span', 'title', item.title));
  const where = el('span', 'where', isZbx ? item.hosts.join(', ') : [item.tag, item.detail].filter(Boolean).join(' · '));
  if (item.source === 'zabbix' && state.zabbix.multi && item.serverName) where.prepend(el('span', 'srv', item.serverName));
  li.append(where);
  li.append(el('span', 'age', ago(isZbx ? item.since : item.updated || item.since)));
  li.addEventListener('click', () => {
    if (item.url) topwatch.openUrl(item.url);
  });
  li.addEventListener('mouseenter', () => {
    const r = li.getBoundingClientRect();
    heroBot.lookAt(r.left + r.width * 0.35, r.top + r.height / 2);
  });
  return li;
}

function renderPanel(s) {
  const plugin = tab === 'zabbix' ? null : pluginById(s, tab);
  const src = plugin || s.zabbix;

  const errBox = $('error');
  errBox.classList.toggle('hidden', !src.error);
  errBox.textContent = src.error || '';

  let items;
  let hero = null;
  if (tab === 'zabbix') {
    items = sortedProblems(src.items);
    if (items[0] && !items[0].acknowledged) hero = items.shift();
  } else {
    items = sortedPluginItems(src.items);
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
  if (!src.enabled) $('calm-text').textContent = 'Zabbix desativado nas configurações.';
  else if (!plugin) $('calm-text').textContent = 'Nenhum alerta pendente. Tudo calmo.';
  else $('calm-text').textContent = plugin.tab.empty;
}

// abas dos plugins: recriadas só quando o conjunto de plugins muda
let tabsKey = '';
function syncPluginTabs(s) {
  const list = pluginTabs(s);
  const key = list.map((p) => `${p.id}:${p.tab.label}`).join('|');
  if (key === tabsKey) return;
  tabsKey = key;
  document.querySelectorAll('.tab[data-plugin]').forEach((b) => b.remove());
  const nav = $('tabs');
  for (const p of list) {
    const b = el('button', 'tab');
    b.dataset.tab = p.id;
    b.dataset.plugin = '1';
    b.setAttribute('role', 'tab');
    b.append(document.createTextNode(p.tab.label));
    const c = el('span', 'count', '0');
    c.dataset.count = p.id;
    b.append(c);
    nav.append(b);
  }
  if (tab !== 'zabbix' && !pluginById(s, tab)) tab = 'zabbix';
}

function applyDisplay(s) {
  syncPluginTabs(s);
  const d = display(s);
  if (d !== 'both') tab = d;
  document.querySelectorAll('.tab').forEach((x) => {
    x.classList.toggle('active', x.dataset.tab === tab);
    x.classList.toggle('hidden', !shows(s, x.dataset.tab));
  });
}

function renderHeader(s) {
  const zHot = openProblems(s).some((p) => p.severity >= 4);
  $('count-zabbix').textContent = openProblems(s).length;
  $('count-zabbix').classList.toggle('hot', zHot);
  for (const p of pluginTabs(s)) {
    const c = document.querySelector(`.count[data-count="${p.id}"]`);
    if (c) c.textContent = p.items.length;
  }
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

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  tab = b.dataset.tab;
  render();
});

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
