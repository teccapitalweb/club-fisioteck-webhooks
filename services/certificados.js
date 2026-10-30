// Certificados del Club FisioTeck: emisión, verificación pública y PDF.
// El servidor decide todo: el navegador solo pide el certificado; aquí se comprueba que el curso esté
// terminado en members/{uid}/progress/courses, se firma con CERT_SIGNING_KEY y se guarda en certificados/{folio}.
// Las rutas de administrador (/api/admin/*) exigen un correo de ADMIN_EMAILS con correo verificado.
const crypto = require('crypto');

const ADMIN_EMAILS_POR_DEFECTO = 'teccapitalweb@gmail.com,fisiotec25@gmail.com';
const URL_VERIFICAR = 'https://club.fisioteck.com/verificar/';

function correosAdministrador() {
  return new Set(String(process.env.ADMIN_EMAILS || ADMIN_EMAILS_POR_DEFECTO)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

function esAdminPorToken(decoded) {
  return Boolean(decoded && decoded.email_verified === true && typeof decoded.email === 'string'
    && correosAdministrador().has(decoded.email.trim().toLowerCase()));
}

// ── Folio, firma y nombre ──
function folioCertificado(uid, cursoId) {
  const h = crypto.createHash('sha256').update(String(uid) + ':' + String(cursoId)).digest('hex').slice(0, 8).toUpperCase();
  return 'FT-' + h.slice(0, 4) + '-' + h.slice(4);
}

function normalizarFolio(valor) {
  return String(valor || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function datosFirma(c) {
  return [c.folio, c.uid, c.cursoId, c.nombre, c.emitidoEn].join('|');
}

function firmar(cert, llave) {
  return crypto.createHmac('sha256', llave).update(datosFirma(cert)).digest('hex');
}

function firmaValida(cert, llave) {
  if (!cert || !cert.firma || !llave) return false;
  const esperada = Buffer.from(firmar(cert, llave), 'hex');
  const recibida = Buffer.from(String(cert.firma), 'hex');
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

function validarNombre(entrada) {
  const limpio = String(entrada || '').replace(/\s+/g, ' ').trim();
  if (limpio.length < 5 || limpio.length > 80) return { ok: false, error: 'Escribe tu nombre completo como quieres verlo en el certificado.' };
  if (!/^[\p{L}][\p{L}'.\- ]*$/u.test(limpio)) return { ok: false, error: 'El nombre solo puede llevar letras, espacios, guion y apóstrofo.' };
  if (limpio.split(' ').filter(p => p.length > 1).length < 2) return { ok: false, error: 'Escribe nombre y apellido.' };
  const nombre = limpio.split(' ').map(p => p.charAt(0).toLocaleUpperCase('es-MX') + p.slice(1).toLocaleLowerCase('es-MX')).join(' ');
  return { ok: true, nombre };
}

function certificadoPublico(c) {
  return {
    folio: c.folio, nombre: c.nombre, cursoId: c.cursoId, curso: c.cursoTitulo,
    clases: c.clases || null, emitidoEn: c.emitidoEn, origen: c.origen || 'club'
  };
}

// ── Avance ──
function cursoDeCatalogo(catalogo, cursoId) {
  return (catalogo.courses || []).find(c => String(c.courseId) === String(cursoId)) || null;
}

function clasesCompletadas(progreso, cursoId, totalClases) {
  const reg = progreso && progreso['c_' + cursoId];
  const lista = Array.isArray(reg && reg.completed) ? reg.completed : [];
  return new Set(lista.filter(i => Number.isInteger(i) && i >= 0 && i < totalClases)).size;
}

function resumenProgreso(progreso, catalogo) {
  return (catalogo.courses || []).map(c => {
    const total = (c.lessons || []).length;
    const hechas = clasesCompletadas(progreso, c.courseId, total);
    return { cursoId: c.courseId, titulo: c.title, total, hechas, completo: total > 0 && hechas >= total };
  });
}

function construirCertificado({ uid, curso, nombre, email, origen, emitidoPor, ahora }, llave) {
  const cert = {
    folio: folioCertificado(uid, curso.courseId), uid, cursoId: String(curso.courseId), cursoTitulo: curso.title,
    clases: (curso.lessons || []).length, nombre, email: email || '', origen: origen || 'club',
    emitidoEn: (ahora || new Date()).toISOString(), revocado: false
  };
  if (emitidoPor) cert.emitidoPor = emitidoPor;
  cert.firma = firmar(cert, llave);
  return cert;
}

// ── Rutas ──
// deps: { db, admin (firebase-admin), cargarCatalogo(), generarPdf?(cert) }
function montarRutasCertificados(app, deps) {
  const { db, admin } = deps;
  const { crearAviso } = require('./avisos');
  const avisoCertificado = cert => crearAviso(db, cert.uid, 'cert_' + cert.folio, { tipo: 'certificado', titulo: '¡Certificado emitido!', texto: cert.cursoTitulo + ' · folio ' + cert.folio, pagina: 'certificates' });
  const col = () => db.collection('certificados');

  async function sesion(req, res) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) { res.status(401).json({ error: 'Inicia sesión para continuar.' }); return null; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); return null; }
  }
  async function sesionAdmin(req, res) {
    const d = await sesion(req, res); if (!d) return null;
    if (!esAdminPorToken(d)) { res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' }); return null; }
    return d;
  }
  const conAdmin = fn => async (req, res) => {
    try { const d = await sesionAdmin(req, res); if (d) await fn(req, res, d); }
    catch (e) { console.error('[admin]', req.path, e.message); res.status(500).json({ error: 'No se pudo completar la operación.' }); }
  };
  const conSesion = fn => async (req, res) => {
    try { const d = await sesion(req, res); if (d) await fn(req, res, d); }
    catch (e) { console.error('[certificados]', req.path, e.message); res.status(500).json({ error: 'No se pudo completar la operación.' }); }
  };
  const llave = () => process.env.CERT_SIGNING_KEY || '';
  const sinLlave = res => res.status(503).json({ error: 'Los certificados todavía no están configurados en el servidor (CERT_SIGNING_KEY).' });

  async function leerProgreso(uid) {
    const s = await db.collection('members').doc(uid).collection('progress').doc('courses').get();
    return s.exists ? (s.data() || {}) : {};
  }

  // ----- Emisión automática al terminar un curso (como Alintec Food) -----
  // Se emite con el nombre del perfil si ya sirve como nombre completo; si no, devuelve requiereNombre y la persona lo escribe.
  // confirmarNombre = es el PRIMER certificado de la cuenta y aún no se confirmó el nombre: el Club pregunta "¿tu certificado debe llevar este nombre?".
  async function emitirAuto({ uid, email, curso, nombreCandidato, sinCorreo }) {
    if (!llave()) return { sinLlave: true };
    const previo = await col().doc(folioCertificado(uid, curso.courseId)).get();
    const miembro = (await db.collection('members').doc(uid).get()).data() || {};
    const confirmarNombre = !miembro.nombreCertificadoConfirmadoEn;
    if (previo.exists && !previo.data().revocado) return { certificado: certificadoPublico(previo.data()), nuevo: false, confirmarNombre: false };
    if (previo.exists) return { revocado: true };
    const v = validarNombre(nombreCandidato || miembro.name);
    if (!v.ok) return { requiereNombre: true, confirmarNombre: false };
    const cert = construirCertificado({ uid, curso, nombre: v.nombre, email, origen: 'club' }, llave());
    await col().doc(cert.folio).set(cert);
    avisoCertificado(cert);
    if (deps.enviarCorreoCertificado && !sinCorreo) Promise.resolve().then(() => deps.enviarCorreoCertificado(cert)).catch(e => console.warn('[certificados] correo:', e && e.message));
    return { certificado: certificadoPublico(cert), nuevo: true, confirmarNombre };
  }
  deps.emitirCertificadoAuto = emitirAuto;

  // Confirmar o corregir el nombre del PRIMER certificado: se guarda en el certificado (se vuelve a firmar), en el perfil y en la cuenta de acceso.
  // Solo se pide una vez por cuenta; después el nombre del certificado ya no se cambia.
  app.post('/api/certificados/:folio/nombre', conSesion(async (req, res, d) => {
    if (!llave()) return sinLlave(res);
    const ref = col().doc(normalizarFolio(req.params.folio)), snap = await ref.get();
    if (!snap.exists || snap.data().uid !== d.uid || snap.data().revocado) return res.status(404).json({ error: 'No encontramos ese certificado.' });
    const mRef = db.collection('members').doc(d.uid), miembro = (await mRef.get()).data() || {};
    const propios = (await col().where('uid', '==', d.uid).get()).docs.filter(x => !(x.data() || {}).revocado);
    if (miembro.nombreCertificadoConfirmadoEn || propios.length > 1) return res.status(409).json({ error: 'El nombre de tu certificado ya estaba confirmado.' });
    const v = validarNombre(req.body && req.body.nombre);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const cert = { ...snap.data(), nombre: v.nombre }; delete cert.firma; cert.firma = firmar(cert, llave());
    await ref.set(cert);
    await mRef.set({ name: v.nombre, nombreCertificadoConfirmadoEn: new Date().toISOString() }, { merge: true });
    try { if (admin && admin.auth && admin.auth().updateUser) await admin.auth().updateUser(d.uid, { displayName: v.nombre }); } catch (e) { console.warn('[certificados] nombre de la cuenta:', e && e.message); }
    res.json({ ok: true, nombre: v.nombre, certificado: certificadoPublico(cert) });
  }));

  // ----- Socio -----
  app.get('/api/certificados/mios', conSesion(async (req, res, d) => {
    // Cursos que la persona ya terminó antes de que existieran los certificados automáticos (miembros antiguos): se emiten ahora, sin correo.
    if (llave()) {
      try {
        const prog = await leerProgreso(d.uid), miembro = (await db.collection('members').doc(d.uid).get()).data() || {};
        for (const curso of (deps.cargarCatalogo().courses || [])) {
          const total = (curso.lessons || []).length;
          if (total > 0 && clasesCompletadas(prog, curso.courseId, total) >= total) await emitirAuto({ uid: d.uid, email: d.email, curso, nombreCandidato: miembro.name || d.name, sinCorreo: true });
        }
      } catch (e) { console.warn('[certificados] retroactivos:', e && e.message); }
    }
    const sn = await col().where('uid', '==', d.uid).get();
    const lista = sn.docs.map(x => x.data()).filter(c => !c.revocado).sort((a, b) => String(b.emitidoEn).localeCompare(String(a.emitidoEn)));
    res.json({ certificados: lista.map(certificadoPublico) });
  }));

  app.post('/api/certificados/emitir', conSesion(async (req, res, d) => {
    if (!llave()) return sinLlave(res);
    const { courseId, nombre } = req.body || {};
    const curso = cursoDeCatalogo(deps.cargarCatalogo(), courseId);
    if (!curso) return res.status(404).json({ error: 'Ese curso no existe.' });
    const total = (curso.lessons || []).length;
    const hechas = clasesCompletadas(await leerProgreso(d.uid), curso.courseId, total);
    if (!total || hechas < total) return res.status(409).json({ error: 'Aún faltan clases por completar (' + hechas + ' de ' + total + ').' });

    const previo = await col().doc(folioCertificado(d.uid, curso.courseId)).get();
    if (previo.exists && !previo.data().revocado) return res.json({ certificado: certificadoPublico(previo.data()), nuevo: false });
    if (previo.exists && previo.data().revocado) return res.status(403).json({ error: 'Este certificado fue revocado. Escríbenos para revisarlo.' });

    const v = validarNombre(nombre);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const cert = construirCertificado({ uid: d.uid, curso, nombre: v.nombre, email: d.email, origen: 'club' }, llave());
    await col().doc(cert.folio).set(cert);
    avisoCertificado(cert);
    // El nombre confirmado en la tarjeta del certificado también queda como nombre del perfil (socio y cuenta de acceso)
    try {
      await db.collection('members').doc(d.uid).set({ name: cert.nombre, nombreCertificadoConfirmadoEn: new Date().toISOString() }, { merge: true });
      if (admin && admin.auth && admin.auth().updateUser) await admin.auth().updateUser(d.uid, { displayName: cert.nombre });
    } catch (e) { console.warn('[certificados] no se pudo actualizar el nombre del perfil:', e && e.message); }
    res.status(201).json({ certificado: certificadoPublico(cert), nuevo: true });
    // Correo con el PDF adjunto (una sola vez, al emitirse). Si falla no afecta al certificado.
    if (deps.enviarCorreoCertificado) Promise.resolve().then(() => deps.enviarCorreoCertificado(cert)).catch(e => console.warn('[certificados] correo:', e && e.message));
  }));

  // ----- Público: verificación y PDF -----
  app.get('/api/certificados/:folio', async (req, res) => {
    try {
      if (!llave()) return sinLlave(res);
      const snap = await col().doc(normalizarFolio(req.params.folio)).get();
      if (!snap.exists) return res.status(404).json({ valido: false, error: 'No encontramos un certificado con ese folio.' });
      const c = snap.data();
      if (c.revocado) return res.json({ valido: false, revocado: true });
      if (!firmaValida(c, llave())) return res.json({ valido: false, error: 'La firma del certificado no coincide.' });
      res.json({ valido: true, certificado: certificadoPublico(c) });
    } catch (e) { console.error('[certificados] verificar', e.message); res.status(500).json({ error: 'No se pudo verificar.' }); }
  });

  app.get('/api/certificados/:folio/pdf', async (req, res) => {
    try {
      if (!llave()) return sinLlave(res);
      const snap = await col().doc(normalizarFolio(req.params.folio)).get();
      if (!snap.exists || snap.data().revocado || !firmaValida(snap.data(), llave())) return res.status(404).json({ error: 'Certificado no disponible.' });
      const c = snap.data();
      const pdf = await (deps.generarPdf || require('./certificado-pdf').generarPdf)(c, URL_VERIFICAR + '?folio=' + encodeURIComponent(c.folio));
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="certificado-' + c.folio + '.pdf"', 'Cache-Control': 'no-store' });
      res.send(pdf);
    } catch (e) { console.error('[certificados] pdf', e.message); res.status(500).json({ error: 'No se pudo generar el PDF.' }); }
  });

  // ----- Administrador -----
  app.get('/api/admin/yo', conAdmin(async (req, res, d) => { res.json({ admin: true, email: d.email }); }));

  app.get('/api/admin/certificados', conAdmin(async (req, res) => {
    const sn = await col().orderBy('emitidoEn', 'desc').limit(300).get();
    const lista = sn.docs.map(x => x.data());
    const porCurso = {};
    lista.filter(c => !c.revocado).forEach(c => { porCurso[c.cursoTitulo] = (porCurso[c.cursoTitulo] || 0) + 1; });
    res.json({
      total: lista.filter(c => !c.revocado).length, revocados: lista.filter(c => c.revocado).length, porCurso,
      certificados: lista.map(c => ({ ...certificadoPublico(c), email: c.email, uid: c.uid, revocado: !!c.revocado }))
    });
  }));

  app.post('/api/admin/certificados', conAdmin(async (req, res, d) => {
    if (!llave()) return sinLlave(res);
    const { uid, email, courseId, nombre } = req.body || {};
    const curso = cursoDeCatalogo(deps.cargarCatalogo(), courseId);
    if (!curso) return res.status(404).json({ error: 'Ese curso no existe.' });
    let socio = null;
    if (uid) { const s = await db.collection('members').doc(String(uid)).get(); if (s.exists) socio = { uid: s.id, ...s.data() }; }
    else if (email) { const q = await db.collection('members').where('email', '==', String(email).trim().toLowerCase()).limit(1).get(); if (!q.empty) socio = { uid: q.docs[0].id, ...q.docs[0].data() }; }
    if (!socio) return res.status(404).json({ error: 'No se encontró al miembro.' });
    const v = validarNombre(nombre || socio.name);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const cert = construirCertificado({ uid: socio.uid, curso, nombre: v.nombre, email: socio.email, origen: 'manual', emitidoPor: d.email }, llave());
    await col().doc(cert.folio).set(cert);
    avisoCertificado(cert);
    res.status(201).json({ certificado: certificadoPublico(cert) });
  }));

  app.post('/api/admin/certificados/:folio/revocar', conAdmin(async (req, res, d) => {
    const ref = col().doc(normalizarFolio(req.params.folio));
    const s = await ref.get();
    if (!s.exists) return res.status(404).json({ error: 'No existe ese folio.' });
    await ref.update({ revocado: true, revocadoPor: d.email, revocadoEn: new Date().toISOString() });
    res.json({ ok: true });
  }));

  app.get('/api/admin/progreso/:uid', conAdmin(async (req, res) => {
    const progreso = await leerProgreso(String(req.params.uid));
    res.json({ cursos: resumenProgreso(progreso, deps.cargarCatalogo()) });
  }));
}

module.exports = {
  correosAdministrador, esAdminPorToken, folioCertificado, normalizarFolio, firmar, firmaValida, validarNombre,
  certificadoPublico, cursoDeCatalogo, clasesCompletadas, resumenProgreso, construirCertificado, montarRutasCertificados
};
