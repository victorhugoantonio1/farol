'use strict';
/* global farol */

const $ = (id) => document.getElementById(id);

// campos simples: id do elemento = caminho na config
const FIELDS = [
  'demo',
  'notify',
  'pollSeconds',
  'zabbix.enabled',
  'zabbix.url',
  'zabbix.token',
  'zabbix.minSeverity',
  'zabbix.legacyAuth',
  'zabbix.insecure',
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

function readForm() {
  const out = {};
  for (const id of FIELDS) {
    const input = $(id);
    let value = input.type === 'checkbox' ? input.checked : input.value.trim();
    if (NUMBERS.has(id)) value = Number(value);
    setPath(out, id, value);
  }
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
  for (const [key, has] of Object.entries(hasSecret)) {
    const input = $(key);
    if (input) input.placeholder = has ? '•••••••• (salvo — deixe vazio pra manter)' : '';
  }
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
    const res = await farol.testConnection(which, readForm());
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
  const res = await farol.saveSettings(readForm());
  btn.disabled = false;
  $('saved').textContent = res.ok ? 'Salvo. A barra já está usando as novas configurações.' : res.message;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').textContent = ''), 4000);
  // limpa os campos de segredo e recarrega os placeholders
  fillForm(await farol.getSettings());
});

farol.getSettings().then(fillForm);
