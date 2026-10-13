'use strict';
// Monta o site (GitHub Pages) em _site/:
// - copia site/ (páginas, estilos, scripts);
// - copia a interface real da barra (renderer/) pra _site/demo, com dados de exemplo,
//   pra demonstração no topo do site ser o próprio TopWatch, sempre na versão atual;
// - copia as imagens de docs/ e o ícone.
// Uso: node scripts/build-site.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_site');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'site'), OUT, { recursive: true });

// barra de demonstração: os mesmos arquivos do app + o shim com dados de exemplo
for (const f of ['island.css', 'bot.js', 'island.js']) {
  fs.copyFileSync(path.join(ROOT, 'renderer', f), path.join(OUT, 'demo', f));
}
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'island.html'), 'utf8');
const marker = '<script src="bot.js"></script>';
if (!html.includes(marker)) throw new Error('island.html mudou: não achei o <script src="bot.js">');
fs.writeFileSync(path.join(OUT, 'demo', 'island.html'), html.replace(marker, `<script src="shim.js"></script>\n    ${marker}`));

for (const f of ['preview.png']) fs.copyFileSync(path.join(ROOT, 'docs', f), path.join(OUT, 'assets', f));
fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(OUT, 'assets', 'icon.png'));
// Vigia da bandeja (mesma folha de quadros do app) pra animação da barra de tarefas de mentira
fs.mkdirSync(path.join(OUT, 'assets', 'tray'), { recursive: true });
for (const f of ['sheet@2x.png', 'frames.json']) fs.copyFileSync(path.join(ROOT, 'assets', 'tray', f), path.join(OUT, 'assets', 'tray', f));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`site montado em ${path.relative(ROOT, OUT)}/`);
