'use strict';
// NOTICIAS DEL SECTOR GUARDADAS (como Alintec y Zoorigen): la tarea diaria trae lo nuevo de NewsData,
// lo guarda en Firestore (noticias/{id}) y avisa a los miembros en la campana. /api/news lee lo guardado,
// así las noticias no desaparecen cuando NewsData falla o cambia, y el panel puede listarlas y ocultarlas.
//  GET    /api/news                        (pública) las noticias guardadas, más nuevas primero
//  GET    /api/admin/noticias              lista para el panel (incluye ocultas)
//  DELETE /api/admin/noticias/:id          oculta una noticia (no se borra: se deja de mostrar)
//  POST   /api/admin/noticias/sincronizar  trae lo nuevo de NewsData ahora mismo
//  sincronizar(): la usa la tarea diaria del servidor
const crypto = require('crypto');
const { esAdminPorToken } = require('./certificados');
const { limpiarTexto } = require('./texto-seguro');

const COL = 'noticias', MAX_LISTA = 30, CACHE_MS = 10 * 60 * 1000;
const errorHttp = (status, mensaje) => { const e = new Error(mensaje); e.status = status; return e; };
const idDe = enlace => crypto.createHash('sha256').update(String(enlace)).digest('hex').slice(0, 24);
const urlHttp = u => /^https?:\/\//i.test(String(u || '')) ? String(u).slice(0, 800) : '';

function crearNoticias(deps) {
  const { db, admin } = deps;
  const ahora = deps.ahora || (() => Date.now());
  const traer = deps.traer || (url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error('NewsData ' + r.status)))));
  let cache = { articles: [], ms: 0 };

  const aArticulo = v => ({
    title: v.titulo || '', description: v.descripcion || '', content: v.contenido || '',
    url: v.enlace || '', image: v.imagen || null, publishedAt: v.fechaPub || '', source: { name: v.fuente || 'Noticias' }
  });

  async function guardadas(conOcultas) {
    const sn = await db.collection(COL).limit(200).get();
    return sn.docs.map(x => ({ id: x.id, ...x.data() }))
      .filter(v => conOcultas || v.oculta !== true)
      .sort((a, b) => (b.ms || 0) - (a.ms || 0))
      .slice(0, conOcultas ? 200 : MAX_LISTA);
  }

  // Trae lo nuevo de NewsData y lo guarda; con noticias nuevas deja UN aviso general del día en la campana
  async function sincronizar() {
    const clave = process.env.NEWSDATA_API_KEY || '';
    if (!clave) return { ok: false, motivo: 'Falta NEWSDATA_API_KEY' };
    const base = 'https://newsdata.io/api/1/news?apikey=' + clave + '&language=es&category=health&size=10&q=';
    let resultados = [];
    try { resultados = (await traer(base + encodeURIComponent('fisioterapia OR rehabilitacion OR ortopedia'))).results || []; } catch (e) { return { ok: false, motivo: e.message }; }
    if (!resultados.length) { try { resultados = (await traer(base + encodeURIComponent('medicina deportiva OR terapia fisica'))).results || []; } catch (_) { /* sin respaldo */ } }
    let nuevas = 0;
    for (const a of resultados) {
      const enlace = urlHttp(a.link); if (!enlace || !a.title) continue;
      const ref = db.collection(COL).doc(idDe(enlace));
      if ((await ref.get()).exists) continue;
      await ref.set({
        titulo: limpiarTexto(a.title, 200), descripcion: limpiarTexto(a.description, 400), contenido: limpiarTexto(a.content, 1500),
        enlace, imagen: urlHttp(a.image_url), fuente: limpiarTexto(a.source_name || 'Noticias', 80),
        fechaPub: limpiarTexto(a.pubDate, 40), ms: ahora(), oculta: false
      });
      nuevas++;
    }
    if (nuevas) {
      cache = { articles: [], ms: 0 };
      // Aviso general en la campana, uno por día como mucho (member_notifications es lo que leen todos los miembros)
      const hoy = new Date(ahora()).toISOString().slice(0, 10);
      const aviso = db.collection('member_notifications').doc('noticias_' + hoy);
      if (!(await aviso.get()).exists) {
        await aviso.set({ title: 'Noticias nuevas del sector', message: 'Hay ' + nuevas + ' noticia' + (nuevas === 1 ? '' : 's') + ' nueva' + (nuevas === 1 ? '' : 's') + ' de fisioterapia y rehabilitación en la sección Noticias.', category: 'news', createdAt: admin.firestore.Timestamp ? admin.firestore.Timestamp.fromMillis(ahora()) : { seconds: Math.floor(ahora() / 1000) } });
      }
    }
    return { ok: true, nuevas, total: resultados.length };
  }

  function montarRutas(app) {
    app.get('/api/news', async (req, res) => {
      try {
        if (!cache.articles.length || ahora() - cache.ms > CACHE_MS) cache = { articles: (await guardadas(false)).map(aArticulo), ms: ahora() };
        res.json({ articles: cache.articles });
      } catch (e) { console.error('[noticias]', e && e.message); res.status(500).json({ error: 'No se pudieron cargar las noticias.' }); }
    });

    const conAdmin = fn => async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      try {
        const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        if (!m) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
        let d; try { d = await admin.auth().verifyIdToken(m[1]); } catch (_) { return res.status(401).json({ error: 'Tu sesión no es válida o expiró.' }); }
        if (!esAdminPorToken(d)) return res.status(403).json({ error: 'Solo los administradores pueden hacer esto.' });
        await fn(req, res, d);
      } catch (e) {
        if (e && e.status) return res.status(e.status).json({ error: e.message });
        console.error('[noticias admin]', e && e.message);
        res.status(500).json({ error: 'No se pudo completar la operación.' });
      }
    };
    app.get('/api/admin/noticias', conAdmin(async (req, res) => res.json({ ok: true, noticias: await guardadas(true) })));
    app.post('/api/admin/noticias/sincronizar', conAdmin(async (req, res) => res.json(await sincronizar())));
    app.delete('/api/admin/noticias/:id', conAdmin(async (req, res) => {
      const id = String(req.params.id); if (!/^[a-f0-9]{24}$/.test(id)) throw errorHttp(400, 'Noticia inválida.');
      const ref = db.collection(COL).doc(id);
      if (!(await ref.get()).exists) throw errorHttp(404, 'Esa noticia no existe.');
      await ref.set({ oculta: true }, { merge: true });
      cache = { articles: [], ms: 0 };
      res.json({ ok: true });
    }));
  }

  return { montarRutas, sincronizar };
}

module.exports = { crearNoticias };
