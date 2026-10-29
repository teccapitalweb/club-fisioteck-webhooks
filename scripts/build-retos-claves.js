// Genera data/retos-claves.json (solo respuestas correctas) a partir del contenido de retos del Club.
// Uso: node scripts/build-retos-claves.js ../club-fisioteck/club-retos-datos.js
const fs = require('fs');
const path = require('path');
const origen = path.resolve(process.argv[2] || '../club-fisioteck/club-retos-datos.js');
const ctx = { window: {} };
new Function('window', fs.readFileSync(origen, 'utf8'))(ctx.window);
const D = ctx.window.FT_RETOS;
if (!D) throw new Error('No se encontró FT_RETOS en ' + origen);
const claves = { quiz: {}, orden: {} };
D.quiz.forEach(q => { claves.quiz[q.id] = q.preguntas.map(p => p.c); });
D.orden.forEach(o => { claves.orden[o.id] = o.pasos.length; });
fs.writeFileSync(path.join(__dirname, '..', 'data', 'retos-claves.json'), JSON.stringify(claves, null, 2) + '\n');
console.log('Retos:', Object.keys(claves.quiz).length, 'quiz,', Object.keys(claves.orden).length, 'orden');
