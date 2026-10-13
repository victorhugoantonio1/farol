'use strict';
// Liga a barra de demonstração (iframe com o TopWatch de verdade) à página:
// - a barra pede pra "ficar clicável" quando o mouse entra -> o iframe cresce pra caber o painel;
// - a luz da barra muda -> o brilho do topo da página acompanha;
// - os botões do simulador trocam os alertas de exemplo.

(function () {
  const frame = document.getElementById('island');
  if (!frame) return;
  const origin = location.origin;
  const COLORS = { ok: 'var(--ok)', 0: '#a3abb5', 1: '#7ab8ff', 2: 'var(--warn)', 3: '#f4bb62', 4: 'var(--high)', 5: 'var(--dis)' };
  let shrinkTimer = null;

  window.addEventListener('message', (e) => {
    if (e.origin !== origin || e.source !== frame.contentWindow || !e.data || !e.data.tw) return;
    if (e.data.type === 'interactive') {
      clearTimeout(shrinkTimer);
      if (e.data.on) frame.classList.add('open');
      // espera a barra terminar de recolher antes de diminuir o iframe
      else shrinkTimer = setTimeout(() => frame.classList.remove('open'), 420);
    }
    if (e.data.type === 'level') {
      document.documentElement.style.setProperty('--glow', COLORS[e.data.level] || 'var(--ok)');
    }
  });

  // a barra pode carregar antes desta página começar a ouvir: pergunta a luz atual
  const hello = () => frame.contentWindow && frame.contentWindow.postMessage({ tw: true, type: 'hello' }, origin);
  frame.addEventListener('load', hello);
  hello();

  const buttons = document.querySelectorAll('[data-scenario]');
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      frame.contentWindow.postMessage({ tw: true, type: 'scenario', name: b.dataset.scenario }, origin);
    })
  );
})();
