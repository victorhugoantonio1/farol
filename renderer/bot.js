'use strict';
// Vigia: o robozinho do Farol. SVG com acabamento 3D suave, animado por CSS e JS.
// Humores: 'sleep' (tudo calmo), 'watch' (tem coisa), 'alarm' (Alta/Desastre), 'happy' (depois de um ack).
// Reações: segue o mouse, olha pra linha sob o cursor, escaneia sozinho, leva susto com alerta novo,
// recua quando é cutucado e dá "glitch" se cutucar demais.

let botCount = 0;

function botSvg(id) {
  return `
<svg class="bot" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <linearGradient id="${id}-shell" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#58606f"/>
      <stop offset="0.45" stop-color="#2e333d"/>
      <stop offset="1" stop-color="#16181d"/>
    </linearGradient>
    <radialGradient id="${id}-hl" cx="0.3" cy="0.15" r="0.55">
      <stop offset="0" stop-color="#fff" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}-ear" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3a404c"/>
      <stop offset="1" stop-color="#1b1e24"/>
    </linearGradient>
    <linearGradient id="${id}-glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#11141a"/>
      <stop offset="1" stop-color="#040507"/>
    </linearGradient>
    <filter id="${id}-glow" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="2.6"/></filter>
    <filter id="${id}-soft" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="1.6"/></filter>
    <clipPath id="${id}-visor"><rect x="25" y="35" width="50" height="24" rx="12"/></clipPath>
  </defs>

  <ellipse class="bot-shadow" cx="50" cy="93" rx="21" ry="3.6"/>

  <g class="bot-float">
    <g class="bot-react">
      <g class="bot-head">
        <g class="antenna">
          <path class="ant-stem" d="M50 24 L50 13"/>
          <circle class="ant-glow" cx="50" cy="10.5" r="5.5" filter="url(#${id}-glow)"/>
          <circle class="ant-tip" cx="50" cy="10.5" r="3.4"/>
        </g>

        <rect x="11" y="41" width="10" height="17" rx="5" fill="url(#${id}-ear)"/>
        <rect x="79" y="41" width="10" height="17" rx="5" fill="url(#${id}-ear)"/>

        <rect x="18" y="22" width="64" height="56" rx="24" fill="url(#${id}-shell)"/>
        <rect x="18" y="22" width="64" height="56" rx="24" fill="url(#${id}-hl)"/>
        <rect class="rim" x="18.5" y="22.5" width="63" height="55" rx="23.5"/>

        <rect x="25" y="35" width="50" height="24" rx="12" fill="url(#${id}-glass)"/>
        <g clip-path="url(#${id}-visor)">
          <rect class="scan-wash" x="25" y="35" width="50" height="24"/>
          <g class="eye">
            <rect class="eye-glow" x="41" y="39.5" width="18" height="15" rx="7.5" filter="url(#${id}-glow)"/>
            <rect class="eye-core" x="43.5" y="41.5" width="13" height="11" rx="5.5"/>
            <path class="eye-happy" d="M43 51 Q50 40.5 57 51"/>
          </g>
          <rect class="visor-shine" x="29" y="37.5" width="18" height="3.2" rx="1.6" filter="url(#${id}-soft)"/>
        </g>
        <rect class="visor-rim" x="25" y="35" width="50" height="24" rx="12"/>
      </g>
    </g>
  </g>
</svg>`;
}

function createBot(container) {
  const id = `bot${++botCount}`;
  container.innerHTML = botSvg(id); // markup fixo, nada vindo da API
  const svg = container.querySelector('svg');
  const head = svg.querySelector('.bot-head');
  const eye = svg.querySelector('.eye');

  let mood = 'watch';
  let lastLook = 0;
  let pokes = [];
  let timers = {};

  function later(name, fn, ms) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(fn, ms);
  }

  function flash(cls, ms) {
    svg.classList.remove(cls);
    void svg.getBoundingClientRect(); // reinicia a animação
    svg.classList.add(cls);
    later(cls, () => svg.classList.remove(cls), ms);
  }

  // dx, dy de -1 a 1: pra onde o olho e a cabeça apontam
  function pose(dx, dy) {
    dx = Math.max(-1, Math.min(1, dx));
    dy = Math.max(-1, Math.min(1, dy));
    eye.style.transform = `translate(${(dx * 13).toFixed(2)}px, ${(dy * 4.5).toFixed(2)}px)`;
    head.style.transform = `translate(${(dx * 2.5).toFixed(2)}px, ${(dy * 1.6).toFixed(2)}px) rotate(${(dx * 7).toFixed(2)}deg)`;
  }

  function lookAt(x, y) {
    if (mood === 'sleep') return;
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.47;
    lastLook = Date.now();
    pose((x - cx) / (r.width * 3), (y - cy) / (r.height * 2));
  }

  // descanso: de olho na lista, logo abaixo e um pouco à direita
  function lookDown() {
    if (mood === 'sleep') return;
    pose(0.2, 0.85);
  }

  function blink() {
    if (mood === 'sleep') return;
    flash('blink', 130);
  }

  // escaneia sozinho de vez em quando, se ninguém está mexendo
  function idleLoop() {
    later(
      'idle',
      () => {
        const quiet = Date.now() - lastLook > 2500;
        if (quiet && mood !== 'sleep') {
          const r = Math.random();
          if (r < 0.45) {
            pose(-0.9, 0.3);
            later('scan1', () => pose(0.9, 0.3), 520);
            later('scan2', lookDown, 1100);
          } else if (r < 0.75) {
            blink();
            if (Math.random() < 0.3) later('blink2', blink, 240);
          } else {
            pose(Math.random() * 1.6 - 0.8, Math.random() * 0.8);
            later('back', lookDown, 900);
          }
        }
        idleLoop();
      },
      2200 + Math.random() * 3000
    );
  }

  function setMood(next) {
    const changed = next !== mood;
    mood = next;
    if (timers.happy) return; // termina a comemoração e depois aplica
    svg.dataset.mood = next;
    if (next === 'sleep') pose(0, 0.4);
    else if (changed) lookDown();
  }

  // alerta novo: susto + antena balançando
  function jolt() {
    flash('jolt', 520);
    flash('wobble', 900);
  }

  function celebrate() {
    svg.dataset.mood = 'happy';
    flash('nod', 900);
    later(
      'happy',
      () => {
        timers.happy = null;
        svg.dataset.mood = mood;
        lookDown();
      },
      1400
    );
  }

  // cutucar: recua; três cutucadas rápidas = glitch
  svg.addEventListener('click', (e) => {
    e.stopPropagation();
    const now = Date.now();
    pokes = pokes.filter((t) => now - t < 1200).concat(now);
    if (mood === 'sleep') {
      // acorda rapidinho e volta a dormir
      svg.dataset.mood = 'watch';
      lookDown();
      later('resleep', () => setMood('sleep'), 1400);
    }
    if (pokes.length >= 3) {
      pokes = [];
      flash('glitch', 1100);
    } else {
      flash('poke', 420);
    }
    flash('wobble', 900);
  });

  svg.dataset.mood = mood;
  lookDown();
  idleLoop();

  return { el: svg, setMood, lookAt, lookDown, blink, jolt, celebrate, pose };
}

window.createBot = createBot;
