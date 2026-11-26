'use strict';
// PERFIL PROFESIONAL (CV) del Directorio, como ICADEM: además de la tarjeta, cada miembro tiene un currículum
// con secciones, y cada sección con su propia visibilidad: 'publico' (todos los miembros), 'conexiones' o 'privado'.
//   - Vive en `perfilProfesional/{uid}` y SOLO lo lee y escribe el servidor (el navegador habla con /api/perfil).
//   - La sección «Certificados FisioTeck» no se edita: sale de los certificados reales del Club (con folio verificable).
// Rutas:
//   GET  /api/perfil/mio        → el perfil propio completo, con visibilidad, para editarlo
//   POST /api/perfil            → guarda secciones y visibilidad
//   GET  /api/perfil/:uid       → el perfil de otra persona, filtrado según su visibilidad y si están conectados
const { esAdminPorToken } = require('./certificados');

const COL = 'perfilProfesional';
const VISIBILIDADES = ['publico', 'conexiones', 'privado'];
// Secciones de listas: campos permitidos y límites por campo
const LISTAS = {
  experiencia: { max: 10, campos: { puesto: 80, lugar: 80, periodo: 40, descripcion: 300 } },
  formacion: { max: 10, campos: { titulo: 100, escuela: 90, periodo: 40 } },
  idiomas: { max: 8, campos: { idioma: 40, nivel: 40 } },
  habilidades: { max: 15, campos: { nombre: 60 } },
  certificacionesExternas: { max: 10, campos: { nombre: 100, emisor: 80, anio: 10 } },
  proyectos: { max: 8, campos: { nombre: 90, descripcion: 240, enlace: 160 } },
  enlaces: { max: 6, campos: { titulo: 60, url: 160 } }
};
const SECCIONES = ['sobreMi', 'experiencia', 'formacion', 'idiomas', 'habilidades', 'certificaciones', 'certificacionesExternas', 'proyectos', 'enlaces'];
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const texto = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const parrafo = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/<[^>]*>/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

// Valida y limpia el cuerpo que manda el navegador. Devuelve el documento listo para guardar.
function perfilLimpio(body) {
  const b = body && typeof body === 'object' ? body : {};
  const doc = { sobreMi: parrafo(b.sobreMi, 600) };
  for (const [nombre, regla] of Object.entries(LISTAS)) {
    const lista = Array.isArray(b[nombre]) ? b[nombre].slice(0, regla.max) : [];
    doc[nombre] = lista.map(fila => {
      const limpia = {};
      for (const [campo, max] of Object.entries(regla.campos)) limpia[campo] = campo === 'descripcion' ? parrafo((fila || {})[campo], max) : texto((fila || {})[campo], max);
      return limpia;
    }).filter(f => Object.values(f).some(v => v));
  }
  doc.visibilidad = {};
  const vis = (b.visibilidad && typeof b.visibilidad === 'object') ? b.visibilidad : {};
  SECCIONES.forEach(s => { doc.visibilidad[s] = VISIBILIDADES.includes(vis[s]) ? vis[s] : 'publico'; });
  return doc;
}

// ¿Esta sección se muestra a quien mira?
function seccionVisible(visibilidad, { duenio = false, admin = false, conectado = false } = {}) {
  if (duenio || admin) return true;
  const v = VISIBILIDADES.includes(visibilidad) ? visibilidad : 'publico';
  if (v === 'privado') return false;
  if (v === 'conexiones') return conectado;
  return true;
}

// Avance del perfil: cuántas de las secciones principales ya tienen contenido (para la barra «Perfil completo»)
function avancePerfil(doc) {
  const partes = [!!doc.sobreMi, doc.experiencia.length > 0, doc.formacion.length > 0, doc.idiomas.length > 0, doc.habilidades.length > 0, (doc.proyectos.length + doc.enlaces.length + doc.certificacionesExternas.length) > 0];
  return Math.round(partes.filter(Boolean).length / partes.length * 100);
}

// deps: { db, admin, tieneMembresia, conectadosDe }
function montarRutasPerfil(app, deps) {
  const { db, admin } = deps;

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  const envolver = (etiqueta, fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { const d = await sesion(req, res); if (d) await fn(req, res, d); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[perfil ' + etiqueta + ']', e && e.message);
      res.status(500).json({ error: 'No se pudo completar la operación.' });
    }
  };
  const leerDoc = async uid => { const s = await db.collection(COL).doc(String(uid)).get(); return perfilLimpio(s.exists ? (s.data() || {}) : {}); };
  // Certificados REALES del Club (no editables): curso, fecha y folio verificable
  async function certificadosDe(uid) {
    try {
      const sn = await db.collection('certificados').where('uid', '==', uid).get();
      return sn.docs.map(x => ({ id: x.id, ...(x.data() || {}) })).filter(c => !c.revocado)
        .map(c => ({ curso: c.cursoTitulo || c.curso || 'Curso FisioTeck', folio: c.folio || c.id, fecha: String(c.emitidoEn || '').slice(0, 10) }))
        .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 30);
    } catch (_) { return []; }
  }

  app.get('/api/perfil/mio', envolver('mio', async (req, res, d) => {
    const doc = await leerDoc(d.uid);
    res.json({ ok: true, perfil: doc, certificados: await certificadosDe(d.uid), avance: avancePerfil(doc) });
  }));

  app.post('/api/perfil', envolver('guardar', async (req, res, d) => {
    const doc = perfilLimpio(req.body);
    await db.collection(COL).doc(d.uid).set({ ...doc, uid: d.uid, actualizadoMs: Date.now() });
    res.json({ ok: true, avance: avancePerfil(doc) });
  }));

  app.get('/api/perfil/:uid', envolver('ver', async (req, res, d) => {
    const uid = String(req.params.uid || '').trim();
    const duenio = uid === d.uid, admin_ = esAdminPorToken(d);
    // El perfil de otra persona solo se ve si su tarjeta está publicada (misma regla que el directorio)
    if (!duenio) {
      const t = await db.collection('directorio').doc(uid).get();
      const v = t.exists ? (t.data() || {}) : null;
      if (!v || v.publicado !== true || v.visible === false) throw errorHttp(404, 'Ese perfil no está disponible.');
      const mod = await db.collection('directorioModeracion').doc(uid).get();
      if (mod.exists && (mod.data() || {}).oculta === true) throw errorHttp(404, 'Ese perfil no está disponible.');
    }
    let conectado = false;
    try { if (!duenio && deps.conectadosDe) conectado = (await deps.conectadosDe(d.uid)).includes(uid); } catch (_) { /* sin red */ }
    const quien = { duenio, admin: admin_, conectado };
    const doc = await leerDoc(uid);
    const salida = { visibilidad: duenio ? doc.visibilidad : undefined };
    SECCIONES.forEach(s => {
      if (s === 'certificaciones') return;
      if (seccionVisible(doc.visibilidad[s], quien)) salida[s] = doc[s];
    });
    const conCerts = seccionVisible(doc.visibilidad.certificaciones, quien);
    res.json({ ok: true, perfil: salida, certificados: conCerts ? await certificadosDe(uid) : [], conectado, avance: avancePerfil(doc) });
  }));
}

module.exports = { montarRutasPerfil, perfilLimpio, seccionVisible, avancePerfil, SECCIONES, VISIBILIDADES, LISTAS };
