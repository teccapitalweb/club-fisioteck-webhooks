// MODO DEMO LOCAL: arranca el server.js REAL del Club con Firebase y Stripe SIMULADOS (todo en memoria).
// Sirve para ver y probar el Club y el panel en tu computadora SIN llaves reales y sin tocar nada de producción.
//   · Inicias sesión en el Club con tu cuenta de siempre (Google o correo); el servidor demo acepta tu sesión SOLO en este modo local.
//   · Tu cuenta se crea como miembro activo (DEMO_PLAN=free para verla como cuenta gratuita). Los correos de administrador de
//     ADMIN_EMAILS (por defecto teccapitalweb@gmail.com y fisiotec25@gmail.com) entran al panel de administración.
//   · Los datos viven en la memoria: al cerrar la ventana se borran. No se envía ningún correo ni se cobra nada.
// Uso:  node scripts/demo-local.js
// GUARDA_PRODUCCION: este servidor acepta cualquier sesión sin firma (solo para ver el Club en tu computadora). Nunca debe correr en un servidor real.
if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) { console.error('demo-local.js no puede ejecutarse en producción.'); process.exit(1); }
const Module = require('module');
const path = require('path');
const SERVER = path.join(__dirname, '..', 'server.js');

// ---------- Firestore en memoria ----------
const datos = new Map();
const SENT = { ts: { t: 'ts' }, del: { t: 'del' } };
const resolver = (v, previo) => {
  if (v && v.__op === 'ts') return Date.now();
  if (v && v.__op === 'inc') return (typeof previo === 'number' ? previo : 0) + v.n;
  if (v && v.__op === 'union') return [...new Set([...(Array.isArray(previo) ? previo : []), ...v.items])];
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) { const o = {}; for (const k of Object.keys(v)) { const r = resolver(v[k], previo && previo[k]); if (!(v[k] && v[k].__op === 'del')) o[k] = r; } return o; }
  return v;
};
const clonar = v => JSON.parse(JSON.stringify(v));
function aplicar(ruta, v, merge) {
  const previo = datos.get(ruta);
  if (!merge) { datos.set(ruta, clonar(resolver(v, undefined))); return; }
  const base = previo ? clonar(previo) : {};
  for (const k of Object.keys(v)) {
    if (v[k] && v[k].__op === 'del') { delete base[k]; continue; }
    const nuevo = resolver(v[k], base[k]);
    base[k] = (nuevo && typeof nuevo === 'object' && !Array.isArray(nuevo) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && !(v[k] && v[k].__op)) ? { ...base[k], ...nuevo } : nuevo;
  }
  datos.set(ruta, clonar(base));
}
function actualizar(ruta, v) {
  if (!datos.has(ruta)) throw new Error('NOT_FOUND: ' + ruta);
  const base = clonar(datos.get(ruta));
  for (const k of Object.keys(v)) {
    if (v[k] && v[k].__op === 'del') { delete base[k]; continue; }
    base[k] = resolver(v[k], base[k]);
  }
  datos.set(ruta, base);
}
const snapDoc = ruta => { const v = datos.get(ruta); return { exists: v !== undefined, id: ruta.split('/').pop(), ref: docRef(ruta), data: () => (v === undefined ? undefined : clonar(v)) }; };
function docRef(ruta) {
  return {
    id: ruta.split('/').pop(), path: ruta,
    get: async () => snapDoc(ruta), set: async (v, o) => aplicar(ruta, v, !!(o && o.merge)), update: async v => actualizar(ruta, v), delete: async () => { datos.delete(ruta); },
    collection: n => colRef(ruta + '/' + n)
  };
}
function colRef(nombre) {
  const filtros = []; let lim = 1e9, orden = null, dir = 'asc';
  const q = {
    doc: id => docRef(nombre + '/' + (id || Math.random().toString(36).slice(2))),
    where(c, op, val) { filtros.push([c, op, val]); return q; },
    orderBy(c, d) { orden = c; dir = d || 'asc'; return q; }, limit(n) { lim = n; return q; },
    async get() {
      const prof = nombre.split('/').length + 1;
      let docs = [...datos.keys()].filter(k => k.startsWith(nombre + '/') && k.split('/').length === prof).map(snapDoc)
        .filter(d => filtros.every(([c, op, val]) => { const x = c.split('.').reduce((a, p) => (a == null ? a : a[p]), d.data()); return op === '==' ? x === val : op === '>' ? x > val : op === '>=' ? x >= val : op === '<' ? x < val : true; }));
      if (orden) docs.sort((a, b) => { const x = a.data()[orden], y = b.data()[orden]; return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'desc' ? -1 : 1); });
      docs = docs.slice(0, lim);
      return { docs, empty: !docs.length, size: docs.length, forEach: f => docs.forEach(f) };
    }
  };
  return q;
}
const firestoreFn = () => ({
  collection: colRef, doc: docRef,
  async runTransaction(fn) {
    const escrituras = [];
    const tx = { get: async r => (r.get ? r.get() : r), set: (r, v, o) => escrituras.push(() => r.set(v, o)), update: (r, v) => escrituras.push(() => r.update(v)), delete: r => escrituras.push(() => r.delete()) };
    const salida = await fn(tx);
    for (const e of escrituras) await e();
    return salida;
  },
  async getAll(...refs) { return Promise.all(refs.map(r => r.get())); },
  batch() { const e = []; return { set: (r, v, o) => e.push(() => r.set(v, o)), update: (r, v) => e.push(() => r.update(v)), delete: r => e.push(() => r.delete()), commit: async () => { for (const f of e) await f(); } }; }
});
firestoreFn.FieldValue = { serverTimestamp: () => ({ __op: 'ts' }), increment: n => ({ __op: 'inc', n }), arrayUnion: (...items) => ({ __op: 'union', items }), arrayRemove: () => ({ __op: 'del' }), delete: () => ({ __op: 'del' }) };
firestoreFn.FieldPath = { documentId: () => '__name__' };

// ---------- Auth simulado ----------
const tokens = {};
const usuariosAuth = {};
const decodificar = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return null; } };
const authFn = () => ({
  verifyIdToken: async t => {
    const p = decodificar(t);
    if (!p || !(p.user_id || p.sub)) throw new Error('token inválido');
    const uid = p.user_id || p.sub, email = String(p.email || '').toLowerCase();
    usuariosAuth[uid] = { uid, email, emailVerified: p.email_verified !== false, displayName: p.name || '', metadata: { creationTime: new Date().toUTCString() } };
    if (!datos.has('members/' + uid)) {
      const hoy = new Date().toISOString().split('T')[0], activo = process.env.DEMO_PLAN ? (process.env.DEMO_PLAN === 'active' && !uid.startsWith('free')) : uid.startsWith('vip'); // por defecto solo las cuentas ?demo=vip son miembros; tu cuenta de Google se ve como gratuita, igual que en el Club // el modo ?demo=free del Club crea una cuenta gratuita
      const fin = new Date(Date.now() + 30 * 864e5).toISOString().split('T')[0];
      aplicar('members/' + uid, activo
        ? { name: p.name || email.split('@')[0], email, startDate: hoy, status: 'active', plan: 'mensual', payments: [{ date: hoy, amount: 199, status: 'paid', concept: 'Membresía mensual' }], nextPaymentDate: fin, createdAt: Date.now() }
        : { name: p.name || email.split('@')[0], email, startDate: hoy, status: 'registered', createdAt: Date.now() }, false);
    }
    return { uid, email, name: p.name || '', email_verified: p.email_verified !== false };
  },
  getUsers: async ids => ({ users: ids.map(x => usuariosAuth[x.uid]).filter(Boolean), notFound: [] }),
  getUser: async uid => usuariosAuth[uid] || { uid, metadata: { creationTime: new Date().toUTCString() } },
  getUserByEmail: async e => { const u = Object.values(usuariosAuth).find(x => x.email === e); if (!u) throw new Error('no existe'); return u; },
  generateEmailVerificationLink: async () => 'http://localhost:8080/?modo=verifyEmail&oobCode=demo',
  generatePasswordResetLink: async () => 'http://localhost:8080/?modo=resetPassword&oobCode=demo'
});
const adminFalso = { initializeApp() {}, credential: { cert: () => ({}) }, firestore: firestoreFn, auth: authFn };
const stripeFalso = () => ({ checkout: { sessions: { create: async () => ({}), retrieve: async () => ({}) } }, webhooks: { constructEvent: () => ({}) }, subscriptions: { retrieve: async () => ({}), cancel: async () => ({}) } });

const original = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return adminFalso;
  if (request === 'stripe') return stripeFalso;
  return original.apply(this, arguments);
};

process.env.FIREBASE_SERVICE_ACCOUNT = '{"project_id":"demo-local"}';
process.env.STRIPE_SECRET_KEY = 'sk_test_demo';
process.env.CERT_SIGNING_KEY = process.env.CERT_SIGNING_KEY || 'llave-demo-local-1234567890';
process.env.PORT = process.env.PORT || '3000';
process.env.CLUB_URL = 'http://localhost:8080';
datos.set('config/club', { precioMes: 199, precioAno: 1999, escalonadoActivo: true, escalonadoDias: 8, retosParaAdelantar: 12 }); // cursos escalonados encendidos para ver los candados y el adelanto por retos
// Directorio de ejemplo: dir1 es miembro VIP verificado con contacto y un certificado; dir2 y dir3 son de la comunidad
datos.set('members/dir1', { name: 'Laura Méndez', email: 'laura@ejemplo.mx', status: 'active', plan: 'mensual', startDate: new Date().toISOString().split('T')[0], payments: [{ date: new Date().toISOString().split('T')[0], amount: 199, status: 'paid', concept: 'Membresía mensual' }], nextPaymentDate: new Date(Date.now() + 30 * 864e5).toISOString().split('T')[0] });
datos.set('directorioContacto/dir1', { uid: 'dir1', whatsapp: '2221234567', email: 'laura@ejemplo.mx', instagram: '@laura.fisio', linkedin: 'linkedin.com/in/lauramendez' });
datos.set('directorioContacto/dir2', { uid: 'dir2', whatsapp: '5512345678' });
['dir1','dir2','dir3'].forEach(k => datos.set('directorio/' + k, { publicado: true, nombre: k }));
// Libros y foro de ejemplo (solo demo)
datos.set('forum_posts/p-demo', { authorId: 'vip-demo', title: 'Dolor de hombro en nadadora: ¿por dónde empiezo?', body: 'Paciente de 24 años...' });
datos.set('forum_posts/p-demo/replies/r-demo', { authorId: 'beto-demo', authorName: 'Beto R.', body: 'Yo empezaría con control escapular y educación del dolor antes de la cápsula posterior.' });
datos.set('certificados/demo1', { uid: 'dir1', revocado: false });
// Juegos de clase de ejemplo (solo demo) en el curso «Estimulación neuroplástica…»: una clase por tipo de juego, más preguntas en la clase 1
datos.set('juegosCurso/1777912123479', { courseId: '1777912123479', clases: {
  0: { tipo: 'sopa_letras', datos: { palabras: ['NEURONA', 'SINAPSIS', 'CORTEZA', 'REFLEJO', 'AXON', 'MIELINA'] } },
  1: { tipo: 'memorama', datos: { pares: [{ termino: 'Neuroplasticidad', definicion: 'Capacidad del cerebro de reorganizarse' }, { termino: 'Sinapsis', definicion: 'Unión entre dos neuronas' }, { termino: 'Corteza motora', definicion: 'Área que planea el movimiento voluntario' }, { termino: 'Mielina', definicion: 'Capa que acelera el impulso nervioso' }] } },
  2: { tipo: 'rompecabezas', datos: { dificultad: '3', imagenUrl: '' } },
  3: { tipo: 'ahorcado', datos: { palabras: [{ palabra: 'Plasticidad', pista: 'Cambio adaptativo del sistema nervioso' }, { palabra: 'Bobath', pista: 'Concepto de neurorrehabilitación' }] } }
} });
datos.set('preguntasCurso/1777912123479', { courseId: '1777912123479', clases: { 0: [{ tipo: 'multiple', pregunta: '¿Qué es la neuroplasticidad?', opciones: ['Un tipo de fractura', 'La capacidad de reorganización del sistema nervioso', 'Un fármaco'], correcta: 1 }, { tipo: 'vof', pregunta: 'La sinapsis une dos neuronas.', correcta: 0 }] } });
console.log('');
console.log('  MODO DEMO LOCAL · servidor del Club en http://localhost:' + process.env.PORT);
console.log('  Firebase y Stripe simulados: los datos viven en memoria y se borran al cerrar. Plan de tu cuenta: ' + ((process.env.DEMO_PLAN || 'active') === 'free' ? 'cuenta gratuita' : 'miembro activo'));
console.log('');
globalThis.__harness = { datos, usuariosAuth };
require(SERVER);
