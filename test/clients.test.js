'use strict';
// Testa os clientes contra servidores falsos que imitam o Zabbix e o GLPI.
// Rode com: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const zabbix = require('../src/zabbix');
const { createGlpiClient } = require('../src/glpi');
const { createStore } = require('../src/config');

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
    const items = await zabbix.fetchProblems({ url: `${url}/zabbix`, token: 'abc', minSeverity: 3 });
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
    await zabbix.fetchProblems({ url: `${url}/api_jsonrpc.php`, token: 'old', legacyAuth: true });
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
    await assert.rejects(zabbix.fetchProblems({ url, token: 'x' }), /Invalid params\. \(Not authorized\.\)/);
  } finally {
    server.close();
  }
});

test('GLPI: abre sessão, busca chamados e refaz login quando a sessão expira', async () => {
  let sessions = 0;
  let searches = 0;
  let lastQuery;
  const { server, url } = await serve((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/glpi/apirest.php/initSession') {
      assert.equal(req.headers.authorization, 'user_token tok');
      assert.equal(req.headers['app-token'], 'app');
      sessions++;
      return json(res, 200, { session_token: `s${sessions}` });
    }
    if (u.pathname === '/glpi/apirest.php/search/Ticket') {
      searches++;
      lastQuery = u.searchParams;
      if (req.headers['session-token'] === 's1' && searches === 2) {
        return json(res, 401, ['ERROR_SESSION_TOKEN_INVALID', 'sessão inválida']);
      }
      return json(res, 206, {
        totalcount: 1,
        data: [{ 1: 'VPN não conecta', 2: 4821, 3: 4, 12: 2, 15: '2026-10-11 09:00:00', 19: '2026-10-11 10:30:00' }],
      });
    }
    json(res, 404, ['ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM', '']);
  });

  try {
    const glpi = createGlpiClient();
    const cfg = { url: `${url}/glpi/`, userToken: 'tok', appToken: 'app', onlyMine: true };

    const first = await glpi.fetchTickets(cfg);
    assert.equal(first.length, 1);
    assert.equal(first[0].number, 4821);
    assert.equal(first[0].statusLabel, 'Em atendimento');
    assert.equal(first[0].priorityLabel, 'Alta');
    assert.equal(first[0].url, `${url}/glpi/front/ticket.form.php?id=4821`);
    assert.equal(lastQuery.get('criteria[0][value]'), 'notold');
    assert.equal(lastQuery.get('criteria[1][value]'), 'myself');

    // segunda busca: servidor diz 401, cliente faz login de novo e tenta outra vez
    const second = await glpi.fetchTickets(cfg);
    assert.equal(second.length, 1);
    assert.equal(sessions, 2);
  } finally {
    server.close();
  }
});

test('GLPI: erro de login mostra o motivo que o GLPI mandou', async () => {
  const { server, url } = await serve((req, res) => {
    json(res, 400, ['ERROR_GLPI_LOGIN_USER_TOKEN', 'parâmetro user_token parece estar incorreto']);
  });
  try {
    await assert.rejects(createGlpiClient().fetchTickets({ url, userToken: 'x' }), /ERROR_GLPI_LOGIN_USER_TOKEN/);
  } finally {
    server.close();
  }
});

test('Config: segredos são criptografados no disco e não voltam pra tela', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-'));
  // safeStorage falso (no app de verdade é o DPAPI do Windows)
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ''),
  };
  const store = createStore({ dir, safeStorage: fakeSafe });
  store.save({ zabbix: { url: 'https://z', token: 'segredo' } });

  const onDisk = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!onDisk.includes('"segredo"'));

  const masked = store.getMasked();
  assert.equal(masked.config.zabbix.token, '');
  assert.equal(masked.hasSecret['zabbix.token'], true);

  // salvar com o campo vazio mantém o token
  store.save({ zabbix: { url: 'https://z2', token: '' } });
  const reopened = createStore({ dir, safeStorage: fakeSafe });
  assert.equal(reopened.get().zabbix.token, 'segredo');
  assert.equal(reopened.get().zabbix.url, 'https://z2');
});

test('Zabbix: Reconhecer chama event.acknowledge com action 2', async () => {
  let seen;
  const { server, url } = await serve((req, res, raw) => {
    const body = JSON.parse(raw);
    seen = body;
    json(res, 200, { jsonrpc: '2.0', id: body.id, result: { eventids: body.params.eventids } });
  });
  try {
    await zabbix.acknowledge({ url, token: 't' }, '901');
    assert.equal(seen.method, 'event.acknowledge');
    assert.deepEqual(seen.params, { eventids: ['901'], action: 2 });
  } finally {
    server.close();
  }
});
