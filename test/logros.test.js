'use strict';
// LOGROS, XP Y RACHA EN EL SERVIDOR
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const express = require('express');
const { FakeFirestore } = require('./helpers/fake-firestore');
const L = require('../services/logros');

test('niveles, XP de retos antiguos y racha', () => {
  assert.equal(L.nivelDe(0).nombre, 'Estudiante');
  assert.equal(L.nivelDe(2500).nombre, 'Profesional');
  assert.deepEqual([L.nivelDe(2000).siguiente.faltan, L.nivelDe(2000).porcentaje], [500, 80]);
  assert.equal(L.nivelDe(99999).siguiente, null);
  assert.equal(L.xpDeReto('x', { xp: 33 }), 33);
  assert.equal(L.xpDeReto('x', { mejor: 9, total: 10 }), 110, 'regla de siempre: 10 por acierto + 20 si pasa el 80 %');
  assert.equal(L.xpDeReto('x', { mejor: 1, total: 0 }), 25);
  const t = new Date('2026-10-26T12:00:00Z'); // 06:00 en México → madrugador
  assert.equal(L.actualizarRacha({ ultimaVisita: '2026-10-25', racha: 4 }, t).racha, 5);
  assert.equal(L.actualizarRacha({ ultimaVisita: '2026-10-23', racha: 4 }, t).racha, 1, 'si faltó un día vuelve a 1');
  assert.equal(L.actualizarRacha({ ultimaVisita: '2026-10-26', racha: 4 }, t).cambio, false, 'una sola vez al día');
  assert.equal(L.actualizarRacha({}, t).stats.earlyBird, true);
});

test('el reto del día del servidor coincide con las preguntas y respuestas que muestra el Club', () => {
  const ctx = { window: {} }; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../../club-fisioteck/club-retos-datos.js', 'utf8'), ctx);
  const D = ctx.window.FT_RETOS;
  const claves = JSON.parse(fs.readFileSync(__dirname + '/../data/retos-claves.json', 'utf8'));
  const todas = []; D.quiz.forEach(t => t.preguntas.forEach((p, i) => todas.push({ retoId: t.id, indice: i, c: p.c })));
  for (const dia of ['2026-10-26', '2026-10-27', '2027-01-01', '2026-12-31']) {
    const n = Math.floor(new Date(dia + 'T00:00:00Z').getTime() / 86400000), cliente = todas[n % todas.length], srv = L.retoDelDia(dia, claves);
    assert.deepEqual([srv.retoId, srv.indice, srv.correcta], [cliente.retoId, cliente.indice, cliente.c], dia);
  }
});

const tokens = { socio: { uid: 's1', email: 's@mail.com', email_verified: true }, gratis: { uid: 'g1', email: 'g@mail.com', email_verified: true } };
const catalogo = { courses: [{ courseId: 1, title: 'C1', lessons: [{}, {}] }, { courseId: 2, title: 'C2', lessons: [{}] }] };
async function levantar(seed = {}, hora = '2026-10-26T18:00:00Z') {
  const db = new FakeFirestore({ 'members/s1': { status: 'active' }, 'members/g1': { status: 'registered' }, ...seed });
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const deps = { db, admin, cargarCatalogo: () => catalogo, tieneMembresia: m => m && m.status === 'active', ahora: () => new Date(hora) };
  const app = express(); app.use(express.json()); L.montarRutasLogros(app, deps);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const llamar = async (ruta, cuerpo, token = 'socio') => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, deps, cerrar: () => srv.close() };
}

test('insignias por clases y cursos terminados según el avance guardado por el servidor, y la racha cuenta una vez al día', async () => {
  const s = await levantar({ 'members/s1/progress/courses': { c_1: { completed: [0, 1] }, c_2: { completed: [0] } } });
  try {
    assert.equal((await s.llamar('/api/logros', null, null)).status, 401);
    const v = (await s.llamar('/api/logros/visita', {})).cuerpo;
    assert.equal(v.racha, 1);
    const ids = v.insignias.filter(i => i.desbloqueada).map(i => i.id).sort();
    assert.deepEqual(ids, ['first_class', 'first_course'], '3 clases y 2 cursos completos');
    assert.equal(v.xp, 200); assert.equal(v.nivel.nombre, 'Estudiante');
    assert.deepEqual(v.nuevas.sort(), ['first_class', 'first_course']);
    const otra = (await s.llamar('/api/logros/visita', {})).cuerpo;
    assert.equal(otra.racha, 1, 'visitar otra vez el mismo día no suma'); assert.deepEqual(otra.nuevas, []);
    assert.equal(s.db.value('members/s1/progress/logros').desbloqueadas.first_course.startsWith('2026-10-26'), true);
  } finally { s.cerrar(); }
});

test('los eventos cuentan una vez por id, con tope; las secciones deben ser conocidas; los PDF no se pueden inflar desde fuera', async () => {
  const s = await levantar();
  try {
    for (const id of ['home', 'library', 'courses-live', 'pdfs', 'news', 'community', 'forum']) await s.llamar('/api/logros/evento', { tipo: 'seccion', id });
    await s.llamar('/api/logros/evento', { tipo: 'seccion', id: 'inventada' });
    await s.llamar('/api/logros/evento', { tipo: 'seccion', id: 'home' });
    const e = (await s.llamar('/api/logros')).cuerpo;
    assert.equal(e.stats.secciones, 7); assert.ok(e.insignias.find(i => i.id === 'explorer').desbloqueada);
    assert.equal((await s.llamar('/api/logros/evento', { tipo: 'pdf', id: 'a' })).status, 400);
    for (let i = 0; i < 6; i++) await s.llamar('/api/logros/evento', { tipo: 'noticia', id: 'n' + i });
    await s.llamar('/api/logros/evento', { tipo: 'noticia', id: 'n1' });
    const f = (await s.llamar('/api/logros')).cuerpo;
    assert.equal(f.stats.noticias, 6); assert.ok(f.insignias.find(i => i.id === 'reader').desbloqueada);
    assert.equal((await s.llamar('/api/logros/evento', { tipo: 'webinar', id: 'w1' }, 'gratis')).status, 402, 'las clases en vivo son de miembros');
    assert.equal((await s.llamar('/api/logros/evento', { tipo: 'webinar', id: 'w1' })).status, 200);
    // el servidor cuenta los PDF al abrir el enlace
    await s.deps.registrarEventoLogro('s1', 'pdf', 'pdf-1');
    assert.equal(s.db.value('members/s1/progress/logros').stats.pdfs.length, 1);
  } finally { s.cerrar(); }
});

test('reto del día: +25 XP una sola vez al día, califica el servidor; flashcards +15 una vez al día; la cuenta sin acceso no juega', async () => {
  const s = await levantar({ 'members/s1/progress/retos': { superados: { quiz_x: { mejor: 5, total: 5, xp: 70 } } } });
  try {
    const q = (await s.llamar('/api/retos/dia')).cuerpo;
    assert.ok(q.retoId && Number.isInteger(q.indice)); assert.equal(q.hecho, false);
    const correcta = L.retoDelDia('2026-10-26').correcta;
    const mala = await s.llamar('/api/retos/dia', { respuesta: (correcta + 1) % 3 });
    assert.deepEqual([mala.cuerpo.acertada, mala.cuerpo.xp, mala.cuerpo.correcta], [false, 0, correcta]);
    const bien = await s.llamar('/api/retos/dia', { respuesta: correcta });
    assert.deepEqual([bien.cuerpo.acertada, bien.cuerpo.xp], [true, 25]);
    assert.equal((await s.llamar('/api/retos/dia', { respuesta: correcta })).cuerpo.xp, 0, 'el XP del día se gana una sola vez');
    assert.equal((await s.llamar('/api/retos/cartas', {})).cuerpo.xp, 15);
    assert.equal((await s.llamar('/api/retos/cartas', {})).cuerpo.xp, 0);
    const e = (await s.llamar('/api/logros')).cuerpo;
    assert.equal(e.xpRetos, 70 + 25 + 15, 'suma retos superados + reto del día + flashcards');
    assert.ok(s.db.value('members/s1/progress/retos').superados.quiz_x, 'los retos superados no se pisan');
    assert.equal((await s.llamar('/api/retos/dia', { respuesta: correcta }, 'gratis')).status, 402);
    assert.equal((await s.llamar('/api/retos/dia', { respuesta: 'x' })).status, 400);
  } finally { s.cerrar(); }
});

test('se conserva el historial del sistema anterior: insignias, racha y XP de retos', async () => {
  const s = await levantar({ 'members/s1/progress/achievements': { unlocked: ['streak3', 'early_bird', 'inventada'], streak: 5, lastVisit: '2026-10-25', stats: { earlyBird: true, newsRead: 2 }, retos: { xp: 300 } } });
  try {
    const v = (await s.llamar('/api/logros/visita', {})).cuerpo;
    assert.equal(v.racha, 6, 'la racha anterior sigue contando');
    const ids = v.insignias.filter(i => i.desbloqueada).map(i => i.id).sort();
    assert.deepEqual(ids, ['early_bird', 'streak3']);
    assert.equal(v.xpRetos, 300); assert.equal(v.xp, 100 + 75 + 300);
    assert.ok(s.db.value('members/s1/progress/achievements'), 'el documento anterior no se borra');
  } finally { s.cerrar(); }
});

test('premio de bienvenida: +100 XP una sola vez', async () => {
  const s = await levantar();
  try {
    const a = (await s.llamar('/api/logros/bienvenida', {})).cuerpo;
    assert.equal(a.premioNuevo, true); assert.equal(a.bienvenida, true); assert.equal(a.xp, 100);
    const b = (await s.llamar('/api/logros/bienvenida', {})).cuerpo;
    assert.equal(b.premioNuevo, false); assert.equal(b.xp, 100, 'no se suma dos veces');
    assert.equal((await s.llamar('/api/logros/bienvenida', {}, null)).status, 401);
  } finally { s.cerrar(); }
});

test('clasificación del club: solo alias, avatar, XP y retos; respeta quien se oculta; marca tu posición', async () => {
  const s = await levantar({
    'members/s1': { status: 'active', name: 'Ana Torres Ruiz', avatar: 'a05' },
    'members/g1': { status: 'registered', name: 'Gabriela', avatar: 'inventado', rankingOculto: false, email: 'g@mail.com' },
    'members/o1': { status: 'active', name: 'Oculto Perez', rankingOculto: true },
    'members/s1/progress/retos': {}, 'members/g1/progress/retos': { superados: { q1: { mejor: 5, total: 5, xp: 70 } } }, 'members/o1/progress/retos': { superados: { q1: { mejor: 5, total: 5, xp: 70 } } }
  });
  try {
    tokensExtra();
    await s.llamar('/api/logros/bienvenida', {}, 'socio');              // Ana: 100 XP
    await s.llamar('/api/logros', null, 'gratis');                       // Gabriela: 1 reto, 70 XP + insignias
    const r = (await s.llamar('/api/retos/clasificacion', null, 'socio')).cuerpo;
    assert.ok(r.total >= 2);
    const ana = r.filas.find(f => f.esTu);
    assert.equal(ana.nombre, 'Ana T.'); assert.equal(ana.avatar, 'a05');
    const gaby = r.filas.find(f => f.nombre === 'Gabriela'); assert.equal(gaby.avatar, '', 'un avatar inválido no se muestra');
    assert.equal(JSON.stringify(r).includes('@mail.com'), false);
    assert.equal(r.filas.some(f => f.nombre.startsWith('Oculto')), false);
    assert.ok(r.filas[0].xp >= r.filas[r.filas.length - 1].xp, 'ordenado de mayor a menor XP');
    assert.equal(r.tuPosicion, r.filas.findIndex(f => f.esTu) + 1);
  } finally { s.cerrar(); }
});
function tokensExtra() { /* los tokens socio y gratis ya existen en este archivo */ }

test('el XP de práctica diaria (reto del día y flashcards) tiene un tope de por vida de 600', () => {
  assert.equal(L.TOPE_XP_PRACTICA, 600);
  assert.equal(L.LEVELS[1].min, 2500, 'Profesional no se alcanza solo con retos y práctica');
  assert.equal(L.LEVELS[4].min, 6000);
});

test('insignias de comunidad: Embajador con 1 invitado válido y La manada crece con 4', () => {
  const { BADGES } = require('../services/logros');
  const emb = BADGES.find(b => b.id === 'embajador'), man = BADGES.find(b => b.id === 'manada_crece');
  assert.ok(emb && man);
  assert.equal(emb.ok({ invitadosValidos: 0 }), false); assert.equal(emb.ok({ invitadosValidos: 1 }), true);
  assert.equal(man.ok({ invitadosValidos: 3 }), false); assert.equal(man.ok({ invitadosValidos: 4 }), true);
  assert.equal(emb.xp, 60); assert.equal(man.xp, 150);
});
