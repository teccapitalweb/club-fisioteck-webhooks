'use strict';
// RED PROFESIONAL del Directorio: conexiones, alcances de contacto y perfil profesional (CV)
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { montarRutasRed, estadoDe, idPar } = require('../services/red-profesional');
const { montarRutasDirectorio, contactoLimpio, canalVisible } = require('../services/directorio');
const { montarRutasPerfil, perfilLimpio, seccionVisible, avancePerfil } = require('../services/perfil-profesional');

function fakeDb(semilla = {}) {
  const datos = new Map(Object.entries(semilla)); let seq = 0;
  const ref = ruta => ({ id: ruta.split('/').pop(),
    async get() { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), data: () => v }; },
    async set(v, o) { datos.set(ruta, o && o.merge ? { ...(datos.get(ruta) || {}), ...v } : { ...v }); },
    async delete() { datos.delete(ruta); }, collection: n => col(ruta + '/' + n) });
  const col = ruta => {
    const docs = (orden, dir, tope, filtro) => {
      let l = [...datos.keys()].filter(k => k.startsWith(ruta + '/') && !k.slice(ruta.length + 1).includes('/')).map(k => ({ id: k.split('/').pop(), v: datos.get(k) }));
      if (filtro) l = l.filter(x => x.v[filtro[0]] === filtro[1]);
      if (orden) l.sort((a, b) => (dir === 'desc' ? (b.v[orden] || 0) - (a.v[orden] || 0) : (a.v[orden] || 0) - (b.v[orden] || 0)));
      if (tope) l = l.slice(0, tope);
      return l.map(x => ({ id: x.id, data: () => x.v }));
    };
    const consulta = (orden, dir, tope, filtro) => ({ where: (c, _o, val) => consulta(orden, dir, tope, [c, val]), orderBy: (c, d) => consulta(c, d || 'asc', tope, filtro), limit: n => consulta(orden, dir, n, filtro), async get() { return { docs: docs(orden, dir, tope, filtro) }; } });
    return { doc: id => ref(ruta + '/' + (id || 'auto' + (++seq))), ...consulta(null, null, null, null) };
  };
  return { datos, collection: n => col(n) };
}

async function levantar(semilla, reloj) {
  const db = fakeDb({
    'members/u1': { name: 'Ana Torres', email: 'ana@mail.com', status: 'active' },
    'members/u2': { name: 'Beto Ruiz', email: 'beto@mail.com', status: 'active' },
    'members/u3': { name: 'Caro Diaz', email: 'caro@mail.com', status: 'registered' },
    'directorio/u1': { nombre: 'Ana Torres', puesto: 'Fisioterapeuta', especialidad: 'Geriatría', publicado: true },
    'directorio/u2': { nombre: 'Beto Ruiz', puesto: 'Rehabilitador', publicado: true },
    'directorio/u3': { nombre: 'Caro Diaz', publicado: true },
    ...semilla
  });
  const tokens = {
    admin: { uid: 'a1', email: 'teccapitalweb@gmail.com', email_verified: true },
    ana: { uid: 'u1', email: 'ana@mail.com', email_verified: true },
    beto: { uid: 'u2', email: 'beto@mail.com', email_verified: true },
    caro: { uid: 'u3', email: 'caro@mail.com', email_verified: true }
  };
  const admin = { auth: () => ({ verifyIdToken: async t => { if (!tokens[t]) throw new Error('x'); return tokens[t]; } }) };
  const deps = { db, admin, ahora: reloj, tieneMembresia: m => !!m && ['active', 'paid', 'cancelled'].includes(m.status) };
  const app = express(); app.use(express.json({ limit: '1mb' }));
  const red = montarRutasRed(app, deps);
  deps.conectadosDe = red.conectadosDe;
  montarRutasDirectorio(app, deps);
  montarRutasPerfil(app, deps);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const llamar = async (ruta, metodo = 'GET', cuerpo, token) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
  };
  return { db, llamar, cerrar: () => srv.close() };
}

test('conectar: solicitud → aceptar, con aviso en la campana en ambos pasos', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' })).status, 401, 'sin sesión no hay red');
    const env = await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'ana');
    assert.equal(env.status, 200); assert.equal(env.cuerpo.estado, 'enviada');
    assert.ok([...s.db.datos.keys()].some(k => k.startsWith('members/u2/avisos/red_sol_')), 'beto recibe el aviso de solicitud');
    const deBeto = (await s.llamar('/api/red', 'GET', null, 'beto')).cuerpo;
    assert.equal(deBeto.recibidas.length, 1); assert.equal(deBeto.recibidas[0].nombre, 'Ana Torres'); assert.equal(deBeto.estados.u1, 'recibida');
    const deAna = (await s.llamar('/api/red', 'GET', null, 'ana')).cuerpo;
    assert.equal(deAna.enviadas.length, 1); assert.equal(deAna.estados.u2, 'enviada');
    const ok = await s.llamar('/api/red/u1/aceptar', 'POST', null, 'beto');
    assert.equal(ok.cuerpo.estado, 'conectado');
    assert.ok([...s.db.datos.keys()].some(k => k.startsWith('members/u1/avisos/red_ok_')), 'ana se entera de que la aceptaron');
    assert.equal((await s.llamar('/api/red', 'GET', null, 'ana')).cuerpo.total, 1);
    assert.equal((await s.llamar('/api/red', 'GET', null, 'beto')).cuerpo.conexiones[0].uid, 'u1');
    // repetir la solicitud ya conectados no rompe nada
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'ana')).cuerpo.estado, 'conectado');
    // eliminar la conexión la deja en cero y permite reconectar de inmediato
    assert.equal((await s.llamar('/api/red/u2/eliminar', 'POST', null, 'ana')).cuerpo.estado, 'ninguna');
    assert.equal((await s.llamar('/api/red', 'GET', null, 'beto')).cuerpo.total, 0);
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'ana')).cuerpo.estado, 'enviada');
  } finally { s.cerrar(); }
});

test('conectar es beneficio VIP: sin membresía no se envía ni se acepta (el admin sí puede)', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'caro')).status, 402, 'caro (sin membresía) no puede enviar solicitud');
    const env = await s.llamar('/api/red/solicitar', 'POST', { uid: 'u3' }, 'ana');
    assert.equal(env.cuerpo.estado, 'enviada', 'ana (VIP) sí puede escribirle a caro');
    assert.equal((await s.llamar('/api/red/u1/aceptar', 'POST', null, 'caro')).status, 402, 'caro (sin membresía) no puede aceptar aunque le hayan escrito');
    // el administrador no tiene membresía de socio, pero igual puede probar la red
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'admin')).status, 409, 'el admin pasa el filtro VIP (llega hasta la siguiente regla: no tiene tarjeta publicada)');
  } finally { s.cerrar(); }
});

test('reglas de la red: tarjeta publicada, rechazo con espera de 24 h, límite diario y cruces inválidos', async () => {
  let t = 1700000000000; const reloj = () => t;
  const s = await levantar({ 'directorio/u1': { nombre: 'Ana', publicado: false } }, reloj);
  try {
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'ana')).status, 409, 'sin tarjeta publicada no se conecta');
    s.db.datos.set('directorio/u1', { nombre: 'Ana Torres', publicado: true });
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u1' }, 'ana')).status, 400, 'no te conectas contigo');
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'nadie' }, 'ana')).status, 404, 'perfil inexistente');
    await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'ana');
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u1' }, 'beto')).status, 409, 'si ya te escribieron, respondes en Solicitudes');
    assert.equal((await s.llamar('/api/red/u2/aceptar', 'POST', null, 'ana')).status, 409, 'el remitente no puede aceptarse solo');
    // beto rechaza → ana debe esperar 24 h para reintentar
    assert.equal((await s.llamar('/api/red/u1/rechazar', 'POST', null, 'beto')).cuerpo.estado, 'ninguna');
    t += 1000;
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'ana')).status, 429, 'tras el rechazo hay espera de 24 horas');
    t += 24 * 3600 * 1000;
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u2' }, 'ana')).status, 200);
    // límite diario: 30 por día
    s.db.datos.set('conexionesLimites/u1', { dia: new Date(t).toISOString().slice(0, 10), enviadas: 30 });
    assert.equal((await s.llamar('/api/red/solicitar', 'POST', { uid: 'u3' }, 'ana')).status, 429, 'límite de 30 al día');
  } finally { s.cerrar(); }
});

test('alcance del contacto por canal: miembros / solo conexiones / oculto', () => {
  const c = contactoLimpio({ whatsapp: '2381234567', email: 'ana@mail.com', alcances: { whatsapp: 'conexiones', email: 'oculto', web: 'raro' } });
  assert.equal(c.alcances.whatsapp, 'conexiones'); assert.equal(c.alcances.email, 'oculto'); assert.equal(c.alcances.web, 'miembros');
  assert.equal(canalVisible('miembros', {}), true);
  assert.equal(canalVisible('conexiones', {}), false);
  assert.equal(canalVisible('conexiones', { conectado: true }), true);
  assert.equal(canalVisible('oculto', { conectado: true }), false);
  assert.equal(canalVisible('oculto', { duenio: true }), true);
  assert.equal(canalVisible('oculto', { admin: true }), true);
});

test('meta del directorio: el canal "solo conexiones" únicamente llega a las conexiones; la portada VIP viaja en meta', async () => {
  const s = await levantar({
    'directorioContacto/u1': { uid: 'u1', whatsapp: '2381234567', email: 'ana@mail.com', alcances: { whatsapp: 'conexiones', email: 'miembros', instagram: 'oculto' }, instagram: '@ana' },
    'directorioExtra/u1': { uid: 'u1', portadaHex: '#aa33cc', portadaFoto: '' }
  });
  try {
    const beto1 = (await s.llamar('/api/directorio/meta', 'GET', null, 'beto')).cuerpo;
    assert.equal(beto1.contactos.u1.email, 'ana@mail.com', 'alcance miembros: sí llega');
    assert.equal(beto1.contactos.u1.whatsapp, undefined, 'alcance conexiones: sin conectar no llega');
    assert.equal(beto1.contactos.u1.instagram, undefined, 'alcance oculto: nunca llega');
    assert.equal(beto1.portadas.u1.hex, '#aa33cc', 'la portada personalizada viaja en meta');
    await s.llamar('/api/red/solicitar', 'POST', { uid: 'u1' }, 'beto');
    await s.llamar('/api/red/u2/aceptar', 'POST', null, 'ana');
    const beto2 = (await s.llamar('/api/directorio/meta', 'GET', null, 'beto')).cuerpo;
    assert.equal(beto2.contactos.u1.whatsapp, '2381234567', 'ya conectados, el canal "solo conexiones" sí llega');
    assert.deepEqual(beto2.misConexiones, ['u1']);
    assert.equal(beto2.contactos.u1.instagram, undefined, 'lo oculto sigue oculto');
    const caro = (await s.llamar('/api/directorio/meta', 'GET', null, 'caro')).cuerpo;
    assert.equal(caro.viewerVip, false); assert.deepEqual(caro.contactos, {}, 'sin membresía no hay contactos (como siempre)');
  } finally { s.cerrar(); }
});

test('portada personalizada: solo VIP, color válido o foto JPEG; reset la borra', async () => {
  const s = await levantar();
  try {
    assert.equal((await s.llamar('/api/directorio/portada', 'POST', { hex: '#123abc' }, 'caro')).status, 403, 'sin membresía no hay portada');
    assert.equal((await s.llamar('/api/directorio/portada', 'POST', { hex: 'rojo' }, 'ana')).status, 400);
    assert.equal((await s.llamar('/api/directorio/portada', 'POST', { hex: '#123abc' }, 'ana')).status, 200);
    assert.equal(s.db.datos.get('directorioExtra/u1').portadaHex, '#123abc');
    const foto = 'data:image/jpeg;base64,' + 'A'.repeat(400);
    assert.equal((await s.llamar('/api/directorio/portada', 'POST', { fotoDataUrl: foto }, 'ana')).status, 200);
    assert.equal(s.db.datos.get('directorioExtra/u1').portadaFoto, foto); assert.equal(s.db.datos.get('directorioExtra/u1').portadaHex, '', 'la foto sustituye al color');
    assert.equal((await s.llamar('/api/directorio/portada', 'POST', { fotoDataUrl: 'data:image/png;base64,AAAA' }, 'ana')).status, 400, 'solo JPEG ya reducida');
    assert.equal((await s.llamar('/api/directorio/portada', 'POST', { reset: true }, 'ana')).status, 200);
    assert.equal(s.db.datos.get('directorioExtra/u1').portadaFoto, '');
  } finally { s.cerrar(); }
});

test('perfil profesional: limpieza, visibilidad por sección y certificados reales del Club', async () => {
  const doc = perfilLimpio({ sobreMi: ' Hola <b>mundo</b> ', experiencia: [{ puesto: 'Fisio', lugar: 'Clínica X', periodo: '2020-2024', descripcion: 'Rehabilitación' }, {}], visibilidad: { experiencia: 'conexiones', idiomas: 'privado', raro: 'x' } });
  assert.equal(doc.sobreMi, 'Hola mundo'); assert.equal(doc.experiencia.length, 1, 'las filas vacías se descartan');
  assert.equal(doc.visibilidad.experiencia, 'conexiones'); assert.equal(doc.visibilidad.sobreMi, 'publico');
  assert.equal(seccionVisible('conexiones', { conectado: true }), true); assert.equal(seccionVisible('privado', { conectado: true }), false);
  assert.ok(avancePerfil(doc) > 0);

  const s = await levantar({ 'certificados/F1': { uid: 'u1', folio: 'F1', cursoTitulo: 'Vendaje', emitidoEn: '2026-10-01T00:00:00Z' }, 'certificados/F2': { uid: 'u1', folio: 'F2', cursoTitulo: 'Rodilla', emitidoEn: '2026-11-01T00:00:00Z', revocado: true } });
  try {
    await s.llamar('/api/perfil', 'POST', { sobreMi: 'Fisioterapeuta con 10 años de experiencia', experiencia: [{ puesto: 'Titular', lugar: 'Clínica Movimiento', periodo: '2016-2026' }], visibilidad: { experiencia: 'conexiones', habilidades: 'privado' } }, 'ana');
    const mio = (await s.llamar('/api/perfil/mio', 'GET', null, 'ana')).cuerpo;
    assert.equal(mio.perfil.sobreMi.includes('10 años'), true); assert.equal(mio.certificados.length, 1, 'el certificado revocado no cuenta');
    assert.equal(mio.certificados[0].folio, 'F1');
    const beto = (await s.llamar('/api/perfil/u1', 'GET', null, 'beto')).cuerpo;
    assert.equal(beto.perfil.sobreMi.includes('10 años'), true, 'lo público se ve');
    assert.equal(beto.perfil.experiencia, undefined, 'lo de "solo conexiones" no, sin conectar');
    assert.equal(beto.certificados.length, 1, 'los certificados reales se ven (visibilidad pública por defecto)');
    await s.llamar('/api/red/solicitar', 'POST', { uid: 'u1' }, 'beto');
    await s.llamar('/api/red/u2/aceptar', 'POST', null, 'ana');
    const beto2 = (await s.llamar('/api/perfil/u1', 'GET', null, 'beto')).cuerpo;
    assert.equal(beto2.perfil.experiencia.length, 1, 'ya conectados, la sección "solo conexiones" sí se ve');
    assert.equal(beto2.conectado, true);
    assert.equal((await s.llamar('/api/perfil/u9', 'GET', null, 'beto')).status, 404, 'sin tarjeta publicada no hay perfil');
    // tarjeta despublicada → el perfil deja de verse
    s.db.datos.set('directorio/u1', { nombre: 'Ana Torres', publicado: false });
    assert.equal((await s.llamar('/api/perfil/u1', 'GET', null, 'beto')).status, 404);
  } finally { s.cerrar(); }
});
