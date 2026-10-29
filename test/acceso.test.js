const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { calcularAcceso, calificarQuiz, calificarOrden, montarRutasAcceso, configEscalonado } = require('../services/acceso');
const { montarRutasProgreso } = require('../services/progreso');

const catalogo = { courses: [1, 2, 3, 4].map(id => ({ courseId: id, title: 'C' + id, lessons: [{ isPreview: true }, {}, {}] })) };
const dia = n => new Date(Date.UTC(2026, 9, 1) + n * 864e5);
const cfg = { escalonadoActivo: true, escalonadoDias: 8, retosParaAdelantar: 12 };
const hechos = (q, o, d, h) => Object.fromEntries([...Array(q).keys()].map(i => ['q-' + i, {}]).concat([...Array(o).keys()].map(i => ['o-' + i, {}]), [...Array(d).keys()].map(i => ['d-' + i, {}]), [...Array(h).keys()].map(i => ['h-' + i, {}])));
const socio = (extra = {}) => ({ status: 'active', startDate: '2026-10-01', payments: [{ date: '2026-10-01', amount: 249 }], ...extra });
const abiertos = a => Object.entries(a.cursos).filter(([, v]) => v.abierto).map(([k]) => Number(k));

test('apagado, admin o socio antiguo (pagó antes de encenderlo): todo abierto, tal cual lo tenía', () => {
  assert.equal(calcularAcceso({ miembro: socio(), catalogo, cfg: {}, ahora: dia(0) }).escalonado, false);
  assert.equal(calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(0), esAdmin: true }).escalonado, false);
  const viejo = calcularAcceso({ miembro: socio(), catalogo, cfg: { ...cfg, escalonadoDesde: '2026-11-01' }, ahora: dia(0) });
  assert.equal(viejo.escalonado, false);
  assert.equal(abiertos(viejo).length, 4);
});

test('solo si el administrador marca "aplicar a antiguos" la regla les toca; cuentan desde su primer pago', () => {
  const m = socio();
  const cfgTodos = { ...cfg, escalonadoDesde: '2026-11-01', escalonadoParaTodos: true };
  const dia0 = calcularAcceso({ miembro: m, catalogo, cfg: cfgTodos, ahora: dia(0) });
  assert.equal(dia0.escalonado, true); assert.deepEqual(abiertos(dia0), [abiertos(dia0)[0]]);
  const dia17 = calcularAcceso({ miembro: m, catalogo, cfg: cfgTodos, ahora: dia(17) });
  assert.equal(abiertos(dia17).length, 3); // 1 + floor(17 / 8)
  assert.equal(dia17.diaMembresia, 18); assert.ok(typeof dia17.inicio === 'string');
});

test('lo que el miembro ya empezó a ver se conserva abierto aunque todavía no le toque', () => {
  const sinProgreso = calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(0) });
  const cerrado = Object.keys(sinProgreso.cursos).find(id => !sinProgreso.cursos[id].abierto);
  const con = calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(0), iniciados: [cerrado] });
  assert.equal(con.cursos[cerrado].abierto, true); assert.equal(con.cursos[cerrado].iniciado, true);
  const otros = Object.keys(con.cursos).filter(id => id !== cerrado && !sinProgreso.cursos[id].abierto);
  assert.ok(otros.every(id => con.cursos[id].abierto === false), 'solo se conserva lo iniciado');
});

test('el calendario empieza cuando el miembro PAGA, no cuando creó su cuenta', () => {
  const cfgNuevo = { ...cfg, escalonadoDesde: '2026-09-01' };
  const m = { status: 'active', startDate: '2026-08-01', payments: [{ date: '2026-10-10', amount: 249 }] }; // cuenta de agosto, pagó el 10 de octubre
  const a = calcularAcceso({ miembro: m, catalogo, cfg: cfgNuevo, ahora: new Date(Date.UTC(2026, 9, 11)) }); // un día después de pagar
  assert.equal(a.escalonado, true); assert.equal(a.diaMembresia, 2); assert.equal(abiertos(a).length, 1);
  const sinPagos = calcularAcceso({ miembro: { status: 'active', startDate: '2026-08-01', activadoEn: '2026-10-10' }, catalogo, cfg: cfgNuevo, ahora: new Date(Date.UTC(2026, 9, 11)) });
  assert.equal(sinPagos.diaMembresia, 2, 'sin pagos cuenta desde la activación, no desde el alta');
});

test('una cuenta sin membresía no entra al escalonado', () => {
  const a = calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(0), conMembresia: false });
  assert.equal(a.escalonado, false);
  assert.equal(abiertos(a).length, 4);
});

test('el primer día solo está abierto el primer curso; cada 8 días se abre otro', () => {
  assert.deepEqual(abiertos(calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(0) })), [1]);
  assert.deepEqual(abiertos(calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(7) })), [1]);
  assert.deepEqual(abiertos(calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(8) })), [1, 2]);
  assert.deepEqual(abiertos(calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(17) })), [1, 2, 3]);
  assert.equal(abiertos(calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(400) })).length, 4);
});

test('el curso elegido en la prueba es el primero abierto', () => {
  const a = calcularAcceso({ miembro: socio({ trialCourseId: 3 }), catalogo, cfg, ahora: dia(0) });
  assert.deepEqual(abiertos(a), [3]);
  assert.equal(a.cursos[1].abierto, false);
  assert.equal(a.cursos[1].dias, 8);
});

test('el adelanto por retos pide 12 retos variados y abre UN curso, una sola vez', () => {
  const sin = calcularAcceso({ miembro: socio(), catalogo, cfg, retosSuperados: 11, retosHechos: hechos(3, 3, 3, 2), ahora: dia(0) });
  assert.deepEqual(abiertos(sin), [1]);
  assert.equal(sin.adelanto.estado, 'disponible'); assert.equal(sin.adelanto.ok, false); assert.equal(sin.retosParaSiguiente, 1);
  // 12 retos pero todos del mismo tipo: falta variedad (mínimo 2 de cada tipo)
  assert.equal(calcularAcceso({ miembro: socio(), catalogo, cfg, retosSuperados: 12, retosHechos: hechos(5, 4, 3, 0), ahora: dia(0) }).adelanto.ok, false);
  const listo = calcularAcceso({ miembro: socio(), catalogo, cfg, retosSuperados: 12, retosHechos: hechos(3, 3, 3, 3), ahora: dia(0) });
  assert.equal(listo.adelanto.ok, true); assert.equal(listo.adelanto.cursoId, '2');
  // ya guardado: se abre ese curso y el siguiente conserva su fecha (no se corre el calendario)
  const usado = calcularAcceso({ miembro: socio(), catalogo, cfg, retosSuperados: 17, retosHechos: hechos(5, 4, 4, 4), adelantoRetos: '2', ahora: dia(0) });
  assert.deepEqual(abiertos(usado), [1, 2]); assert.equal(usado.cursos[2].porRetos, true);
  assert.equal(usado.cursos[3].dias, 16); assert.equal(usado.adelanto.estado, 'usado'); assert.equal(usado.retosParaSiguiente, null);
});

test('la configuración se limita a valores razonables', () => {
  assert.equal(configEscalonado({ escalonadoDias: 999 }).dias, 60);
  assert.equal(configEscalonado({}).dias, 8);
  assert.equal(configEscalonado({ retosParaAdelantar: 0 }).retosParaAdelantar, 12);
  assert.equal(configEscalonado({ retosParaAdelantar: 1 }).retosParaAdelantar, 4);
});

test('califica quiz (60 %) y orden', () => {
  assert.equal(calificarQuiz([0, 1, 2, 1, 0], { 0: 0, 1: 1, 2: 2, 3: 0, 4: 0 }).supera, true);
  assert.equal(calificarQuiz([0, 1, 2, 1, 0], { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }).supera, false);
  assert.equal(calificarOrden(3, [0, 1, 2]), true);
  assert.equal(calificarOrden(3, [1, 0, 2]), false);
});

// ---- Rutas ----
function fakeDb(semilla) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); },
    collection: n => ({ doc: id => ref(ruta + '/' + n + '/' + id) })
  });
  return { collection: n => ({ doc: id => ref(n + '/' + id) }), datos };
}
async function levantar(semilla) {
  const db = fakeDb(semilla);
  const tokens = { socio: { uid: 'u1', email: 's@mail.com', email_verified: true } };
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const deps = { db, admin, cargarCatalogo: () => catalogo, tieneMembresia: m => m.status === 'active' };
  const app = express();
  app.use(express.json());
  montarRutasAcceso(app, deps);
  montarRutasProgreso(app, deps);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, token = 'socio') => {
    const r = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json() };
  };
  return { llamar, db, cerrar: () => srv.close() };
}
const hoyISO = new Date().toISOString().split('T')[0];
const base = () => ({ 'members/u1': { status: 'active', payments: [{ date: hoyISO }] }, 'config/club': { escalonadoActivo: true } });
const claves = require('../data/retos-claves.json');
const respuestasOk = id => Object.fromEntries(claves.quiz[id].map((c, i) => [i, c]));

test('GET /api/acceso muestra los cursos cerrados con los días que faltan', async () => {
  const s = await levantar(base());
  try {
    const r = await s.llamar('/api/acceso');
    assert.equal(r.cuerpo.escalonado, true);
    assert.equal(r.cuerpo.cursos['2'].abierto, false);
    assert.ok(r.cuerpo.cursos['2'].dias >= 7);
  } finally { s.cerrar(); }
});

test('el avance de un curso cerrado se rechaza y el de uno abierto se guarda', async () => {
  const s = await levantar(base());
  try {
    assert.equal((await s.llamar('/api/cursos/2/progreso', { leccion: 1 })).status, 403);
    assert.equal((await s.llamar('/api/cursos/1/progreso', { leccion: 0 })).status, 200);
  } finally { s.cerrar(); }
});

test('superar 12 retos abre el curso 2 una sola vez y no corre el calendario', async () => {
  const s = await levantar(base());
  try {
    const bien = { quiz: id => respuestasOk(id) };
    const lista = [];
    Object.keys(claves.quiz).slice(0, 3).forEach(id => lista.push({ retoId: id, tipo: 'quiz', respuestas: respuestasOk(id) }));
    Object.keys(claves.orden).slice(0, 3).forEach(id => lista.push({ retoId: id, tipo: 'orden', orden: [...Array(claves.orden[id]).keys()] }));
    Object.keys(claves.detective).slice(0, 3).forEach(id => lista.push({ retoId: id, tipo: 'detective', marcas: claves.detective[id].map(e => ({ x: e.x, y: e.y })) }));
    Object.keys(claves.historia).slice(0, 3).forEach(id => lista.push({ retoId: id, tipo: 'historia', respuestas: Object.fromEntries(claves.historia[id].map((c, i) => [i, c])) }));
    void bien;
    for (const [k, cuerpo] of lista.entries()) {
      const r = await s.llamar('/api/retos/completar', cuerpo);
      assert.equal(r.cuerpo.supera, true, cuerpo.retoId); assert.equal(r.cuerpo.nuevo, true);
      const ac = (await s.llamar('/api/acceso')).cuerpo;
      assert.equal(ac.cursos['2'].abierto, k === lista.length - 1, 'el curso 2 se abre solo con el reto número 12');
    }
    const ac = (await s.llamar('/api/acceso')).cuerpo;
    assert.equal(ac.adelantos, 1); assert.equal(ac.cursos['2'].porRetos, true);
    assert.equal(ac.cursos['3'].abierto, false, 'solo se adelanta un curso');
    // más retos no abren otro curso
    const extra = Object.keys(claves.quiz)[3];
    await s.llamar('/api/retos/completar', { retoId: extra, tipo: 'quiz', respuestas: respuestasOk(extra) });
    assert.equal((await s.llamar('/api/acceso')).cuerpo.cursos['3'].abierto, false);
    assert.equal((await s.llamar('/api/cursos/2/progreso', { leccion: 0 })).status, 200);
  } finally { s.cerrar(); }
});

test('un quiz mal contestado no cuenta, y sin socio ni prueba se rechaza', async () => {
  const s = await levantar(base());
  try {
    const id = Object.keys(claves.quiz)[0];
    const mal = await s.llamar('/api/retos/completar', { retoId: id, tipo: 'quiz', respuestas: { 0: 3, 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 } });
    assert.equal(mal.cuerpo.supera, false);
    assert.equal(mal.cuerpo.retosSuperados, 0);
    assert.equal((await s.llamar('/api/retos/completar', { retoId: 'no-existe', tipo: 'quiz', respuestas: {} })).status, 400);
  } finally { s.cerrar(); }
  const sin = await levantar({ 'members/u1': { status: 'registered' } });
  try {
    assert.equal((await sin.llamar('/api/retos/completar', { retoId: Object.keys(claves.quiz)[0], tipo: 'quiz', respuestas: {} })).status, 402);
  } finally { sin.cerrar(); }
});

test('detective: se supera con el 75 % de los errores y pocas marcas de más; el servidor revela los que faltaron', async () => {
  const { calificarDetective } = require('../services/acceso');
  const e = claves.detective['d-sala'];
  const sobre = i => ({ x: e[i].x, y: e[i].y });
  assert.equal(calificarDetective(e, [sobre(0), sobre(1), sobre(2), sobre(3)]).perfecto, true);
  assert.equal(calificarDetective(e, [sobre(0), sobre(0), sobre(1), sobre(2)]).ok, 3, 'un mismo error no cuenta dos veces');
  assert.equal(calificarDetective(e, [sobre(0), sobre(1)]).supera, false);
  assert.equal(calificarDetective(e, [sobre(0), sobre(1), sobre(2), { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }]).supera, false, 'marcar todo no sirve');
  const s = await levantar(base());
  try {
    const bien = await s.llamar('/api/retos/completar', { retoId: 'd-sala', tipo: 'detective', marcas: [sobre(0), sobre(1), sobre(2), sobre(3)] });
    assert.equal(bien.cuerpo.supera, true); assert.equal(bien.cuerpo.nuevo, true); assert.equal(bien.cuerpo.xp, 10);
    const otra = await s.llamar('/api/retos/completar', { retoId: 'd-higiene', tipo: 'detective', marcas: [{ x: claves.detective['d-higiene'][0].x, y: claves.detective['d-higiene'][0].y }] });
    const intento = () => s.llamar('/api/retos/completar', { retoId: 'd-higiene', tipo: 'detective', marcas: [{ x: claves.detective['d-higiene'][0].x, y: claves.detective['d-higiene'][0].y }] });
    assert.equal(otra.cuerpo.supera, false); assert.equal(otra.cuerpo.faltan.length, 0, 'el primer intento no revela dónde estaban');
    assert.equal(otra.cuerpo.intentosRestantes, 2); assert.equal(otra.cuerpo.aciertos.length, 1, 'sí dice cuáles marcas estaban bien');
    assert.equal((await intento()).cuerpo.faltan.length, 0);
    const tercero = (await intento()).cuerpo;
    assert.equal(tercero.faltan.length, 3, 'al tercer intento fallido se muestran los que faltaron'); assert.equal(tercero.revelado, true);
    assert.equal((await intento()).cuerpo.faltan.length, 0, 'después de revelar, vuelve a contar desde cero');
    assert.equal((await s.llamar('/api/retos/completar', { retoId: 'no-existe', tipo: 'detective', marcas: [] })).status, 400);
  } finally { s.cerrar(); }
});

test('modo historia: se supera con 3 de 4, los mundos van en orden y el XP se da una sola vez', async () => {
  const s = await levantar(base());
  try {
    const bien = id => Object.fromEntries(claves.historia[id].map((c, i) => [i, c]));
    assert.equal((await s.llamar('/api/retos/completar', { retoId: 'h-2', tipo: 'historia', respuestas: bien('h-2') })).status, 403, 'no se salta el mundo 1');
    const mal = await s.llamar('/api/retos/completar', { retoId: 'h-1', tipo: 'historia', respuestas: { 0: 9, 1: 9, 2: 9, 3: 9 } });
    assert.equal(mal.cuerpo.supera, false);
    const tres = bien('h-1'); tres[3] = (tres[3] + 1) % 3;
    const r3 = await s.llamar('/api/retos/completar', { retoId: 'h-1', tipo: 'historia', respuestas: tres });
    assert.equal(r3.cuerpo.supera, true); assert.equal(r3.cuerpo.nuevo, true); assert.equal(r3.cuerpo.xp, 6);
    assert.equal((await s.llamar('/api/retos/completar', { retoId: 'h-1', tipo: 'historia', respuestas: bien('h-1') })).cuerpo.nuevo, false, 'el XP no se cobra dos veces');
    const r2 = await s.llamar('/api/retos/completar', { retoId: 'h-2', tipo: 'historia', respuestas: bien('h-2') });
    assert.equal(r2.cuerpo.nuevo, true); assert.equal(r2.cuerpo.xp, 10);
  } finally { s.cerrar(); }
});

// ---- Miembros antiguos: conservan todo lo que tenían, sea cual sea el formato de su ficha ----
test('un miembro antiguo SIN lista de pagos pero con un cobro reciente de renovación sigue siendo antiguo (todo abierto)', () => {
  const cfgDesde = { ...cfg, escalonadoDesde: '2026-10-20' };
  const legado = { status: 'active', startDate: '2026-01-15', lastPaymentDate: '2026-10-25' }; // alta en enero, renovó la semana pasada
  const a = calcularAcceso({ miembro: legado, catalogo, cfg: cfgDesde, ahora: new Date(Date.UTC(2026, 9, 28)) });
  assert.equal(a.escalonado, false); assert.equal(abiertos(a).length, 4);
});

test('antiguos con distintos formatos de ficha: todos conservan todo abierto; el nuevo que paga después sí sigue la regla', () => {
  const cfgDesde = { ...cfg, escalonadoDesde: '2026-10-20' }, ahora = new Date(Date.UTC(2026, 9, 28));
  const antiguos = [
    { status: 'active', payments: [{ date: '2026-03-02' }, { date: '2026-10-02' }] },
    { status: 'active', startDate: '2026-02-10' },
    { status: 'active', activadoEn: '2026-05-05', startDate: '2026-04-01' },
    { status: 'active', giftedAt: '2026-06-01' },
    { status: 'cancelled', payments: [{ date: '2026-07-01' }], accessUntil: '2026-11-30' }
  ];
  antiguos.forEach(m => { const a = calcularAcceso({ miembro: m, catalogo, cfg: cfgDesde, ahora }); assert.equal(a.escalonado, false, JSON.stringify(m)); assert.equal(abiertos(a).length, 4); });
  const nuevo = calcularAcceso({ miembro: { status: 'active', startDate: '2026-02-10', payments: [{ date: '2026-10-24' }] }, catalogo, cfg: cfgDesde, ahora });
  assert.equal(nuevo.escalonado, true); assert.equal(nuevo.diaMembresia, 5); assert.equal(abiertos(nuevo).length, 1);
});

test('los retos que ya tenía en el sistema anterior se pasan una sola vez y cuentan (sin repetir su XP)', async () => {
  const ids = Object.keys(claves.quiz).slice(0, 2);
  const semilla = base();
  semilla['members/u1/progress/achievements'] = { retos: { xp: 40, hechos: { [ids[0]]: { fecha: '2026-09-01', mejor: 5, total: 6 }, [ids[1]]: { fecha: '2026-09-02', mejor: 6, total: 6 }, 'q-no-existe': { mejor: 3, total: 3 } } } };
  const s = await levantar(semilla);
  try {
    const r = (await s.llamar('/api/acceso')).cuerpo;
    assert.equal(r.retosSuperados, 2, 'los dos retos válidos cuentan y el que no existe no');
    assert.equal(r.adelanto.porTipo.quiz, 2);
    const guardado = s.db.datos.get('members/u1/progress/retos');
    assert.equal(guardado.heredado, true);
    assert.equal(guardado.superados[ids[0]].xp, 0, 'el XP ya viene en xpHeredado: no se cuenta dos veces');
    assert.equal((await s.llamar('/api/acceso')).cuerpo.retosSuperados, 2, 'la segunda vez no cambia nada');
  } finally { s.cerrar(); }
});
