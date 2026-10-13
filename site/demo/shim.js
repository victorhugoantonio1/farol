'use strict';
// Faz a barra do TopWatch rodar dentro do site: no lugar do processo principal do app,
// entrega dados de exemplo e conversa com a página pelo postMessage.
(function () {
  const SEV = ['Não classificado', 'Informação', 'Atenção', 'Média', 'Alta', 'Desastre'];
  const MIN = 60 * 1000;
  const PROBLEMS = [
    { title: 'Servidor sem resposta ao ICMP', host: 'srv-app02', severity: 5, ago: 4 },
    { title: 'Espaço em disco C: abaixo de 10%', host: 'srv-db01', severity: 4, ago: 38 },
    { title: 'Uso de CPU acima de 90% há 15 min', host: 'srv-rds03', severity: 3, ago: 22 },
    { title: 'Serviço "Spooler" parado', host: 'srv-print01', severity: 2, ago: 95 },
    { title: 'Certificado SSL expira em 14 dias', host: 'web-portal', severity: 2, ago: 600 },
  ];
  // cada cenário é um filtro sobre os problemas de exemplo
  const SCENARIOS = {
    calm: () => false,
    medium: (p) => p.severity <= 3,
    disaster: () => true,
  };

  let scenario = 'disaster';
  const acked = new Set();
  let onState = null;
  let onAlert = null;
  const origin = location.origin;
  const tell = (msg) => parent.postMessage({ tw: true, ...msg }, origin);

  function snapshot() {
    const now = Date.now();
    const items = PROBLEMS.map((p, i) => ({ ...p, i }))
      .filter(SCENARIOS[scenario])
      .map((p) => ({
        id: `demo-${p.i}`,
        eventid: `demo-${p.i}`,
        serverId: 'zabbix',
        serverName: 'Zabbix',
        source: 'zabbix',
        title: p.title,
        severity: p.severity,
        severityLabel: SEV[p.severity],
        hosts: [p.host],
        since: now - p.ago * MIN,
        acknowledged: acked.has(`demo-${p.i}`),
        url: null,
      }));
    return {
      demo: false,
      updatedAt: now,
      zabbix: { enabled: true, items, error: null, multi: false },
      plugins: [],
      ui: { display: 'both', highlight: true, mascot: true },
    };
  }

  function level(s) {
    const open = s.zabbix.items.filter((p) => !p.acknowledged);
    return open.length ? String(Math.max(...open.map((p) => p.severity))) : 'ok';
  }

  function push() {
    const s = snapshot();
    if (onState) onState(s);
    tell({ type: 'level', level: level(s) });
  }

  window.topwatch = {
    setInteractive: (on) => tell({ type: 'interactive', on: !!on }),
    getState: async () => {
      const s = snapshot();
      tell({ type: 'level', level: level(s) });
      return s;
    },
    refresh: () => push(),
    openSettings() {},
    unpin() {},
    openUrl() {},
    acknowledge: async (id) => {
      acked.add(id);
      setTimeout(push, 250);
      return { ok: true };
    },
    onState: (fn) => (onState = fn),
    onPinned() {},
    onAlert: (fn) => (onAlert = fn),
  };

  window.addEventListener('message', (e) => {
    if (e.origin !== origin || e.source !== parent || !e.data || !e.data.tw) return;
    if (e.data.type === 'hello') tell({ type: 'level', level: level(snapshot()) });
    // abre a barra sozinha por um tempo (a apresentação do site); se a pessoa
    // estiver com o mouse em cima quando acabar, deixa aberta
    if (e.data.type === 'peek') {
      const island = document.getElementById('island');
      island.classList.add('expanded');
      setTimeout(() => {
        if (!island.matches(':hover')) island.classList.remove('expanded');
      }, Number(e.data.ms) || 4000);
    }
    if (e.data.type === 'scenario' && SCENARIOS[e.data.name]) {
      scenario = e.data.name;
      acked.clear();
      push();
      if (scenario === 'disaster' && onAlert) onAlert(); // o Vigia leva o susto
    }
  });
})();
