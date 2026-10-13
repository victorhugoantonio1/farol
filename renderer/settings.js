'use strict';
/* global topwatch */

const $ = (id) => document.getElementById(id);

// campos simples: id do elemento = caminho na config
const FIELDS = [
  'demo',
  'notify',
  'pollSeconds',
  'ui.display',
  'ui.highlight',
  'ui.mascot',
  'zabbix.enabled',
  'zabbix.minSeverity',
  'glpi.enabled',
  'glpi.url',
  'glpi.userToken',
  'glpi.appToken',
  'glpi.onlyMine',
  'glpi.insecure',
];

const NUMBERS = new Set(['pollSeconds', 'zabbix.minSeverity']);

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => {
    o[k] = o[k] || {};
    o = o[k];
  });
  o[keys[keys.length - 1]] = value;
}

// ---------- servidores Zabbix ----------

const serversBox = $('servers');
let savedTokens = {}; // id -> já tem token salvo?

function newId() {
  return Math.random().toString(16).slice(2, 10);
}

function serverCard(srv) {
  const card = document.createElement('div');
  card.className = 'server';
  card.dataset.id = srv.id;
  card.innerHTML = `
    <div class="server-head">
      <input class="srv-name" type="text" maxlength="40" spellcheck="false" placeholder="Nome (ex.: Zabbix 7)" />
      <label class="switch inline"><input class="srv-enabled" type="checkbox" /> Ativo</label>
      <button class="icon-btn srv-remove" title="Remover servidor" aria-label="Remover servidor">✕</button>
    </div>
    <label class="field">
      <b>URL</b>
      <input class="srv-url" type="url" placeholder="https://zabbix.empresa.local" spellcheck="false" />
    </label>
    <label class="field">
      <b>Token de API</b>
      <input class="srv-token" type="password" autocomplete="off" spellcheck="false" />
      <small>Usuários → Tokens de API. Leitura basta pra ver alertas; "Reconhecer" precisa de escrita no host.</small>
    </label>
    <div class="row-2">
      <label class="field">
        <b>Autenticação</b>
        <select class="srv-auth">
          <option value="auto">Automática</option>
          <option value="header">Forçar 6.4+</option>
          <option value="body">Forçar 5.4 a 6.2</option>
        </select>
      </label>
      <label class="check"><input class="srv-insecure" type="checkbox" /> Aceitar certificado autoassinado</label>
    </div>
    <div class="test">
      <button class="secondary srv-test">Testar conexão</button>
      <span class="result"></span>
    </div>`;
  // valores entram por propriedade, nunca por HTML
  card.querySelector('.srv-name').value = srv.name || '';
  card.querySelector('.srv-enabled').checked = srv.enabled !== false;
  card.querySelector('.srv-url').value = srv.url || '';
  card.querySelector('.srv-token').placeholder = savedTokens[srv.id] ? '•••••••• (salvo — deixe vazio pra manter)' : '';
  card.querySelector('.srv-auth').value = srv.auth || 'auto';
  card.querySelector('.srv-insecure').checked = !!srv.insecure;

  card.querySelector('.srv-remove').addEventListener('click', () => {
    card.remove();
    if (!serversBox.children.length) $('add-server').click();
  });
  card.querySelector('.srv-test').addEventListener('click', (e) => runServerTest(card, e.currentTarget));
  return card;
}

function readServers() {
  return [...serversBox.querySelectorAll('.server')].map((card) => ({
    id: card.dataset.id,
    name: card.querySelector('.srv-name').value.trim(),
    enabled: card.querySelector('.srv-enabled').checked,
    url: card.querySelector('.srv-url').value.trim(),
    token: card.querySelector('.srv-token').value.trim(),
    auth: card.querySelector('.srv-auth').value,
    insecure: card.querySelector('.srv-insecure').checked,
  }));
}

function renderServers(servers) {
  serversBox.textContent = '';
  const list = servers.length ? servers : [{ id: newId(), name: 'Zabbix', enabled: true, auth: 'auto' }];
  list.forEach((srv) => serversBox.append(serverCard(srv)));
}

$('add-server').addEventListener('click', () => {
  const n = serversBox.children.length + 1;
  const card = serverCard({ id: newId(), name: `Zabbix ${n}`, enabled: true, auth: 'auto' });
  serversBox.append(card);
  card.querySelector('.srv-url').focus();
});

async function runServerTest(card, button) {
  const out = card.querySelector('.result');
  button.disabled = true;
  out.className = 'result';
  out.textContent = 'Testando…';
  try {
    const res = await topwatch.testConnection('zabbix', readForm(), card.dataset.id);
    out.className = `result ${res.ok ? 'ok' : 'fail'}`;
    out.textContent = res.message;
  } catch (err) {
    out.className = 'result fail';
    out.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- formulário ----------

function readForm() {
  const out = {};
  for (const id of FIELDS) {
    const input = $(id);
    let value = input.type === 'checkbox' ? input.checked : input.value.trim();
    if (NUMBERS.has(id)) value = Number(value);
    setPath(out, id, value);
  }
  out.zabbix.servers = readServers();
  return out;
}

function fillForm(data) {
  const { config, hasSecret, encryptionAvailable, forcedDemo } = data;
  for (const id of FIELDS) {
    const input = $(id);
    const value = getPath(config, id);
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
  }
  // segredos já salvos: o campo fica vazio, mas avisamos que existe
  savedTokens = {};
  for (const [key, has] of Object.entries(hasSecret)) {
    const m = key.match(/^zabbix\.servers\.(.+)\.token$/);
    if (m) {
      savedTokens[m[1]] = has;
      continue;
    }
    const input = $(key);
    if (input) input.placeholder = has ? '•••••••• (salvo — deixe vazio pra manter)' : '';
  }
  renderServers(config.zabbix.servers || []);
  $('warn-crypto').classList.toggle('hidden', encryptionAvailable);
  if (forcedDemo) {
    $('demo').checked = true;
    $('demo').disabled = true;
  }
}

async function runTest(which, button) {
  const out = $(`result-${which}`);
  button.disabled = true;
  out.className = 'result';
  out.textContent = 'Testando…';
  try {
    const res = await topwatch.testConnection(which, readForm());
    out.className = `result ${res.ok ? 'ok' : 'fail'}`;
    out.textContent = res.message;
  } catch (err) {
    out.className = 'result fail';
    out.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => runTest(b.dataset.test, b)));

let savedTimer;
$('save').addEventListener('click', async () => {
  const btn = $('save');
  btn.disabled = true;
  const res = await topwatch.saveSettings(readForm());
  btn.disabled = false;
  $('saved').textContent = res.ok ? 'Salvo. A barra já está usando as novas configurações.' : res.message;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').textContent = ''), 4000);
  // limpa os campos de segredo e recarrega os placeholders
  fillForm(await topwatch.getSettings());
});

topwatch.getSettings().then(fillForm);
