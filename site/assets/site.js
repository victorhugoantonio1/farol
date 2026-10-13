'use strict';
// Liga a barra de demonstração (iframe com o TopWatch de verdade) à página:
// - a luz da barra muda -> o brilho da "tela" e a luz do logo acompanham;
// - o Vigia da barra de tarefas usa a mesma folha de quadros do app;
// - os botões trocam o cenário; ao abrir a página, chega um Desastre e a barra abre sozinha uma vez.

(function () {
  const frame = document.getElementById('island');
  if (!frame) return;
  const origin = location.origin;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLORS = { ok: 'var(--ok)', 0: '#a3abb5', 1: '#7ab8ff', 2: 'var(--warn)', 3: '#f4bb62', 4: 'var(--high)', 5: 'var(--dis)' };
  const send = (msg) => frame.contentWindow && frame.contentWindow.postMessage({ tw: true, ...msg }, origin);
  let level = '5';

  // ---- barra cabe na tela de mentira em qualquer largura ----
  const slot = frame.parentElement;
  function fit() {
    const s = Math.min(1, slot.clientWidth / 640);
    frame.style.transform = s < 1 ? `scale(${s})` : '';
  }
  addEventListener('resize', fit);
  fit();

  // ---- mensagens da barra ----
  addEventListener('message', (e) => {
    if (e.origin !== origin || e.source !== frame.contentWindow || !e.data || !e.data.tw) return;
    if (e.data.type === 'level') {
      level = e.data.level;
      document.documentElement.style.setProperty('--glow', COLORS[level] || 'var(--ok)');
      tray.setLevel(level);
    }
  });

  // ---- simulador ----
  const buttons = document.querySelectorAll('[data-scenario]');
  function choose(name, { peek = false } = {}) {
    buttons.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.scenario === name)));
    send({ type: 'scenario', name });
    if (peek) send({ type: 'peek', ms: 4200 });
  }
  buttons.forEach((b) => b.addEventListener('click', () => choose(b.dataset.scenario)));

  // ao carregar: começa calmo e, um instante depois, chega um Desastre (uma vez só)
  let started = false;
  function start() {
    if (started) return;
    started = true;
    if (reduced) return send({ type: 'hello' });
    choose('calm');
    setTimeout(() => choose('disaster', { peek: true }), 1800);
  }
  // a barra pode ter terminado de carregar antes deste script
  const ready = () => {
    try {
      return frame.contentWindow.topwatch && frame.contentDocument.readyState === 'complete';
    } catch {
      return false;
    }
  };
  if (ready()) start();
  else frame.addEventListener('load', start);

  // ---- Vigia da bandeja (mesma lógica do app, em CSS) ----
  const tray = (function () {
    const el = document.getElementById('tray-vigia');
    const noop = { setLevel() {} };
    if (!el) return noop;
    let meta = null;
    let lv = '5';
    let queue = [];
    const TICK = 60;
    const hold = (f, ms) => Array(Math.max(1, Math.round(ms / TICK))).fill(f);
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const slide = (a, b, ms) => {
      const n = Math.max(1, Math.round(ms / TICK));
      return Array.from({ length: n }, (_, i) => `x${Math.round(a + (b - a) * ease((i + 1) / n))}`);
    };
    const BLINK = ['b1', 'b2', 'b3', 'b3', 'b2', 'b1'];
    const calm = () => {
      const s = Math.random() < 0.5 ? -5 : 5;
      return [...hold('x0', 700), ...slide(0, s, 420), ...hold(`x${s}`, 650), ...slide(s, -s, 760), ...hold(`x${-s}`, 650), ...slide(-s, 0, 420), ...hold('x0', 300), ...BLINK, ...hold('x0', 900)];
    };
    const pulse = () => {
      const step = lv === '5' ? 100 : 170;
      const breath = ['x0', 'p1', 'p2', 'p3', 'p4', 'p4', 'p3', 'p2', 'p1', 'x0'].flatMap((f) => hold(f, step));
      return [...breath, ...hold('x0', step * 2), ...breath, ...hold('x0', step), ...BLINK];
    };
    function draw(frameName) {
      if (!meta) return;
      const col = Math.max(0, meta.frames.indexOf(frameName));
      const row = Math.max(0, meta.levels.indexOf(lv));
      el.style.backgroundPosition = `${-col * 20}px ${-row * 20}px`;
    }
    fetch('assets/tray/frames.json')
      .then((r) => r.json())
      .then((m) => {
        meta = m;
        el.style.setProperty('--cols', m.frames.length);
        el.style.setProperty('--rows', m.levels.length);
        draw('x0');
        if (reduced) return;
        setInterval(() => {
          if (!queue.length) queue = lv === '4' || lv === '5' ? pulse() : calm();
          draw(queue.shift());
        }, TICK);
      })
      .catch(() => {});
    return {
      setLevel(next) {
        if (next === lv) return;
        const wasPulse = lv === '4' || lv === '5';
        lv = next;
        if (wasPulse !== (lv === '4' || lv === '5')) queue = [];
        draw('x0');
      },
    };
  })();
})();
