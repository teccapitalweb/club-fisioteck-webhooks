const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { calcularAcceso, calificarQuiz, calificarOrden, montarRutasAcceso, configEscalonado } = require('../services/acceso');
const { montarRutasProgreso } = require('../services/progreso');

const catalogo = { courses: [1, 2, 3, 4].map(id => ({ courseId: id, title: 'C' + id, lessons: [{ isPreview: true }, {}, {}] })) };
const dia = n => new Date(Date.UTC(2026, 9, 1) + n * 864e5 + 12 * 36e5); // mediodía UTC = 6 a. m. en México: el mismo día del calendario
const cfg = { escalonadoActivo: true, escalonadoDias: 8, retosParaAdelantar: 12 };
const hechos = (q, o, d, h) => Object.fromEntries([...Array(q).keys()].map(i => ['q-' + i, {}]).concat([...Array(o).keys()].map(i => ['o-' + i, {}]), [...Array(d).keys()].map(i => ['d-' + i, {}]), [...Array(h).keys()].map(i => ['h-' + i, {}])));
const socio = (extra = {}) => ({ status: 'active', startDate: '2026-10-01', payments: [{ date: '2026-10-01', amount: 249 }], ...extra });
const abiertos = a => Object.entries(a.cursos).filter(([, v]) => v.abierto).map(([k]) => Number(k));

test('apagado, admin o socio antiguo (pagó antes de encenderlo): lo que ya vio sigue abierto y el resto sigue el calendario desde su pago', () => {
  assert.equal(calcularAcceso({ miembro: socio(), catalogo, cfg: {}, ahora: dia(0) }).escalonado, false);
  assert.equal(calcularAcceso({ miembro: socio(), catalogo, cfg, ahora: dia(0), esAdmin: true }).escalonado, false);
  const viejo = calcularAcceso({ miembro: socio(), catalogo, cfg: { ...cfg, escalonadoDesde: '2026-11-01' }, ahora: dia(0) });
  assert.equal(viejo.escalonado, true); assert.equal(viejo.antiguoRenovado, true);
  assert.equal(abiertos(viejo).length, 0, 'sin avance en ningún curso, todo entra al calendario');
  assert.equal(abiertos(calcularAcceso({ miembro: socio(), catalogo, cfg: { ...cfg, escalonadoDesde: '2026-11-01' }, ahora: dia(0), iniciados: ['1', '2', '3', '4'] })).length, 4, 'lo que ya empezó a ver se conserva');
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
  const a = calcularAcceso({ miembro: m, catalogo, cfg: cfgNuevo, ahora: new Date(Date.UTC(2026, 9, 11, 12)) }); // un día después de pagar
  assert.equal(a.escalonado, true); assert.equal(a.diaMembresia, 2); assert.equal(abiertos(a).length, 1);
  const sinPagos = calcularAcceso({ miembro: { status: 'active', startDate: '2026-08-01', activadoEn: '2026-10-10' }, catalogo, cfg: cfgNuevo, ahora: new Date(Date.UTC(2026, 9, 11, 12)) });
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
  const tokens = { socio: { uid: 'u1', email: 's@mail.com', email_verified: true }, admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true } };
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
const hoyISO = new Date(Date.now() - 6 * 3600e3).toISOString().split('T')[0]; // día de México (en UTC cambia a las 6 p. m. y el pago de «hoy» quedaba en el futuro)
const base = () => ({ 'members/u1': { status: 'active', payments: [{ date: hoyISO }] }, 'config/club': { escalonadoActivo: true } });
const claves = require('../data/retos-claves.json');
const respuestasOk = id => Object.fromEntries(claves.quiz[id].map((c, i) => [i, c]));

test('GET /api/acceso muestra los cursos cerrados con los días que faltan', async () => {
  const s = await levantar(base());
  try {
    const r = await s.llamar('/api/acceso?f=1');
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
      const ac = (await s.llamar('/api/acceso?f=1')).cuerpo;
      assert.equal(ac.cursos['2'].abierto, k === lista.length - 1, 'el curso 2 se abre solo con el reto número 12');
    }
    const ac = (await s.llamar('/api/acceso?f=1')).cuerpo;
    assert.equal(ac.adelantos, 1); assert.equal(ac.cursos['2'].porRetos, true);
    assert.equal(ac.cursos['3'].abierto, false, 'solo se adelanta un curso');
    // más retos no abren otro curso
    const extra = Object.keys(claves.quiz)[3];
    await s.llamar('/api/retos/completar', { retoId: extra, tipo: 'quiz', respuestas: respuestasOk(extra) });
    assert.equal((await s.llamar('/api/acceso?f=1')).cuerpo.cursos['3'].abierto, false);
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

test('antiguos con distintos formatos de ficha: sin lista de pagos conservan todo abierto; con pagos siguen el calendario desde su último pago; el nuevo también', () => {
  const cfgDesde = { ...cfg, escalonadoDesde: '2026-10-20' }, ahora = new Date(Date.UTC(2026, 9, 28, 12));
  const antiguos = [
    { status: 'active', startDate: '2026-02-10' },
    { status: 'active', activadoEn: '2026-05-05', startDate: '2026-04-01' },
    { status: 'active', giftedAt: '2026-06-01' },
    { status: 'cancelled', startDate: '2026-07-01', accessUntil: '2026-11-30' }
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
    const r = (await s.llamar('/api/acceso?f=1')).cuerpo;
    assert.equal(r.retosSuperados, 2, 'los dos retos válidos cuentan y el que no existe no');
    assert.equal(r.adelanto.porTipo.quiz, 2);
    const guardado = s.db.datos.get('members/u1/progress/retos');
    assert.equal(guardado.heredado, true);
    assert.equal(guardado.superados[ids[0]].xp, 0, 'el XP ya viene en xpHeredado: no se cuenta dos veces');
    assert.equal((await s.llamar('/api/acceso?f=1')).cuerpo.retosSuperados, 2, 'la segunda vez no cambia nada');
  } finally { s.cerrar(); }
});

test('el calendario cuenta días del calendario en hora de México: el día del pago es el 0 y «Restan N días» baja a la medianoche', () => {
  const miembro = { status: 'active', payments: [{ date: '2026-10-29T20:00:00Z' }] }; // 29 oct, 2 p. m. en México
  const catalogo = { courses: [{ courseId: 1, lessons: [{}] }, { courseId: 2, lessons: [{}] }, { courseId: 3, lessons: [{}] }] };
  const cfg = { escalonadoActivo: true, escalonadoDias: 8 };
  const en = iso => calcularAcceso({ miembro, catalogo, cfg, retosSuperados: 0, retosHechos: {}, ahora: new Date(iso), esAdmin: false, adelantados: [], conMembresia: true });
  assert.equal(en('2026-10-29T21:00:00Z').cursos['2'].dias, 8, 'el día del pago faltan 8');
  assert.equal(en('2026-10-30T07:00:00Z').cursos['2'].dias, 7, 'pasada la medianoche de México, faltan 7');
  assert.equal(en('2026-10-30T18:15:00Z').cursos['2'].dias, 7, 'todo el día siguiente siguen faltando 7');
  assert.equal(en('2026-10-30T18:15:00Z').cursos['3'].dias, 15);
  assert.equal(en('2026-11-06T05:59:00Z').cursos['2'].dias, 1, 'el último día antes de abrirse falta 1');
  assert.equal(en('2026-11-06T05:59:00Z').cursos['2'].abierto, false);
  assert.equal(en('2026-11-06T06:00:00Z').cursos['2'].abierto, true, 'se abre a las 00:00 del día 8 en México');
  assert.equal(en('2026-11-06T06:00:00Z').cursos['3'].abierto, false);
  assert.equal(en('2026-11-14T06:00:00Z').cursos['3'].abierto, true, 'el curso 3 se abre 8 días después');
});

test('los retos solo adelantan el primer curso de los 8 días; si ya se abrió por fecha, ya no hay adelanto', () => {
  const catalogo = { courses: Array.from({ length: 6 }, (_, i) => ({ courseId: i + 1, lessons: [{}] })) };
  const miembro = { status: 'active', payments: [{ date: '2026-10-01', concept: 'Membresía mensual', status: 'paid' }] };
  const en = iso => calcularAcceso({ miembro, catalogo, cfg: { escalonadoActivo: true, escalonadoDias: 8 }, retosSuperados: 0, retosHechos: {}, ahora: new Date(iso), esAdmin: false, adelantados: [], conMembresia: true });
  const a = en('2026-10-03T18:00:00Z');
  assert.equal(a.adelanto.estado, 'disponible'); assert.equal(a.adelanto.cursoId, '2', 'es el primer curso de los 8 días');
  const b = en('2026-10-10T18:00:00Z'); // el curso 2 ya se abrió por fecha; el 3 todavía no
  assert.equal(b.cursos['2'].abierto, true); assert.equal(b.cursos['3'].abierto, false);
  assert.equal(b.adelanto.estado, 'sin-cursos', 'ya no se adelanta ningún otro curso con retos');
});

test('si la membresía se vence y se vuelve a pagar: lo abierto se conserva, el calendario se reinicia con los 8 días y ya no hay adelanto por retos', () => {
  const catalogo = { courses: Array.from({ length: 14 }, (_, i) => ({ courseId: i + 1, lessons: [{}] })) };
  // Pagó el 1 de enero y renovó el 31; luego dejó de pagar y volvió el 20 de abril
  const miembro = { status: 'active', payments: [
    { date: '2026-01-01', concept: 'Membresía mensual', status: 'paid' }, { date: '2026-01-31', concept: 'Renovación mensual', status: 'paid' },
    { date: '2026-04-20', concept: 'Membresía mensual', status: 'paid' }] };
  const en = iso => calcularAcceso({ miembro, catalogo, cfg: { escalonadoActivo: true, escalonadoDias: 8, retosParaAdelantar: 12 }, retosSuperados: 0, retosHechos: {}, ahora: new Date(iso), esAdmin: false, adelantados: [], conMembresia: true });
  const a = en('2026-04-25T18:00:00Z');
  assert.equal(a.reanudada, true);
  // Al vencer (3 de marzo) iban abiertos 8 cursos (días 0, 8, 16… 56): se conservan
  [1, 2, 3, 4, 5, 6, 7, 8].forEach(id => assert.equal(a.cursos[String(id)].abierto, true, 'curso ' + id + ' conservado'));
  assert.equal(a.cursos['9'].abierto, false); assert.equal(a.cursos['9'].dias, 3, 'el primero cerrado se abre a 8 días de volver a pagar (28 de abril)');
  assert.equal(a.cursos['10'].dias, 11); assert.equal(a.cursos['11'].dias, 19);
  assert.equal(en('2026-04-28T06:00:00Z').cursos['9'].abierto, true);
  assert.equal(a.adelanto.estado, 'no-disponible', 'tras volver a pagar ya no se adelanta con retos');
  assert.equal(a.retosParaSiguiente, null);
  // Un pago un poco tarde (dentro de la gracia) no cuenta como vencimiento
  const tarde = { status: 'active', payments: [{ date: '2026-01-01', concept: 'Membresía mensual', status: 'paid' }, { date: '2026-02-05', concept: 'Renovación mensual', status: 'paid' }] };
  assert.equal(calcularAcceso({ miembro: tarde, catalogo, cfg: { escalonadoActivo: true, escalonadoDias: 8 }, retosSuperados: 0, retosHechos: {}, ahora: new Date('2026-02-10T18:00:00Z'), esAdmin: false, adelantados: [], conMembresia: true }).reanudada, false);
});

test('antiguo con plan: conserva lo que vio y lo demás entra al calendario desde el día de su último pago', () => {
  const cfgDesde = { ...cfg, escalonadoDesde: '2026-10-29' };
  const antiguo = pagos => ({ status: 'active', startDate: '2026-05-01', payments: pagos });
  const sinPagos = calcularAcceso({ miembro: { status: 'active', startDate: '2026-05-01' }, catalogo, cfg: cfgDesde, ahora: new Date(Date.UTC(2026, 10, 5, 12)) });
  assert.equal(sinPagos.escalonado, false); assert.equal(abiertos(sinPagos).length, 4, 'sin pagos registrados no se sabe desde cuándo contar: todo abierto');
  const m = antiguo([{ date: '2026-05-01', amount: 199 }, { date: '2026-10-27', amount: 199 }]);
  const d0 = calcularAcceso({ miembro: m, catalogo, cfg: cfgDesde, ahora: new Date(Date.UTC(2026, 9, 30, 18)), iniciados: ['2'] });
  assert.equal(d0.escalonado, true); assert.deepEqual(abiertos(d0), [2], 'lo que ya vio sigue abierto');
  assert.equal(d0.cursos['1'].dias, 5); assert.equal(d0.cursos['3'].dias, 13); assert.equal(d0.cursos['4'].dias, 21);
  assert.equal(d0.adelanto.estado, 'no-disponible', 'sin adelanto por retos');
  assert.deepEqual(abiertos(calcularAcceso({ miembro: m, catalogo, cfg: cfgDesde, ahora: new Date(Date.UTC(2026, 10, 4, 18)), iniciados: ['2'] })), [1, 2]);
  assert.equal(abiertos(calcularAcceso({ miembro: m, catalogo, cfg: cfgDesde, ahora: new Date(Date.UTC(2026, 11, 30, 18)), iniciados: ['2'] })).length, 4);
  const vencido = calcularAcceso({ miembro: antiguo([{ date: '2026-05-01', amount: 199 }, { date: '2026-11-10', amount: 199 }]), catalogo, cfg: cfgDesde, ahora: new Date(Date.UTC(2026, 10, 10, 18)), iniciados: ['2'] });
  assert.equal(vencido.cursos['1'].dias, 8, 'al volver a pagar cuenta desde ese pago');
});

test('antiguo: con 2 clases terminadas el curso se conserva; con 1 sola vuelve a cerrarse y entra al calendario', () => {
  const cfgDesde = { ...cfg, escalonadoDesde: '2026-10-29' };
  const m = { status: 'active', startDate: '2026-05-01', payments: [{ date: '2026-10-27', amount: 199 }] };
  const a = calcularAcceso({ miembro: m, catalogo, cfg: cfgDesde, ahora: new Date(Date.UTC(2026, 9, 30, 18)), avances: { 1: 1, 2: 2, 3: 5 } });
  assert.deepEqual(abiertos(a), [2, 3]); assert.equal(a.cursos['1'].abierto, false); assert.equal(a.cursos['1'].dias, 5);
});

test('admin: diagnóstico del acceso de un miembro (solo lectura) con el motivo', async () => {
  const s = await levantar({ 'members/u1': { status: 'active', email: 'a@m.com', startDate: '2026-01-10' }, 'config/club': { escalonadoActivo: true, escalonadoDesde: '2026-10-29' } });
  try {
    const sinPermiso = await s.llamar('/api/admin/acceso-miembro/u1', null, 'socio'); assert.equal(sinPermiso.status, 403);
    const r = await s.llamar('/api/admin/acceso-miembro/u1', null, 'admin');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.motivo, 'anterior'); assert.equal(r.cuerpo.calendario.activo, true);
    assert.equal(r.cuerpo.miembro.tieneMembresia, true); assert.equal(r.cuerpo.abiertos, r.cuerpo.total);
    assert.equal((await s.llamar('/api/admin/acceso-miembro/nadie', null, 'admin')).status, 404);
  } finally { s.cerrar(); }
});

test('/api/acceso reutiliza el cálculo reciente y con ?f=1 vuelve a calcular', async () => {
  const s = await levantar({ 'members/u1': { status: 'active', startDate: '2026-10-30', activadoEn: '2026-10-30T12:00:00.000Z' }, 'config/club': { escalonadoActivo: true } });
  try {
    const a = (await s.llamar('/api/acceso')).cuerpo;
    s.db.datos.set('members/u1', { status: 'inactive' });
    const b = (await s.llamar('/api/acceso')).cuerpo;
    assert.equal(b.membresia, a.membresia, 'sin ?f=1 usa lo calculado hace unos segundos');
    const c = (await s.llamar('/api/acceso?f=1')).cuerpo;
    assert.equal(c.membresia, false, 'con ?f=1 recalcula');
  } finally { s.cerrar(); }
});

test('quien paga de noche (después de las 6 p. m. en México) ve su primer curso abierto aunque el pago quedó fechado con el día UTC de mañana', () => {
  const cfgN = { ...cfg, escalonadoDesde: '2026-10-01' };
  const ahora = new Date(Date.UTC(2026, 9, 31, 2, 0)); // 30 oct, 8 p. m. en México = 31 oct 02:00 UTC
  const m = { status: 'active', startDate: '2026-10-31', payments: [{ date: '2026-10-31', amount: 199 }] };
  const a = calcularAcceso({ miembro: m, catalogo, cfg: cfgN, ahora });
  assert.equal(a.escalonado, true); assert.deepEqual(abiertos(a), [1], 'el primer curso está abierto desde el pago');
  assert.equal(a.cursos['2'].dias, 8);
  // con la fecha en hora de México (como se guarda ahora) también
  const b = calcularAcceso({ miembro: { ...m, payments: [{ date: '2026-10-30', amount: 199 }] }, catalogo, cfg: cfgN, ahora });
  assert.deepEqual(abiertos(b), [1]); assert.equal(b.cursos['2'].dias, 8);
});
