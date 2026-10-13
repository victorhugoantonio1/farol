'use strict';
// Dados de mentira pra ver o app funcionando sem configurar nada.

const { SEVERITY_LABELS } = require('./zabbix');

const MIN = 60 * 1000;

const PROBLEMS = [
  { title: 'Servidor sem resposta ao ICMP', host: 'srv-app02', severity: 5, ago: 4, srv: 'Zabbix 7' },
  { title: 'Espaço em disco C: abaixo de 10%', host: 'srv-db01', severity: 4, ago: 38, srv: 'Zabbix 6' },
  { title: 'Link principal com perda de pacotes > 20%', host: 'fw-matriz', severity: 4, ago: 12, ack: true, srv: 'Zabbix 6' },
  { title: 'Uso de CPU acima de 90% há 15 min', host: 'srv-rds03', severity: 3, ago: 22 },
  { title: 'Serviço "Spooler" parado', host: 'srv-print01', severity: 2, ago: 95, srv: 'Zabbix 6' },
  { title: 'Certificado SSL expira em 14 dias', host: 'web-portal', severity: 2, ago: 600 },
];

let tick = 0;
const acked = new Set();

function acknowledge(eventid) {
  acked.add(String(eventid));
}

function snapshot() {
  const now = Date.now();
  tick++;
  // De vez em quando "resolve" o primeiro alerta, pra ver a luz mudar de cor.
  const problems = PROBLEMS.map((p, i) => ({
    id: `zbx-demo-${i}`,
    eventid: `demo-${i}`,
    serverId: p.srv === 'Zabbix 6' ? 'demo6' : 'demo7',
    serverName: p.srv || 'Zabbix 7',
    source: 'zabbix',
    title: p.title,
    severity: p.severity,
    severityLabel: SEVERITY_LABELS[p.severity],
    hosts: [p.host],
    since: now - p.ago * MIN,
    acknowledged: !!p.ack || acked.has(`demo-${i}`),
    url: 'https://www.zabbix.com/documentation/current/en/manual/api',
  })).filter((p) => !(p.eventid === 'demo-0' && tick % 4 === 0));
  return { problems };
}

module.exports = { snapshot, acknowledge };
