const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const E = require('../services/encuesta');
const { montarRutasPublico } = require('../services/rutas-publico');

// ---------- Reglas puras ----------
test('encuesta: solo claves permitidas, textos cortos y completada booleana', () => {
  assert.equal(E.validarEncuesta({ sessionId: 's1', respuestas: { p1: 'Fisioterapeuta en consulta', area: 'Deportiva' }, completada: false }).ok, true);
  assert.equal(E.validarEncuesta({ sessionId: 's1', respuestas: { nombre: 'Ana' }, completada: false }).ok, false);
  assert.equal(E.validarEncuesta({ sessionId: 's1', respuestas: { p1: 'x'.repeat(200) }, completada: false }).ok, false);
  assert.equal(E.validarEncuesta({ sessionId: 's1', respuestas: { p1: 'a' }, completada: 'si' }).ok, false);
  assert.equal(E.validarEncuesta({ sessionId: '', respuestas: {}, completada: true }).ok, false);
  assert.equal(E.validarEncuesta({ sessionId: 's1', respuestas: {}, completada: true }).ignorar, true);
});

test('el número de WhatsApp exige 8 a 15 dígitos y aceptar el aviso', () => {
  const base = { sessionId: 's1', respuestas: { p1: 'a' }, completada: true };
  assert.equal(E.normalizarNumero('+52 (238) 147-8840'), '522381478840');
  assert.equal(E.normalizarNumero('12ab'), '');
  assert.equal(E.validarEncuesta({ ...base, contacto: { numero: '2381478840', avisoAceptado: false, avisoVersion: 'v1' } }).ok, false);
  assert.equal(E.validarEncuesta({ ...base, contacto: { numero: '123', avisoAceptado: true, avisoVersion: 'v1' } }).ok, false);
  const ok = E.validarEncuesta({ ...base, contacto: { numero: '238 147 8840', avisoAceptado: true, avisoVersion: '2026-10' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.valor.contacto, '2381478840');
});

test('guía: quita correos, teléfonos, enlaces y usuarios; ignora lo demasiado corto', () => {
  assert.equal(E.limpiarTextoGuia('escríbeme a ana@mail.com o al 238 147 8840 www.sitio.com @ana_fisio ¿hay curso de TENS?'), 'escríbeme a o al ¿hay curso de TENS?');
  assert.equal(E.validarSinRespuesta({ texto: 'ok' }).ignorar, true);
  assert.equal(E.validarSinRespuesta({ texto: 123 }).ok, false);
  assert.equal(E.claveGuia('¿Hay Curso de TENS?'), 'hay curso de tens');
  const c = E.combinarSinRespuesta(E.combinarSinRespuesta(null, { ejemplo: 'a b c' }, 1), { ejemplo: 'otro' }, 2);
  assert.equal(c.veces, 2); assert.equal(c.ejemplo, 'a b c'); assert.equal(c.primeraMs, 1);
});

test('visitas: páginas conocidas y respeto a No rastrear', () => {
  assert.equal(E.normalizarPagina('/index.html?x=1'), 'portada');
  assert.equal(E.normalizarPagina('aviso-de-privacidad'), 'aviso-privacidad');
  assert.equal(E.normalizarPagina('cualquier-cosa'), 'otra');
  assert.equal(E.visitaNoRastreable({ dnt: '1' }), true);
  assert.equal(E.visitaNoRastreable({ 'sec-gpc': '1' }), true);
  assert.equal(E.visitaNoRastreable({}), false);
});

test('el resumen junta copias de la misma sesión, calcula abandono y marca prospectos calientes', () => {
  const docs = [
    { sessionId: 'a', respuestas: { meta: 'x', p1: 'Estudiante de fisioterapia' }, completada: false, creadoMs: 1 },
    { sessionId: 'a', respuestas: { meta: 'x', p1: 'Estudiante de fisioterapia', origen: 'Redes sociales', area: 'Deportiva', experiencia: 'e', urgencia: 'Lo antes posible', freno: 'Precio' }, completada: true, creadoMs: 5, contacto: '2381478840', avisoVersion: 'v1' },
    { sessionId: 'b', respuestas: { meta: 'x', p1: 'Fisioterapeuta en consulta', origen: 'Buscador' }, completada: false, creadoMs: 3 }
  ];
  const r = E.resumirEncuesta(docs);
  assert.equal(r.sesiones, 2); assert.equal(r.completadas, 1); assert.equal(r.tasa, 50);
  assert.equal(r.abandono[0].clave, 'area');
  assert.equal(r.leads.length, 1); assert.equal(r.leads[0].caliente, true);
  assert.equal(r.perfiles.length, 2);
});

// ---------- Rutas ----------
function fakeDb(semilla = {}) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    collection: n => col(ruta + '/' + n),
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...JSON.parse(JSON.stringify(v)) } : JSON.parse(JSON.stringify(v))); }
  });
  const col = nombre => {
    let lim = 1e9, orden = null, dir = 1;
    const q = {
      doc: id => ref(nombre + '/' + id), limit(n) { lim = n; return q; },
      orderBy(c, d) { orden = c; dir = d === 'desc' ? -1 : 1; return q; },
      async get() {
        let docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/')).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        if (orden) docs.sort((a, b) => (a.data()[orden] > b.data()[orden] ? 1 : -1) * dir);
        return { docs: docs.slice(0, lim) };
      }
    };
    return q;
  };
  return { collection: col, datos, async runTransaction(fn) { return fn({ get: r => r.get(), set: (r, v, o) => r.set(v, o) }); } };
}
async function levantar(semilla) {
  const db = fakeDb(semilla);
  const admin = { auth: () => ({ verifyIdToken: async t => { if (t === 'admin') return { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true }; if (t === 'socio') return { uid: 's1', email: 's@mail.com', email_verified: true }; throw new Error('x'); } }) };
  const app = express(); app.use(express.json());
  montarRutasPublico(app, { db, admin });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, cuerpo, { token, cabeceras } = {}) => {
    const r = await fetch(url + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cabeceras || {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const texto = await r.text();
    return { status: r.status, cuerpo: texto ? JSON.parse(texto) : null };
  };
  return { llamar, db, cerrar: () => srv.close() };
}

test('POST /api/encuesta guarda la copia, rechaza claves ajenas y no pide sesión', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/encuesta', { sessionId: 's1', respuestas: { p1: 'Fisioterapeuta en consulta' }, completada: false })).status, 200);
    assert.equal((await s.llamar('/api/encuesta', { sessionId: 's1', respuestas: { correo: 'a@b.com' }, completada: false })).status, 400);
    assert.equal([...s.db.datos.keys()].filter(k => k.startsWith('encuestasProspectos/')).length, 1);
    assert.equal((await s.llamar('/api/encuesta', { sessionId: 's1', respuestas: {}, completada: true })).status, 200); // vacía: no se guarda
    assert.equal([...s.db.datos.keys()].filter(k => k.startsWith('encuestasProspectos/')).length, 1);
  } finally { s.cerrar(); }
});

test('POST /api/chatbot/sin-respuesta cuenta repeticiones sin guardar datos personales', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/chatbot/sin-respuesta', { texto: '¿Hay curso de TENS? ana@mail.com' });
    await s.llamar('/api/chatbot/sin-respuesta', { texto: '¿Hay curso de TENS?' });
    const guardados = [...s.db.datos.entries()].filter(([k]) => k.startsWith('chatbotSinRespuesta/'));
    assert.equal(guardados.length, 1);
    assert.equal(guardados[0][1].veces, 2);
    assert.equal(JSON.stringify(guardados).includes('@'), false);
  } finally { s.cerrar(); }
});

test('visitas: encendido por defecto cuenta; apagado desde Configuración no cuenta; No rastrear no cuenta; siempre 204', async () => {
  const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' };
  const apagado = await levantar({ 'config/club': { contadorVisitas: false } });
  try {
    assert.equal((await apagado.llamar('/api/visita', { pagina: 'landing' }, { cabeceras: UA })).status, 204);
    assert.equal([...apagado.db.datos.keys()].some(k => k.startsWith('metricasVisitas/')), false);
  } finally { apagado.cerrar(); }
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/visita', { pagina: 'landing', ref: 'https://l.facebook.com/' }, { cabeceras: UA })).status, 204);
    assert.equal((await s.llamar('/api/visita', { pagina: 'landing' }, { cabeceras: { ...UA, DNT: '1' } })).status, 204);
    assert.equal((await s.llamar('/api/visita', { pagina: 'landing' })).status, 204, 'sin navegador reconocible (bot): no cuenta');
    assert.equal((await s.llamar('/api/visita', { pagina: 'legal' }, { cabeceras: UA })).status, 204);
    const doc = [...s.db.datos.entries()].find(([k]) => /^metricasVisitas\/[0-9-]+$/.test(k))[1];
    assert.equal(doc.total, 2); assert.equal(doc.paginas.landing, 1); assert.equal(doc.paginas.legal, 1);
    assert.equal(doc.fuentes.facebook, 1); assert.equal(doc.dispositivos.movil, 1);
    const lectura = await s.llamar('/api/admin/visitas?periodo=hoy', null, { token: 'admin' });
    assert.equal(lectura.cuerpo.total, 2); assert.equal(lectura.cuerpo.encendido, true);
    const met = await s.llamar('/api/admin/metricas?dias=7', null, { token: 'admin' });
    assert.equal(met.status, 200); assert.equal(met.cuerpo.dias[met.cuerpo.dias.length - 1].total, 2);
    assert.equal((await s.llamar('/api/admin/metricas', null, { token: 'socio' })).status, 403);
  } finally { s.cerrar(); }
});

test('el panel lee la encuesta, las preguntas sin respuesta y las visitas; un socio no', async () => {
  const s = await levantar();
  try {
    await s.llamar('/api/encuesta', { sessionId: 'a', respuestas: { p1: 'Estudiante de fisioterapia', urgencia: 'Lo antes posible' }, completada: true, contacto: { numero: '2381478840', avisoAceptado: true, avisoVersion: 'v1' } });
    await s.llamar('/api/chatbot/sin-respuesta', { texto: 'precio de los cursos presenciales' });
    for (const ruta of ['/api/admin/encuesta', '/api/admin/chatbot/sin-respuesta', '/api/admin/visitas']) {
      assert.equal((await s.llamar(ruta)).status, 401);
      assert.equal((await s.llamar(ruta, null, { token: 'socio' })).status, 403);
    }
    const enc = await s.llamar('/api/admin/encuesta', null, { token: 'admin' });
    assert.equal(enc.cuerpo.sesiones, 1); assert.equal(enc.cuerpo.leads[0].numero, '2381478840');
    assert.equal((await s.llamar('/api/admin/chatbot/sin-respuesta', null, { token: 'admin' })).cuerpo.preguntas.length, 1);
  } finally { s.cerrar(); }
});
