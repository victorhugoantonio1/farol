#!/usr/bin/env node
'use strict';
// Laboratório do TopWatch: prepara um Zabbix local e simula problemas pela API.
//
//   node lab/zabbix/lab.js setup              cria hosts, itens, triggers e um token de API
//   node lab/zabbix/lab.js fire <host|all>    dispara o problema de um host (ou de todos)
//   node lab/zabbix/lab.js resolve <host|all> normaliza o host (o problema fecha)
//   node lab/zabbix/lab.js status             mostra os problemas abertos agora
//   node lab/zabbix/lab.js scenario           roteiro automático: dispara e resolve aos poucos
//
// Tudo via API JSON-RPC. Os valores entram por history.push (Zabbix 7.0+) em itens do tipo trapper,
// então não precisa de agente, zabbix_sender nem host de verdade.
//
// Variáveis opcionais: ZABBIX_URL (padrão http://localhost:8080), ZABBIX_USER, ZABBIX_PASSWORD.

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('../../src/http');

const URL_BASE = (process.env.ZABBIX_URL || 'http://localhost:8080').replace(/\/+$/, '');
const API = `${URL_BASE}/api_jsonrpc.php`;
const USER = process.env.ZABBIX_USER || 'Admin';
const PASSWORD = process.env.ZABBIX_PASSWORD || 'zabbix';
const TOKEN_FILE = path.join(__dirname, '.token');
const GROUP = 'TopWatch Lab';
const TOKEN_NAME = 'topwatch-lab';

// Cada host tem um item trapper e uma trigger. "bad" dispara, "ok" normaliza.
const SCENARIOS = [
  { host: 'srv-app02', key: 'lab.icmp', item: 'ICMP ping', expr: '=0', name: 'Servidor sem resposta ao ICMP', priority: 5, bad: 0, ok: 1 },
  { host: 'srv-db01', key: 'lab.disk.free', item: 'Espaço livre em C: (%)', expr: '<10', name: 'Espaço em disco C: abaixo de 10%', priority: 4, bad: 6, ok: 48 },
  { host: 'fw-matriz', key: 'lab.loss', item: 'Perda de pacotes no link principal (%)', expr: '>20', name: 'Link principal com perda de pacotes > 20%', priority: 4, bad: 35, ok: 0 },
  { host: 'srv-rds03', key: 'lab.cpu', item: 'Uso de CPU (%)', expr: '>90', name: 'Uso de CPU acima de 90%', priority: 3, bad: 97, ok: 22 },
  { host: 'srv-print01', key: 'lab.spooler', item: 'Serviço Spooler rodando', expr: '=0', name: 'Serviço "Spooler" parado', priority: 2, bad: 0, ok: 1 },
  { host: 'web-portal', key: 'lab.ssl.days', item: 'Dias até o certificado expirar', expr: '<15', name: 'Certificado SSL expira em menos de 15 dias', priority: 2, bad: 12, ok: 210 },
];

let rpcId = 1;
async function rpc(method, params, auth) {
  const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
  const res = await request(API, { method: 'POST', headers, body: { jsonrpc: '2.0', method, params, id: rpcId++ } });
  if (!res.json) throw new Error(`${method}: HTTP ${res.status} sem JSON (o Zabbix já terminou de subir?)`);
  if (res.json.error) {
    const e = res.json.error;
    throw new Error(`${method}: ${e.message}${e.data ? ` (${e.data})` : ''}`);
  }
  return res.json.result;
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    throw new Error('Token não encontrado. Rode primeiro: node lab/zabbix/lab.js setup');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// O frontend demora pra subir na primeira vez (o servidor cria o banco).
async function waitForApi() {
  process.stdout.write(`Esperando o Zabbix em ${URL_BASE} `);
  for (let i = 0; i < 90; i++) {
    try {
      const v = await rpc('apiinfo.version', {});
      process.stdout.write(`ok (Zabbix ${v})\n`);
      return v;
    } catch {
      process.stdout.write('.');
      await sleep(3000);
    }
  }
  throw new Error('\nO Zabbix não respondeu em 4,5 min. Veja os logs: docker compose logs zabbix-web zabbix-server');
}

async function setup() {
  const version = await waitForApi();
  if (Number(String(version).split('.')[0]) < 7) throw new Error(`Precisa de Zabbix 7.0+ (history.push). Esse é ${version}.`);

  const session = await rpc('user.login', { username: USER, password: PASSWORD });

  // grupo
  let [group] = await rpc('hostgroup.get', { filter: { name: [GROUP] }, output: ['groupid'] }, session);
  if (!group) {
    const r = await rpc('hostgroup.create', { name: GROUP }, session);
    group = { groupid: r.groupids[0] };
  }

  for (const s of SCENARIOS) {
    let [host] = await rpc('host.get', { filter: { host: [s.host] }, output: ['hostid'] }, session);
    if (!host) {
      const r = await rpc('host.create', { host: s.host, groups: [{ groupid: group.groupid }] }, session);
      host = { hostid: r.hostids[0] };
    }

    const [item] = await rpc('item.get', { hostids: host.hostid, filter: { key_: [s.key] }, output: ['itemid'] }, session);
    if (!item) {
      await rpc(
        'item.create',
        {
          hostid: host.hostid,
          name: s.item,
          key_: s.key,
          type: 2, // Zabbix trapper
          value_type: 0, // número decimal
          history: '7d',
          trends: '0',
        },
        session
      );
    }

    const [trig] = await rpc('trigger.get', { hostids: host.hostid, filter: { description: [s.name] }, output: ['triggerid'] }, session);
    if (!trig) {
      await rpc(
        'trigger.create',
        { description: s.name, expression: `last(/${s.host}/${s.key})${s.expr}`, priority: s.priority, manual_close: 1 },
        session
      );
    }
    console.log(`  host ${s.host.padEnd(12)} pronto`);
  }

  // token de API pro TopWatch (recria a cada setup)
  const old = await rpc('token.get', { filter: { name: [TOKEN_NAME] }, output: ['tokenid'] }, session);
  if (old.length) await rpc('token.delete', old.map((t) => t.tokenid), session);
  const created = await rpc('token.create', { name: TOKEN_NAME }, session);
  const [{ token }] = await rpc('token.generate', created.tokenids, session);
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });

  await rpc('user.logout', [], session).catch(() => {});

  // começa tudo normal. Itens recém-criados levam alguns segundos pra entrar no cache do servidor,
  // então tenta de novo por até ~1 min.
  process.stdout.write('Esperando o servidor carregar os itens novos ');
  for (let i = 0; ; i++) {
    try {
      await push(token, SCENARIOS.map((s) => ({ host: s.host, key: s.key, value: s.ok })));
      process.stdout.write('ok\n');
      break;
    } catch (err) {
      if (i >= 20) throw err;
      process.stdout.write('.');
      await sleep(3000);
    }
  }

  console.log(`
Pronto. Configure o TopWatch (Configurações → Zabbix):
  URL:   ${URL_BASE}
  Token: ${token}
  (desmarque o modo demo e marque "Ativo" no Zabbix)

Depois simule:  node lab/zabbix/lab.js fire srv-app02   ou   node lab/zabbix/lab.js scenario`);
}

async function push(token, values) {
  const res = await rpc('history.push', values, token);
  const failed = (res.data || []).filter((d) => d.error);
  if (failed.length) {
    throw new Error(
      `history.push recusou ${failed.length} valor(es): ${failed.map((f) => f.error).join('; ')}\n` +
        'Se você acabou de rodar o setup, espere uns segundos: o servidor ainda está carregando os itens.'
    );
  }
  return res;
}

function pick(target) {
  if (!target) throw new Error(`Diga qual host: ${SCENARIOS.map((s) => s.host).join(', ')} ou all`);
  if (target === 'all') return SCENARIOS;
  const s = SCENARIOS.find((x) => x.host === target);
  if (!s) throw new Error(`Host desconhecido: ${target}. Opções: ${SCENARIOS.map((x) => x.host).join(', ')}, all`);
  return [s];
}

async function setState(target, bad) {
  const token = readToken();
  const list = pick(target);
  await push(token, list.map((s) => ({ host: s.host, key: s.key, value: bad ? s.bad : s.ok })));
  for (const s of list) console.log(`${bad ? 'disparado' : 'resolvido'}: ${s.host} (${s.name})`);
  console.log('O Zabbix leva alguns segundos pra abrir/fechar o problema; o TopWatch pega na próxima atualização.');
}

async function status() {
  const token = readToken();
  const problems = await rpc('problem.get', { output: ['name', 'severity', 'clock', 'acknowledged'], recent: false, sortfield: ['eventid'], sortorder: 'DESC' }, token);
  if (!problems.length) return console.log('Nenhum problema aberto.');
  const labels = ['Não class.', 'Informação', 'Atenção', 'Média', 'Alta', 'Desastre'];
  for (const p of problems) {
    console.log(`${labels[p.severity].padEnd(11)} ${p.acknowledged === '1' ? '[ack] ' : '      '}${p.name}`);
  }
}

async function scenario() {
  const token = readToken();
  const steps = [
    ['fire', 'srv-print01', 'Começa leve: um serviço parado (Atenção).'],
    ['fire', 'srv-rds03', 'CPU alta num servidor de RDS (Média).'],
    ['fire', 'srv-db01', 'Disco quase cheio (Alta). A barra deve destacar.'],
    ['fire', 'srv-app02', 'Servidor fora do ar (Desastre). Vigia em alarme.'],
    ['resolve', 'srv-app02', 'Servidor voltou.'],
    ['resolve', 'srv-db01', 'Liberaram espaço no disco.'],
    ['resolve', 'srv-rds03', 'CPU normalizou.'],
    ['resolve', 'srv-print01', 'Spooler reiniciado. Tudo calmo.'],
  ];
  const wait = Number(process.env.STEP_SECONDS || 40);
  console.log(`Roteiro com ${steps.length} passos, ${wait}s entre eles (mude com STEP_SECONDS). Ctrl+C pra parar.\n`);
  for (const [action, host, msg] of steps) {
    const s = pick(host)[0];
    await push(token, [{ host: s.host, key: s.key, value: action === 'fire' ? s.bad : s.ok }]);
    console.log(`${new Date().toLocaleTimeString('pt-BR')}  ${action === 'fire' ? '▲' : '▼'} ${host.padEnd(12)} ${msg}`);
    await sleep(wait * 1000);
  }
  console.log('\nFim do roteiro.');
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'setup':
      return setup();
    case 'fire':
      return setState(arg, true);
    case 'resolve':
      return setState(arg, false);
    case 'status':
      return status();
    case 'scenario':
      return scenario();
    default:
      console.log('Uso: node lab/zabbix/lab.js <setup | fire <host|all> | resolve <host|all> | status | scenario>');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nErro: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { SCENARIOS };
