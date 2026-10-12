'use strict';
// Dados de mentira pra ver o app funcionando sem configurar nada.

const { SEVERITY_LABELS } = require('./zabbix');
const { STATUS, PRIORITY } = require('./glpi');

const MIN = 60 * 1000;

const PROBLEMS = [
  { title: 'Servidor sem resposta ao ICMP', host: 'srv-app02', severity: 5, ago: 4 },
  { title: 'Espaço em disco C: abaixo de 10%', host: 'srv-db01', severity: 4, ago: 38 },
  { title: 'Link principal com perda de pacotes > 20%', host: 'fw-matriz', severity: 4, ago: 12, ack: true },
  { title: 'Uso de CPU acima de 90% há 15 min', host: 'srv-rds03', severity: 3, ago: 22 },
  { title: 'Serviço "Spooler" parado', host: 'srv-print01', severity: 2, ago: 95 },
  { title: 'Certificado SSL expira em 14 dias', host: 'web-portal', severity: 2, ago: 600 },
];

const TICKETS = [
  { n: 4821, title: 'Usuário sem acesso à VPN após troca de senha', status: 2, priority: 4, ago: 25 },
  { n: 4817, title: 'Impressora do financeiro não imprime', status: 1, priority: 3, ago: 70 },
  { n: 4803, title: 'Criar caixa compartilhada para o RH', status: 4, priority: 2, ago: 300 },
  { n: 4790, title: 'Lentidão no ERP às segundas de manhã', status: 2, priority: 5, ago: 1440 },
];

let tick = 0;
const acked = new Set();

function acknowledge(eventid) {
  acked.add(String(eventid));
}

function snapshot() {
  const now = Date.now();
  tick++;
  // De vez em quando "resolve" o primeiro alerta, pra ver o farol mudar de cor.
  const problems = PROBLEMS.map((p, i) => ({
    id: `zbx-demo-${i}`,
    eventid: `demo-${i}`,
    source: 'zabbix',
    title: p.title,
    severity: p.severity,
    severityLabel: SEVERITY_LABELS[p.severity],
    hosts: [p.host],
    since: now - p.ago * MIN,
    acknowledged: !!p.ack || acked.has(`demo-${i}`),
    url: 'https://www.zabbix.com/documentation/current/en/manual/api',
  })).filter((p) => !(p.eventid === 'demo-0' && tick % 4 === 0));
  const tickets = TICKETS.map((t) => ({
    id: `glpi-demo-${t.n}`,
    source: 'glpi',
    number: String(t.n),
    title: t.title,
    status: t.status,
    statusLabel: STATUS[t.status],
    priority: t.priority,
    priorityLabel: PRIORITY[t.priority],
    since: now - t.ago * MIN,
    updated: now - Math.round(t.ago / 3) * MIN,
    url: 'https://glpi-project.org',
  }));
  return { problems, tickets };
}

module.exports = { snapshot, acknowledge };
