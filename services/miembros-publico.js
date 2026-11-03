// Contador público de miembros del Club: cuenta los miembros con membresía vigente (activa, pagada o cancelada pero aún dentro de su periodo).
// Solo devuelve un número, sin datos de nadie. Se calcula con un conteo agregado de Firestore (1 lectura por cada 1000 miembros) y se guarda en memoria 10 minutos.
const ESTADOS = ['active', 'paid', 'cancelled'];
const CACHE_MS = 10 * 60 * 1000;

function crearMiembrosPublico({ db, ahora = Date.now }) {
  let cache = { n: null, ms: 0 };
  async function contar() {
    if (cache.n !== null && ahora() - cache.ms < CACHE_MS) return cache.n;
    const r = await db.collection('members').where('status', 'in', ESTADOS).count().get();
    const n = Number(r.data().count);
    cache = { n: Number.isFinite(n) && n >= 0 ? n : 0, ms: ahora() };
    return cache.n;
  }
  function montarRutas(app) {
    app.get('/api/miembros-publico', async (req, res) => {
      try { res.set('Cache-Control', 'public, max-age=300'); res.json({ miembros: await contar() }); }
      catch (e) { console.error('[miembros-publico]', e && e.message); res.status(503).json({ error: 'No disponible por ahora.' }); }
    });
  }
  return { contar, montarRutas, ESTADOS };
}
module.exports = { crearMiembrosPublico };
