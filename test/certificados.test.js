const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasCertificados, validarNombre, folioCertificado, esAdminPorToken } = require('../services/certificados');

process.env.CERT_SIGNING_KEY = 'llave-de-prueba-larga-1234567890';

// ---- Firestore falso (solo lo que usan las rutas) ----
function fakeDb(semilla = {}) {
  const datos = new Map(Object.entries(semilla));
  const ref = ruta => ({
    id: ruta.split('/').pop(),
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v) { datos.set(ruta, JSON.parse(JSON.stringify(v))); },
    async update(v) { datos.set(ruta, { ...datos.get(ruta), ...v }); },
    collection: n => col(ruta + '/' + n),
    doc: n => ref(ruta + '/' + n)
  });
  const col = nombre => {
    const filtros = []; let orden = null, lim = 1e9;
    const q = {
      doc: id => ref(nombre + '/' + id),
      where(campo, op, valor) { filtros.push([campo, valor]); return q; },
      orderBy(campo, dir) { orden = [campo, dir]; return q; },
      limit(n) { lim = n; return q; },
      async get() {
        let docs = [...datos.entries()].filter(([k]) => k.startsWith(nombre + '/') && k.split('/').length === nombre.split('/').length + 1)
          .filter(([, v]) => filtros.every(([c, val]) => v[c] === val)).map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
        if (orden) docs.sort((a, b) => String(b.data()[orden[0]]).localeCompare(String(a.data()[orden[0]])));
        docs = docs.slice(0, lim);
        return { docs, empty: docs.length === 0 };
      }
    };
    return q;
  };
  return { collection: col, doc: ruta => ref(ruta), datos };
}

const catalogo = { courses: [{ courseId: 11, title: 'Curso de prueba', lessons: [{ lessonId: 1 }, { lessonId: 2 }] }] };
const tokens = {
  socio: { uid: 'u1', email: 'socio@mail.com', email_verified: true },
  otro: { uid: 'u2', email: 'otro@mail.com', email_verified: true },
  admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true },
  adminFalso: { uid: 'a2', email: 'teccapitalweb@gmail.com', email_verified: false }
};

async function levantar(semilla) {
  const db = fakeDb(semilla);
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('mal'); return tokens[t]; } }) };
  const app = express(); app.use(express.json());
  const deps = { db, admin, cargarCatalogo: () => catalogo, generarPdf: async () => Buffer.from('%PDF-falso') };
  montarRutasCertificados(app, deps);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, { metodo = 'GET', token, cuerpo } = {}) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, cuerpo: tipo.includes('json') ? await r.json() : await r.text() };
  };
  return { llamar, db, deps, cerrar: () => srv.close() };
}

const progresoCompleto = { 'members/u1/progress/courses': { c_11: { completed: [0, 1] } } };

test('validarNombre exige nombre y apellido, y lo capitaliza', () => {
  assert.equal(validarNombre('  ana   torres ').nombre, 'Ana Torres');
  assert.equal(validarNombre('Ana').ok, false);
  assert.equal(validarNombre('Ana 123 Torres').ok, false);
});

test('el folio es estable por socio y curso', () => {
  assert.equal(folioCertificado('u1', 11), folioCertificado('u1', 11));
  assert.notEqual(folioCertificado('u1', 11), folioCertificado('u2', 11));
});

test('solo cuenta como admin un correo de la lista y verificado', () => {
  assert.equal(esAdminPorToken(tokens.admin), true);
  assert.equal(esAdminPorToken(tokens.adminFalso), false);
  assert.equal(esAdminPorToken(tokens.socio), false);
});

test('no emite sin sesión ni con el curso incompleto', async () => {
  const s = await levantar({ 'members/u1/progress/courses': { c_11: { completed: [0] } } });
  try {
    assert.equal((await s.llamar('/api/certificados/emitir', { metodo: 'POST', cuerpo: { courseId: 11, nombre: 'Ana Torres' } })).status, 401);
    const r = await s.llamar('/api/certificados/emitir', { metodo: 'POST', token: 'socio', cuerpo: { courseId: 11, nombre: 'Ana Torres' } });
    assert.equal(r.status, 409);
  } finally { s.cerrar(); }
});

test('emite al terminar, es idempotente y se verifica públicamente', async () => {
  const s = await levantar(progresoCompleto);
  try {
    const a = await s.llamar('/api/certificados/emitir', { metodo: 'POST', token: 'socio', cuerpo: { courseId: 11, nombre: 'ana torres' } });
    assert.equal(a.status, 201); assert.equal(a.cuerpo.certificado.nombre, 'Ana Torres');
    assert.equal(s.db.datos.get('members/u1').name, 'Ana Torres'); // el nombre confirmado pasa al perfil
    const folio = a.cuerpo.certificado.folio;
    const b = await s.llamar('/api/certificados/emitir', { metodo: 'POST', token: 'socio', cuerpo: { courseId: 11, nombre: 'Otro Nombre' } });
    assert.equal(b.status, 200); assert.equal(b.cuerpo.certificado.nombre, 'Ana Torres');
    const v = await s.llamar('/api/certificados/' + folio);
    assert.equal(v.cuerpo.valido, true); assert.equal(v.cuerpo.certificado.email, undefined);
    const mios = await s.llamar('/api/certificados/mios', { token: 'socio' });
    assert.equal(mios.cuerpo.certificados.length, 1);
    assert.equal((await s.llamar('/api/certificados/mios', { token: 'otro' })).cuerpo.certificados.length, 0);
    const pdf = await s.llamar('/api/certificados/' + folio + '/pdf');
    assert.equal(pdf.status, 200);
  } finally { s.cerrar(); }
});

test('una firma alterada no verifica', async () => {
  const s = await levantar(progresoCompleto);
  try {
    const a = await s.llamar('/api/certificados/emitir', { metodo: 'POST', token: 'socio', cuerpo: { courseId: 11, nombre: 'Ana Torres' } });
    const folio = a.cuerpo.certificado.folio;
    s.db.datos.set('certificados/' + folio, { ...s.db.datos.get('certificados/' + folio), nombre: 'Persona Falsa' });
    assert.equal((await s.llamar('/api/certificados/' + folio)).cuerpo.valido, false);
  } finally { s.cerrar(); }
});

test('las rutas de administrador rechazan a socios y correos sin verificar', async () => {
  const s = await levantar(progresoCompleto);
  try {
    assert.equal((await s.llamar('/api/admin/yo')).status, 401);
    assert.equal((await s.llamar('/api/admin/yo', { token: 'socio' })).status, 403);
    assert.equal((await s.llamar('/api/admin/yo', { token: 'adminFalso' })).status, 403);
    assert.equal((await s.llamar('/api/admin/certificados', { token: 'socio' })).status, 403);
    assert.equal((await s.llamar('/api/admin/yo', { token: 'admin' })).status, 200);
  } finally { s.cerrar(); }
});

test('el admin lista, emite a mano, revoca y ve el progreso', async () => {
  const s = await levantar({ ...progresoCompleto, 'members/u1': { name: 'Ana Torres', email: 'socio@mail.com' } });
  try {
    const m = await s.llamar('/api/admin/certificados', { metodo: 'POST', token: 'admin', cuerpo: { email: 'socio@mail.com', courseId: 11 } });
    assert.equal(m.status, 201);
    const folio = m.cuerpo.certificado.folio;
    const lista = await s.llamar('/api/admin/certificados', { token: 'admin' });
    assert.equal(lista.cuerpo.total, 1); assert.equal(lista.cuerpo.certificados[0].email, 'socio@mail.com');
    const prog = await s.llamar('/api/admin/progreso/u1', { token: 'admin' });
    assert.deepEqual(prog.cuerpo.cursos[0], { cursoId: 11, titulo: 'Curso de prueba', total: 2, hechas: 2, completo: true });
    await s.llamar('/api/admin/certificados/' + folio + '/revocar', { metodo: 'POST', token: 'admin' });
    assert.equal((await s.llamar('/api/certificados/' + folio)).cuerpo.valido, false);
    assert.equal((await s.llamar('/api/certificados/mios', { token: 'socio' })).cuerpo.certificados.length, 0);
  } finally { s.cerrar(); }
});

test('certificado automático: se emite solo con el nombre del perfil y el nombre se confirma una vez (se vuelve a firmar)', async () => {
  const s = await levantar({ ...progresoCompleto, 'members/u1': { name: 'ana torres' } });
  try {
    const curso = catalogo.courses[0];
    const r = await s.deps.emitirCertificadoAuto({ uid: 'u1', email: 'a@m.com', curso, nombreCandidato: 'ana torres' });
    assert.equal(r.nuevo, true); assert.equal(r.confirmarNombre, true); assert.equal(r.certificado.nombre, 'Ana Torres');
    const folio = r.certificado.folio;
    assert.equal((await s.llamar('/api/certificados/' + folio + '/nombre', { metodo: 'POST', cuerpo: { nombre: 'Ana María Torres Ruiz' } })).status, 401);
    assert.equal((await s.llamar('/api/certificados/' + folio + '/nombre', { metodo: 'POST', token: 'socio', cuerpo: { nombre: 'Ana' } })).status, 400);
    const ok = await s.llamar('/api/certificados/' + folio + '/nombre', { metodo: 'POST', token: 'socio', cuerpo: { nombre: 'ana maría torres ruiz' } });
    assert.equal(ok.status, 200); assert.equal(ok.cuerpo.nombre, 'Ana María Torres Ruiz');
    assert.equal(s.db.datos.get('members/u1').name, 'Ana María Torres Ruiz'); // también en el perfil
    assert.equal((await s.llamar('/api/certificados/' + folio)).cuerpo.valido, true); // la firma nueva sigue siendo válida
    assert.equal((await s.llamar('/api/certificados/' + folio + '/nombre', { metodo: 'POST', token: 'socio', cuerpo: { nombre: 'Otro Nombre Más' } })).status, 409); // solo una vez
    const otra = await s.deps.emitirCertificadoAuto({ uid: 'u1', email: 'a@m.com', curso, nombreCandidato: 'x' });
    assert.equal(otra.nuevo, false); assert.equal(otra.confirmarNombre, false);
  } finally { s.cerrar(); }
});

test('certificado automático: si el nombre del perfil no sirve (una sola palabra) pide el nombre', async () => {
  const s = await levantar({ ...progresoCompleto, 'members/u1': { name: 'Ana' } });
  try {
    const r = await s.deps.emitirCertificadoAuto({ uid: 'u1', email: 'a@m.com', curso: catalogo.courses[0], nombreCandidato: 'Ana' });
    assert.equal(r.requiereNombre, true); assert.equal(r.certificado, undefined);
  } finally { s.cerrar(); }
});

test('el administrador emite de una vez los certificados de cursos ya terminados antes (sin correos); solo el administrador', async () => {
  const s = await levantar({
    'members/u1': { name: 'Ana Torres', email: 'ana@mail.com' }, 'members/u1/progress/courses': { c_11: { completed: [0, 1] } },
    'members/u2': { name: 'Beto', email: 'beto@mail.com' }, 'members/u2/progress/courses': { c_11: { completed: [0, 1] } },
    'members/u3': { name: 'Carla Paz', email: 'carla@mail.com' }, 'members/u3/progress/courses': { c_11: { completed: [0] } }
  });
  try {
    assert.equal((await s.llamar('/api/admin/certificados/retroactivos', { metodo: 'POST', token: 'socio' })).status, 403);
    const r = (await s.llamar('/api/admin/certificados/retroactivos', { metodo: 'POST', token: 'admin' })).cuerpo;
    assert.equal(r.miembros, 3); assert.equal(r.conCursosTerminados, 2); assert.equal(r.emitidos, 1); assert.equal(r.sinNombreValido, 1);
    const otra = (await s.llamar('/api/admin/certificados/retroactivos', { metodo: 'POST', token: 'admin' })).cuerpo;
    assert.equal(otra.emitidos, 0); assert.equal(otra.yaExistian, 1, 'no se repite');
  } finally { s.cerrar(); }
});
