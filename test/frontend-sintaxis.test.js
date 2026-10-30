'use strict';
// Si el Club (carpeta hermana club-fisioteck) está junto al servidor, todos sus archivos .js deben tener sintaxis válida
// y cada <script src> local del index debe existir. Si no está (por ejemplo en Railway), la prueba se omite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const club = path.join(__dirname, '..', '..', 'club-fisioteck');
const hay = fs.existsSync(path.join(club, 'index.html'));

test('el Club: todos los .js tienen sintaxis válida', { skip: !hay && 'no está la carpeta club-fisioteck' }, () => {
  const archivos = [...fs.readdirSync(club).filter(f => f.endsWith('.js')).map(f => path.join(club, f)), ...fs.readdirSync(path.join(club, 'admin')).filter(f => f.endsWith('.js')).map(f => path.join(club, 'admin', f))];
  assert.ok(archivos.length > 20);
  const malos = [];
  archivos.forEach(f => { try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); } catch (e) { malos.push(path.basename(f) + ': ' + e.message); } });
  assert.deepEqual(malos, []);
});

test('el Club: cada script local que carga index.html y admin/index.html existe', { skip: !hay && 'no está la carpeta club-fisioteck' }, () => {
  const faltan = [];
  [['index.html', club], ['admin/index.html', path.join(club, 'admin')]].forEach(([html, base]) => {
    const t = fs.readFileSync(path.join(club, html), 'utf8');
    for (const m of t.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      const src = m[1].split('?')[0]; if (/^https?:/.test(src)) continue;
      if (!fs.existsSync(path.join(base, src))) faltan.push(html + ' -> ' + src);
    }
  });
  assert.deepEqual(faltan, []);
});
