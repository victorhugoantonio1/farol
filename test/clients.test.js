'use strict';
// Testa o cliente do Zabbix contra servidores falsos, as configurações e o carregador de plugins.
// Rode com: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const zabbix = require('../src/zabbix');
const { migrate } = require('../src/config');
const { createStore } = require('../src/config');
const pluginKit = require('../src/plugins');

// plugin de mentira pros testes de configuração
const FAKE_PLUGIN = {
  id: 'tickets',
  fields: [
    { key: 'url', type: 'url' },
    { key: 'token', type: 'secret' },
    { key: 'onlyMine', type: 'checkbox', default: true },
  ],
};

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

test('Zabbix: busca problemas, junta os hosts e monta o link', async () => {
  const calls = [];
  const { server, url } = await serve((req, res, raw) => {
    const body = JSON.parse(raw);
    calls.push({ method: body.method, auth: req.headers.authorization, bodyAuth: body.auth, params: body.params });
    if (body.method === 'problem.get') {
      return json(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: [
          { eventid: '901', objectid: '55', name: 'Disco cheio', severity: '4', clock: '1760000000', acknowledged: '0' },
          { eventid: '902', objectid: '56', name: 'Host fora', severity: '5', clock: '1760000100', acknowledged: '1' },
        ],
      });
    }
    if (body.method === 'trigger.get') {
      return json(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: [
          { triggerid: '55', hosts: [{ hostid: '1', host: 'srv-db01', name: 'Banco 01' }] },
          { triggerid: '56', hosts: [{ hostid: '2', host: 'srv-app02', name: '' }] },
        ],
      });
    }
    json(res, 200, { jsonrpc: '2.0', id: body.id, error: { message: 'método inesperado' } });
  });

  try {
    const items = await zabbix.fetchProblems({ id: 'z7', name: 'Zabbix 7', url: `${url}/zabbix`, token: 'abc', auth: 'header' }, { minSeverity: 3 });
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Disco cheio');
    assert.deepEqual(items[0].hosts, ['Banco 01']);
    assert.deepEqual(items[1].hosts, ['srv-app02']); // sem "name" cai no "host"
    assert.equal(items[1].acknowledged, true);
    assert.equal(items[1].severityLabel, 'Desastre');
    assert.equal(items[0].since, 1760000000 * 1000);
    assert.equal(items[0].url, `${url}/zabbix/tr_events.php?triggerid=55&eventid=901`);

    assert.equal(calls[0].auth, 'Bearer abc');
    assert.equal(calls[0].bodyAuth, undefined);
    assert.deepEqual(calls[0].params.severities, [3, 4, 5]);
  } finally {
    server.close();
  }
});

test('Zabbix: modo legado manda o token no corpo', async () => {
  let seen;
  const { server, url } = await serve((req, res, raw) => {
    const body = JSON.parse(raw);
    seen = { header: req.headers.authorization, auth: body.auth };
    json(res, 200, { jsonrpc: '2.0', id: body.id, result: [] });
  });
  try {
    await zabbix.fetchProblems({ id: 'z6', url: `${url}/api_jsonrpc.php`, token: 'old', legacyAuth: true });
    assert.equal(seen.header, undefined);
    assert.equal(seen.auth, 'old');
  } finally {
    server.close();
  }
});

test('Zabbix: erro da API vira mensagem legível', async () => {
  const { server, url } = await serve((req, res, raw) => {
    const body = JSON.parse(raw);
    json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params.', data: 'Not authorized.' } });
  });
  try {
    await assert.rejects(zabbix.fetchProblems({ id: 'z', url, token: 'x', auth: 'header' }), /Invalid params\. \(Not authorized\.\)/);
  } finally {
    server.close();
  }
});

test('Config: segredos são criptografados no disco e não voltam pra tela', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topwatch-'));
  // safeStorage falso (no app de verdade é o DPAPI do Windows)
  const store = createStore({ dir, safeStorage: fakeSafe, plugins: [FAKE_PLUGIN] });
  store.save({
    zabbix: {
      servers: [
        { id: 'z7', name: 'Zabbix 7', url: 'https://z7', token: 'segredo7' },
        { id: 'z6', name: 'Zabbix 6', url: 'https://z6', token: 'segredo6', auth: 'body' },
      ],
    },
    plugins: { tickets: { enabled: true, url: 'https://t', token: 'ptok' } },
  });

  const onDisk = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!onDisk.includes('"segredo7"') && !onDisk.includes('"segredo6"') && !onDisk.includes('"ptok"'));

  const masked = store.getMasked();
  assert.equal(masked.config.zabbix.servers[0].token, '');
  assert.equal(masked.hasSecret['zabbix.servers.z7.token'], true);
  assert.equal(masked.hasSecret['plugins.tickets.token'], true);
  assert.equal(masked.config.plugins.tickets.token, '');

  // salvar com o token vazio mantém o token daquele servidor; remover um servidor apaga o dele
  store.save({ zabbix: { servers: [{ id: 'z7', name: 'Zabbix 7', url: 'https://z7-novo', token: '' }] } });
  const reopened = createStore({ dir, safeStorage: fakeSafe, plugins: [FAKE_PLUGIN] });
  const servers = reopened.get().zabbix.servers;
  assert.equal(servers.length, 1);
  assert.equal(servers[0].token, 'segredo7');
  assert.equal(servers[0].url, 'https://z7-novo');
  assert.equal(reopened.get().plugins.tickets.token, 'ptok');
  assert.equal(reopened.get().plugins.tickets.onlyMine, true); // padrão do campo
});

test('Zabbix: Reconhecer chama event.acknowledge com action 2', async () => {
  let seen;
  const { server, url } = await serve((req, res, raw) => {
    const body = JSON.parse(raw);
    seen = body;
    json(res, 200, { jsonrpc: '2.0', id: body.id, result: { eventids: body.params.eventids } });
  });
  try {
    await zabbix.acknowledge({ id: 'z', url, token: 't', auth: 'header' }, '901');
    assert.equal(seen.method, 'event.acknowledge');
    assert.deepEqual(seen.params, { eventids: ['901'], action: 2 });
  } finally {
    server.close();
  }
});

test('Zabbix: Reconhecer com mensagem e, sem permissão de comentar, sem ela', async () => {
  const seen = [];
  let canComment = true;
  const { server, url } = await serve((req, res, raw) => {
    const body = JSON.parse(raw);
    seen.push(body.params);
    if (!canComment && body.params.message) {
      return json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32500, message: 'Application error.', data: 'No permissions to add problem comments.' } });
    }
    json(res, 200, { jsonrpc: '2.0', id: body.id, result: { eventids: body.params.eventids } });
  });
  try {
    const srv = { id: 'z', url, token: 't', auth: 'header' };
    await zabbix.acknowledge(srv, '901', zabbix.ACK_MESSAGE);
    assert.deepEqual(seen[0], { eventids: ['901'], action: 6, message: 'Reconhecido pelo TopWatch' });
    canComment = false;
    seen.length = 0;
    await zabbix.acknowledge(srv, '902', zabbix.ACK_MESSAGE);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], { eventids: ['902'], action: 2 });
  } finally {
    server.close();
  }
});


// Zabbix falso que se comporta como 6.0 (token só no corpo) ou 7.0 (token no cabeçalho)
function fakeZabbix(versionString, { failVersion = false, stripHeader = false, noHosts = false } = {}) {
  const calls = [];
  const modern = !zabbix.needsBodyAuth(versionString);
  const bodyRemoved = /^7\.[2-9]/.test(versionString); // 7.2+ não aceita mais "auth" no corpo
  return serve((req, res, raw) => {
    const body = JSON.parse(raw);
    const header = stripHeader ? undefined : req.headers.authorization; // proxy que remove o cabeçalho
    calls.push({ method: body.method, header, bodyAuth: body.auth });
    const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: body.id, result });
    const fail = (message, data) => json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message, data } });
    if (body.method === 'apiinfo.version') {
      if (failVersion) return json(res, 403, {});
      return reply(versionString);
    }
    if (bodyRemoved && body.auth) return fail('Invalid params.', 'Invalid parameter "/": unexpected parameter "auth".');
    const token = modern ? (header || '').replace(/^Bearer /, '') || body.auth : body.auth;
    if (token !== 'tok') return fail('Invalid params.', 'Not authorized.');
    if (body.method === 'host.get') return reply(noHosts ? '0' : '3');
    if (body.method === 'problem.get' && noHosts) return reply(body.params.countOutput ? '0' : []);
    if (body.method === 'problem.get') return reply([{ eventid: '10', objectid: '1', name: `Problema no ${versionString}`, severity: '4', clock: '1760000000', acknowledged: '0' }]);
    if (body.method === 'trigger.get') return reply([{ triggerid: '1', hosts: [{ host: `host-${versionString}` }] }]);
    if (body.method === 'event.acknowledge') return reply({ eventids: body.params.eventids });
    fail('método inesperado');
  }).then((srv) => ({ ...srv, calls }));
}

test('Zabbix: detecta a versão e escolhe o jeito de autenticar (6.0 no corpo, 7.0 no cabeçalho)', async () => {
  zabbix._resetDetection();
  const z6 = await fakeZabbix('6.0.30');
  const z7 = await fakeZabbix('7.0.5');
  try {
    await zabbix.fetchProblems({ id: 'a', url: z6.url, token: 'tok' });
    await zabbix.fetchProblems({ id: 'b', url: z7.url, token: 'tok' });
    const p6 = z6.calls.find((c) => c.method === 'problem.get');
    const p7 = z7.calls.find((c) => c.method === 'problem.get');
    assert.equal(p6.bodyAuth, 'tok');
    assert.equal(p6.header, undefined);
    assert.equal(p7.header, 'Bearer tok');
    assert.equal(p7.bodyAuth, undefined);
  } finally {
    z6.server.close();
    z7.server.close();
  }
});

test('Zabbix: sem conseguir ler a versão, tenta o cabeçalho e cai pro corpo se for recusado', async () => {
  zabbix._resetDetection();
  const z6 = await fakeZabbix('6.0.30', { failVersion: true });
  try {
    const items = await zabbix.fetchProblems({ id: 'a', url: z6.url, token: 'tok' });
    assert.equal(items.length, 1);
    const tries = z6.calls.filter((c) => c.method === 'problem.get');
    assert.equal(tries[0].header, 'Bearer tok');
    assert.equal(tries[1].bodyAuth, 'tok');
  } finally {
    z6.server.close();
  }
});

test('Zabbix: vários servidores juntos, ids sem colisão e um fora do ar não derruba os outros', async () => {
  zabbix._resetDetection();
  const z6 = await fakeZabbix('6.0.30');
  const z7 = await fakeZabbix('7.0.5');
  try {
    const cfg = {
      minSeverity: 2,
      servers: [
        { id: 'z6', name: 'Zabbix 6', url: z6.url, token: 'tok' },
        { id: 'z7', name: 'Zabbix 7', url: z7.url, token: 'tok' },
        { id: 'off', name: 'Desligado', url: 'http://127.0.0.1:9', token: 'tok' },
        { id: 'skip', name: 'Inativo', url: z7.url, token: 'tok', enabled: false },
      ],
    };
    const { items, errors, servers } = await zabbix.fetchAll(cfg);
    assert.equal(servers, 3);
    assert.equal(items.length, 2);
    // mesmo eventid (10) nos dois servidores, ids diferentes no app
    assert.deepEqual(items.map((i) => i.id).sort(), ['zbx-z6-10', 'zbx-z7-10']);
    assert.deepEqual(items.map((i) => i.serverName).sort(), ['Zabbix 6', 'Zabbix 7']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].serverId, 'off');
    assert.match(errors[0].message, /Desligado/);
  } finally {
    z6.server.close();
    z7.server.close();
  }
});

test('Config: a configuração antiga (um Zabbix só) vira o primeiro servidor da lista', () => {
  const old = { zabbix: { enabled: true, url: 'https://z', token: 'x', legacyAuth: true, insecure: true, minSeverity: 3 } };
  const m = migrate(old);
  assert.equal(m.zabbix.enabled, true);
  assert.equal(m.zabbix.minSeverity, 3);
  assert.equal(m.zabbix.servers.length, 1);
  assert.deepEqual(
    { url: m.zabbix.servers[0].url, token: m.zabbix.servers[0].token, auth: m.zabbix.servers[0].auth, insecure: m.zabbix.servers[0].insecure },
    { url: 'https://z', token: 'x', auth: 'body', insecure: true }
  );
  assert.equal(m.zabbix.url, undefined);
  assert.equal(migrate({ zabbix: { servers: [] } }).zabbix.servers.length, 0);
});

test('Zabbix: 7.0 atrás de proxy que remove o cabeçalho Authorization cai pro token no corpo', async () => {
  zabbix._resetDetection();
  const z7 = await fakeZabbix('7.0.5', { stripHeader: true });
  try {
    const items = await zabbix.fetchProblems({ id: 'z7', name: 'Zabbix 7', url: z7.url, token: 'tok' });
    assert.equal(items.length, 1);
    await zabbix.fetchProblems({ id: 'z7', name: 'Zabbix 7', url: z7.url, token: 'tok' });
    const tries = z7.calls.filter((c) => c.method === 'problem.get');
    // 1ª rodada: cabeçalho recusado, corpo aceito; 2ª rodada já vai direto no corpo
    assert.deepEqual(tries.map((c) => (c.bodyAuth ? 'body' : 'header')), ['header', 'body', 'body']);
  } finally {
    z7.server.close();
  }
});

test('Zabbix: 7.4 (sem "auth" no corpo) funciona com o cabeçalho', async () => {
  zabbix._resetDetection();
  const z74 = await fakeZabbix('7.4.2');
  try {
    const items = await zabbix.fetchProblems({ id: 'z74', url: z74.url, token: 'tok' });
    assert.equal(items.length, 1);
    assert.equal(z74.calls.find((c) => c.method === 'problem.get').header, 'Bearer tok');
  } finally {
    z74.server.close();
  }
});

test('Zabbix: teste de conexão avisa quando o token não enxerga nenhum host', async () => {
  zabbix._resetDetection();
  const z7 = await fakeZabbix('7.0.5', { noHosts: true });
  try {
    const msg = await zabbix.test({ id: 'z7', url: z7.url, token: 'tok' });
    assert.match(msg, /7\.0\.5/);
    assert.match(msg, /não enxerga nenhum host/);
  } finally {
    z7.server.close();
  }
});

test('Zabbix: aceita URL colada da barra do navegador', () => {
  assert.equal(zabbix.normalizeApiUrl('https://zbx/zabbix.php?action=dashboard.view'), 'https://zbx/api_jsonrpc.php');
  assert.equal(zabbix.normalizeApiUrl('https://zbx/zabbix/'), 'https://zbx/zabbix/api_jsonrpc.php');
  assert.equal(zabbix.normalizeApiUrl('zbx7.local'), 'http://zbx7.local/api_jsonrpc.php');
  assert.equal(zabbix.normalizeApiUrl('https://zbx/zabbix/api_jsonrpc.php'), 'https://zbx/zabbix/api_jsonrpc.php');
});

test('Zabbix: hosts dos triggers ficam em cache (trigger.get só pra trigger novo)', async () => {
  zabbix._resetDetection();
  const z7 = await fakeZabbix('7.0.5');
  try {
    const srv = { id: 'z7', url: z7.url, token: 'tok' };
    const a = await zabbix.fetchProblems(srv);
    const b = await zabbix.fetchProblems(srv);
    assert.deepEqual(a[0].hosts, ['host-7.0.5']);
    assert.deepEqual(b[0].hosts, ['host-7.0.5']);
    assert.equal(z7.calls.filter((c) => c.method === 'problem.get').length, 2);
    assert.equal(z7.calls.filter((c) => c.method === 'trigger.get').length, 1);
  } finally {
    z7.server.close();
  }
});


test('Config: a seção "glpi" antiga vira a config do plugin glpi, com o token preservado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topwatch-'));
  const old = {
    zabbix: { enabled: true, servers: [] },
    glpi: { enabled: true, url: 'https://glpi', userToken: { enc: Buffer.from('enc:gtok').toString('base64') }, onlyMine: false },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(old));
  const glpiDef = { id: 'glpi', fields: [{ key: 'url', type: 'url' }, { key: 'userToken', type: 'secret' }, { key: 'onlyMine', type: 'checkbox', default: true }] };

  // sem o plugin instalado: a config fica guardada (criptografada) e não aparece na tela
  const without = createStore({ dir, safeStorage: fakeSafe });
  assert.equal(without.getMasked().config.plugins.glpi, undefined);
  without.save({ pollSeconds: 90 });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.glpi, undefined);
  assert.ok(disk.plugins.glpi.userToken.enc, 'token continua criptografado');

  // plugin instalado depois: lê a config migrada
  without.setPlugins([glpiDef]);
  const cfg = without.get().plugins.glpi;
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.url, 'https://glpi');
  assert.equal(cfg.userToken, 'gtok');
  assert.equal(cfg.onlyMine, false);
});

test('Config: exibição escolhendo um plugin que não existe volta pra "tudo"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topwatch-'));
  const store = createStore({ dir, safeStorage: fakeSafe, plugins: [FAKE_PLUGIN] });
  assert.equal(store.save({ ui: { display: 'tickets' } }).ui.display, 'tickets');
  assert.equal(store.save({ ui: { display: 'glpi' } }).ui.display, 'both');
});

function writePlugin(root, folder, source) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source);
  return dir;
}

const GOOD_PLUGIN = `module.exports = {
  apiVersion: 1, id: 'exemplo', name: 'Exemplo', version: '1.2.3',
  tab: { label: 'Tarefas', singular: 'tarefa', plural: 'tarefas' },
  fields: [{ key: 'url', type: 'url', label: 'URL' }, { key: 'token', type: 'secret', label: 'Token' }],
  create(ctx) { return { async fetch() { return []; }, async test() { return typeof ctx.request; } }; },
};`;

test('Plugins: carrega os válidos e ignora os quebrados sem derrubar o app', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'topwatch-plugins-'));
  writePlugin(root, 'exemplo', GOOD_PLUGIN);
  writePlugin(root, 'sem-create', `module.exports = { apiVersion: 1, id: 'x', name: 'X', tab: { label: 'X' }, fields: [] };`);
  writePlugin(root, 'versao-errada', `module.exports = { apiVersion: 99, id: 'y', name: 'Y', tab: { label: 'Y' }, fields: [], create() {} };`);
  writePlugin(root, 'quebrado', `throw new Error('bug no plugin');`);
  writePlugin(root, 'id-reservado', `module.exports = { apiVersion: 1, id: 'zabbix', name: 'Z', tab: { label: 'Z' }, fields: [], create() {} };`);
  fs.mkdirSync(path.join(root, 'pasta-vazia'));

  const { plugins, errors } = pluginKit.loadPlugins([root, path.join(root, 'nao-existe')]);
  assert.deepEqual(plugins.map((p) => p.info.id), ['exemplo']);
  assert.equal(plugins[0].info.tab.singular, 'tarefa');
  assert.equal(plugins[0].info.tab.openLabel, 'Abrir'); // padrão
  assert.equal(typeof plugins[0].info.create, 'undefined'); // a tela não recebe funções
  assert.equal(errors.length, 4);
  assert.ok(errors.some((e) => /sem create/.test(e.message)));
  assert.ok(errors.some((e) => /apiVersion 99/.test(e.message)));
  assert.ok(errors.some((e) => /bug no plugin/.test(e.message)));
  assert.ok(errors.some((e) => /id inválido/.test(e.message)));
});

test('Plugins: instalar copia a pasta pra pasta de plugins pelo id', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'topwatch-src-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'topwatch-root-'));
  const dir = writePlugin(src, 'baixado-v1', GOOD_PLUGIN);
  fs.writeFileSync(path.join(dir, 'extra.js'), '// arquivo do plugin');
  assert.equal(pluginKit.installPlugin(dir, root), 'exemplo');
  assert.ok(fs.existsSync(path.join(root, 'exemplo', 'index.js')));
  assert.ok(fs.existsSync(path.join(root, 'exemplo', 'extra.js')));
  assert.throws(() => pluginKit.installPlugin(src, root), /não tem um index\.js/);
});

test('Plugins: item do plugin é limpo antes de chegar na barra', () => {
  const mod = { id: 'exemplo' };
  const it = pluginKit.normalizeItem(mod, { id: 7, title: 'Teste', level: 9, url: 'javascript:alert(1)', since: 'ontem', extra: { x: 1 } }, 0);
  assert.equal(it.id, 'exemplo-7');
  assert.equal(it.source, 'exemplo');
  assert.equal(it.level, 5); // limitado a 0–5
  assert.equal(it.url, null); // só http/https
  assert.equal(it.since, null);
  assert.equal(it.extra, undefined);
});
