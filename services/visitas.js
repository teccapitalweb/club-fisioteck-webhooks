'use strict';

// ══ MÉTRICAS DE VISITAS ═══════════════════════════════════════
// Contador anónimo y sin cookies del tráfico de FisioTeck (landing, acceso al Club, Club y páginas legales). Igual que en Alintec Food.
//  · No se guarda la IP ni el navegador: solo un identificador que cambia cada día
//    (HMAC de IP + navegador con una clave privada y la fecha), suficiente para contar
//    "visitantes únicos" del día y imposible de seguir de un día a otro.
//  · Las personas con sesión iniciada (miembros) sí quedan identificadas por su cuenta,
//    para que el administrador vea quién entra al panel. Los administradores no cuentan.
//  · Todo se escribe desde el servidor: el navegador nunca toca estas colecciones.

const crypto = require('crypto');
const net = require('net');

const ZONA = 'America/Mexico_City';
const PAGINAS = ['landing', 'acceso', 'club', 'legal', 'verificar'];
const DISPOSITIVOS = ['movil', 'tablet', 'computadora'];
const FUENTES = ['directo', 'interno', 'google', 'bing', 'duckduckgo', 'yahoo', 'facebook', 'instagram', 'meta', 'whatsapp', 'linkedin', 'x', 'youtube', 'tiktok', 'correo', 'otros'];
const DIAS_HISTORIAL = 84; // 12 semanas: rango por defecto del panel
const DIAS_MAX = 730;        // lo máximo que puede pedir el panel (2 años)
const DIAS_ACTIVIDAD_MIEMBRO = 400; // días de actividad que se conservan por miembro

const formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });
const formatoHora = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hourCycle: 'h23' });

// 'YYYY-MM-DD' en hora de México (el día de las métricas cambia a medianoche de México)
function claveDia(fecha) {
  return formatoDia.format(fecha instanceof Date ? fecha : new Date(fecha));
}
function horaMexico(fecha) {
  return formatoHora.format(fecha instanceof Date ? fecha : new Date(fecha)).slice(0, 2);
}
// Suma días a una clave 'YYYY-MM-DD' sin depender de la zona horaria del servidor
function sumarDias(clave, n) {
  const [a, m, d] = String(clave).split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + n));
  return f.toISOString().slice(0, 10);
}
function esClaveDia(valor) {
  return typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor);
}

const RE_BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|java\/|go-http|axios|node-fetch|monitor|uptime|pingdom|gtmetrix/i;
function esBot(userAgent) {
  const ua = String(userAgent || '');
  return ua.length < 10 || RE_BOT.test(ua);
}
function dispositivoDe(userAgent) {
  const ua = String(userAgent || '');
  if (/ipad|tablet|playbook|silk|kindle/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return 'movil';
  return 'computadora';
}

// En Android y iPhone, las apps que abren un enlace en el navegador avisan con el nombre de la app como referrer
// (por ejemplo "android-app://com.instagram.android"). Aquí se traducen a su red.
const APPS = {
  'com.instagram.android': 'instagram', 'com.instagram.lite': 'instagram', '389801252': 'instagram',
  'com.facebook.katana': 'facebook', 'com.facebook.lite': 'facebook', 'com.facebook.orca': 'facebook', '284882215': 'facebook', '454638411': 'facebook',
  'com.whatsapp': 'whatsapp', 'com.whatsapp.w4b': 'whatsapp', '310633997': 'whatsapp',
  'com.zhiliaoapp.musically': 'tiktok', 'com.ss.android.ugc.trill': 'tiktok', '835599320': 'tiktok',
  'com.google.android.youtube': 'youtube', '544007664': 'youtube',
  'com.linkedin.android': 'linkedin', '288429040': 'linkedin',
  'com.twitter.android': 'x', '333903271': 'x',
  'com.google.android.gm': 'correo', '422689480': 'correo',
  'com.google.android.googlequicksearchbox': 'google'
};
const ALIAS_UTM = {
  ig: 'instagram', insta: 'instagram', fb: 'facebook', face: 'facebook', msg: 'facebook', messenger: 'facebook', wa: 'whatsapp', wsp: 'whatsapp', whats: 'whatsapp',
  yt: 'youtube', tt: 'tiktok', tw: 'x', twitter: 'x', li: 'linkedin', gmail: 'correo', email: 'correo', mail: 'correo', newsletter: 'correo'
};
const REDES = [
  [/google\./i, 'google'], [/bing\./i, 'bing'], [/duckduckgo\./i, 'duckduckgo'], [/yahoo\./i, 'yahoo'],
  [/(^|\.)(facebook|fb)\.(com|me)|l\.facebook|lm\.facebook/i, 'facebook'], [/instagram\./i, 'instagram'],
  [/whatsapp\.|wa\.me/i, 'whatsapp'], [/linkedin\.|lnkd\.in/i, 'linkedin'],
  [/(^|\.)(twitter|x)\.com|(^|\.)t\.co$/i, 'x'], [/youtube\.|youtu\.be/i, 'youtube'], [/tiktok\./i, 'tiktok'],
  [/mail\.|outlook\.|gmail\./i, 'correo']
];
// Facebook, Instagram y TikTok abren los enlaces en su propio navegador y casi nunca envían el
// referrer: se reconocen por el nombre que dejan en el navegador (user-agent).
const REDES_APP = [
  [/Instagram/i, 'instagram'], [/FBAN|FBAV|FB_IAB|FBIOS/i, 'facebook'], [/musical_ly|TikTok|Bytedance/i, 'tiktok'],
  [/LinkedInApp/i, 'linkedin'], [/Twitter/i, 'x']
];
// Origen de la visita: ?utm_source= → página que enlazó (referrer) → app de red social desde la que se abrió
function fuenteDe(referrer, utm, userAgent, pistas) {
  const etiqueta = String(utm || '').trim().toLowerCase().slice(0, 40);
  if (etiqueta) {
    // Abreviaturas comunes que la gente escribe en sus enlaces (utm_source=ig, fb, wa…)
    if (ALIAS_UTM[etiqueta]) return ALIAS_UTM[etiqueta];
    // Los nombres cortos (como "x") solo valen si son exactos; los largos valen si aparecen dentro ("facebook_ads")
    const hallada = FUENTES.find(f => etiqueta === f || (f.length > 3 && etiqueta.includes(f)));
    return hallada || 'otros';
  }
  const ref = String(referrer || '').trim();
  let host = '';
  if (ref) {
    try { host = new URL(ref).hostname.toLowerCase(); } catch (_) { host = ''; }
    if (/^(android|ios)-app:/i.test(ref) && APPS[host]) return APPS[host];
    if (host === 'fisioteck.com' || host.endsWith('.fisioteck.com') || host === 'teccapitalweb.github.io') return 'interno';
    for (const [patron, nombre] of REDES) if (patron.test(host)) return nombre;
  }
  const ua = String(userAgent || '');
  for (const [patron, nombre] of REDES_APP) if (patron.test(ua)) return nombre;
  // Instagram agrega "igshid" o "igsh" a los enlaces que se comparten desde la app
  if (pistas && pistas.igshid === true && (!ref || !host)) return 'instagram';
  // Meta agrega "fbclid" a los enlaces de Facebook Y de Instagram: sin otra pista no se sabe de cuál de las dos viene
  if (pistas && pistas.fbclid === true && (!ref || !host)) return 'meta';
  if (!ref) return 'directo';
  return 'otros';
}

// ¿Desde dónde llegó una cuenta nueva? Se atribuye al primer contacto (el primer enlace que abrió)
// solo si ese contacto fue ANTES de crear la cuenta y dentro de los 30 días previos. Así una persona
// que ya era miembro antes del contador no se atribuye a un origen equivocado.
const VENTANA_ORIGEN_MS = 30 * 24 * 60 * 60 * 1000;
function origenDeCuenta(origen, creadaMs) {
  if (!origen || typeof origen !== 'object') return 'sin_dato';
  const t = Number(origen.t);
  const creada = Number(creadaMs);
  if (!Number.isFinite(t) || !Number.isFinite(creada) || t <= 0 || creada <= 0) return 'sin_dato';
  if (t > creada + 10 * 60 * 1000 || creada - t > VENTANA_ORIGEN_MS) return 'sin_dato';
  return fuenteDe(String(origen.ref || '').slice(0, 300), String(origen.utm || '').slice(0, 40), String(origen.ua || '').slice(0, 300), { fbclid: origen.fb === true, igshid: origen.ig === true });
}

// ¿Es una dirección de internet "pública"? Las privadas, locales o de la red interna del proveedor no sirven para ubicar a nadie.
function esIpPublica(ip) {
  const v = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (net.isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // red interna compartida (CGNAT / proveedor)
    return true;
  }
  if (net.isIP(v) === 6) {
    const m = v.toLowerCase();
    return !(m === '::1' || m === '::' || m.startsWith('fc') || m.startsWith('fd') || m.startsWith('fe80'));
  }
  return false;
}

// La IP real de quien visita. Detrás de los servidores del proveedor, "req.ip" puede ser la de uno de sus
// servidores (en Estados Unidos) y no la de la persona: por eso se leen primero los encabezados que ponen
// los proxies con la dirección original. Solo se usa para contar (nunca se guarda).
const ENCABEZADOS_IP = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'];
function candidatasIp(headers, ipExpress) {
  const h = headers || {};
  const lista = [];
  for (const nombre of ENCABEZADOS_IP) {
    const partes = String(h[nombre] || '').split(',').map(x => x.trim()).filter(Boolean);
    partes.forEach((ip, i) => lista.push({ cabecera: nombre + (partes.length > 1 ? '[' + i + ']' : ''), ip }));
  }
  if (ipExpress) lista.push({ cabecera: 'req.ip', ip: String(ipExpress) });
  return lista;
}
function ipDeSolicitud(headers, ipExpress) {
  const elegida = candidatasIp(headers, ipExpress).find(c => esIpPublica(c.ip));
  return elegida ? elegida.ip.replace(/^::ffff:/i, '') : String(ipExpress || '');
}

// Resumen de las pistas que había para decidir el origen. Sirve para entender por qué una visita quedó como "Directo".
function pistasDe(referrer, utm, userAgent, extra) {
  let host = '';
  try { host = new URL(String(referrer || '')).hostname.toLowerCase().slice(0, 40); } catch (_) { host = ''; }
  const ua = String(userAgent || '');
  const app = (REDES_APP.find(([patron]) => patron.test(ua)) || [null, ''])[1];
  return { ref: host, utm: String(utm || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20), app, fbclid: !!(extra && extra.fbclid === true), igshid: !!(extra && extra.igshid === true) };
}

// País por IP, sin guardar la IP: solo se conserva el código del país (MX, US, CO…).
let buscadorPais;
function paisDeIp(ip, buscador) {
  const limpia = String(ip || '').replace(/^::ffff:/i, '');
  try {
    if (!buscador && buscador !== null && buscadorPais === undefined) {
      try { buscadorPais = require('geoip-country'); } catch (_) { buscadorPais = null; }
    }
    const motor = buscador || buscadorPais;
    const r = motor && limpia ? motor.lookup(limpia) : null;
    return r && /^[A-Z]{2}$/.test(r.country) ? r.country : 'ZZ';
  } catch (_) { return 'ZZ'; }
}

// Identificador anónimo del día: no sirve para reconocer a nadie de un día para otro
function hashVisitante(ip, userAgent, dia, secreto) {
  return crypto.createHmac('sha256', String(secreto) + '|' + dia)
    .update(String(ip || '') + '|' + String(userAgent || ''))
    .digest('hex').slice(0, 24);
}

// Estado del contador, en memoria del servidor: sirve para mostrar en el panel si está funcionando
const estadoContador = { ultimoOk: null, errores: 0, ultimoError: null };
function marcarVisitaOk(fecha) { estadoContador.ultimoOk = (fecha instanceof Date ? fecha : new Date()).toISOString(); }
function marcarVisitaError(err, fecha) {
  estadoContador.errores += 1;
  estadoContador.ultimoError = { mensaje: String((err && err.message) || err || 'error').slice(0, 200), fecha: (fecha instanceof Date ? fecha : new Date()).toISOString() };
}
const estado = () => ({ ultimoOk: estadoContador.ultimoOk, errores: estadoContador.errores, ultimoError: estadoContador.ultimoError });

const conteo = obj => (obj && typeof obj === 'object' ? obj : {});
const suma = (obj, clave) => {
  const o = conteo(obj);
  return { ...o, [clave]: (Number(o[clave]) || 0) + 1 };
};

// Registra una visita. Devuelve { contada, nuevoVisitante } y NUNCA lanza hacia el cliente
// (si Firestore falla, la visita simplemente no se cuenta).
const MAX_RECIENTES = 25;
const MAX_LOG_DIA = 1500;     // visitas guardadas por día en el registro (el conteo de las gráficas no tiene tope)
const DIAS_LOG = 400;         // días que se conserva el registro de visitas
async function registrarVisita(db, FieldValue, datos) {
  const ahora = datos.ahora instanceof Date ? datos.ahora : new Date();
  const pagina = PAGINAS.includes(datos.pagina) ? datos.pagina : null;
  if (!pagina) return { contada: false, motivo: 'pagina' };
  if (esBot(datos.userAgent)) return { contada: false, motivo: 'bot' };
  const marcaTiempo = FieldValue && typeof FieldValue.serverTimestamp === 'function' ? FieldValue.serverTimestamp() : ahora.toISOString();
  const dia = claveDia(ahora);
  const hora = horaMexico(ahora);
  const dispositivo = dispositivoDe(datos.userAgent);
  const fuente = fuenteDe(datos.referrer, datos.utm, datos.userAgent, { fbclid: datos.fbclid === true, igshid: datos.igshid === true });
  const pais = /^[A-Z]{2}$/.test(String(datos.pais || '')) ? datos.pais : 'ZZ';
  const hash = hashVisitante(datos.ip, datos.userAgent, dia, datos.secreto);
  const miembro = datos.miembro && datos.miembro.uid ? datos.miembro : null;

  const refDia = db.collection('metricasVisitas').doc(dia);
  const refVisitante = refDia.collection('visitantes').doc(hash);
  const refRecientes = db.collection('metricasRecientes').doc('ultimas');
  const refLog = db.collection('metricasLog').doc(dia);
  const refMiembro = miembro ? db.collection('metricasMiembros').doc(String(miembro.uid)) : null;

  // Solo la primera vez que se ve a un miembro se averigua cuándo creó su cuenta (para atribuir su origen)
  let creadaMs = null;
  if (refMiembro && typeof datos.obtenerCreada === 'function') {
    const previoMiembro = await refMiembro.get();
    const sinOrigen = !previoMiembro.exists || !(previoMiembro.data() || {}).origen || (previoMiembro.data() || {}).origen === 'sin_dato';
    if (sinOrigen && datos.origen) {
      try { creadaMs = await datos.obtenerCreada(); } catch (_) { creadaMs = null; }
    }
  }

  let nuevoVisitante = false;
  await db.runTransaction(async tx => {
    const snapDia = await tx.get(refDia);
    const snapVis = await tx.get(refVisitante);
    const snapRec = await tx.get(refRecientes);
    const snapLog = await tx.get(refLog);
    const snapMiembro = refMiembro ? await tx.get(refMiembro) : null;
    const previo = snapDia.exists ? snapDia.data() : {};
    nuevoVisitante = !snapVis.exists;

    // Dispositivo, país y origen se cuentan por persona (su primera visita del día), no por página vista
    const dispositivos = nuevoVisitante ? suma(previo.dispositivos, dispositivo) : conteo(previo.dispositivos);
    const paises = nuevoVisitante ? suma(previo.paises, pais) : conteo(previo.paises);
    // El origen se cuenta una vez por persona y por origen cada día: quien ya entró hoy "directo" y luego llega
    // desde Facebook suma también a Facebook (y "dentro del sitio" solo cuenta si es su primera visita).
    const visPrevia = snapVis.exists ? (snapVis.data() || {}) : {};
    const fuentesVistas = conteo(visPrevia.fuentes);
    const cuentaFuente = nuevoVisitante || (fuente !== 'interno' && !fuentesVistas[fuente]);
    const fuentes = cuentaFuente ? suma(previo.fuentes, fuente) : conteo(previo.fuentes);
    const dia_ = {
      dia,
      total: (Number(previo.total) || 0) + 1,
      unicos: (Number(previo.unicos) || 0) + (nuevoVisitante ? 1 : 0),
      miembros: Number(previo.miembros) || 0,
      dispositivos,
      paises,
      paginas: suma(previo.paginas, pagina),
      fuentes,
      horas: suma(previo.horas, hora),
      actualizado: marcaTiempo
    };

    if (refMiembro) {
      const m = snapMiembro && snapMiembro.exists ? snapMiembro.data() : {};
      const dias = { ...conteo(m.dias) };
      const primeraDelDia = !dias[dia];
      dias[dia] = (Number(dias[dia]) || 0) + 1;
      // El historial de actividad de cada miembro se conserva completo: nunca se poda
      const diasPodados = dias;
      if (primeraDelDia) dia_.miembros += 1;
      // El origen se fija una sola vez; si antes era "sin dato" y ahora hay evidencia, se completa
      let origenFinal = m.origen || 'sin_dato';
      if (origenFinal === 'sin_dato' && creadaMs) origenFinal = origenDeCuenta(datos.origen, creadaMs);
      tx.set(refMiembro, {
        uid: String(miembro.uid),
        origen: origenFinal,
        creada: m.creada || (creadaMs ? new Date(creadaMs).toISOString() : null),
        nombre: String(miembro.nombre || '').slice(0, 80),
        email: String(miembro.email || '').slice(0, 120),
        ultima: ahora.toISOString(),
        visitas: (Number(m.visitas) || 0) + 1,
        dias: diasPodados
      });
    }

    tx.set(refDia, dia_);
    const vis = snapVis.exists ? snapVis.data() : {};
    tx.set(refVisitante, {
      primera: vis.primera || ahora.toISOString(),
      ultima: ahora.toISOString(),
      visitas: (Number(vis.visitas) || 0) + 1,
      dispositivo: vis.dispositivo || dispositivo,
      pais: vis.pais || pais,
      fuentes: cuentaFuente ? { ...fuentesVistas, [fuente]: true } : fuentesVistas
    });
    // Las últimas visitas (sin datos personales) para que el administrador compruebe que el contador funciona
    const previoRec = snapRec && snapRec.exists ? (snapRec.data() || {}) : {};
    const items = Array.isArray(previoRec.items) ? previoRec.items : [];
    const visitaItem = { t: ahora.toISOString(), pagina, fuente, pais, dispositivo, nuevo: nuevoVisitante, pistas: pistasDe(datos.referrer, datos.utm, datos.userAgent, { fbclid: datos.fbclid === true, igshid: datos.igshid === true }) };
    tx.set(refRecientes, {
      items: [visitaItem, ...items].slice(0, MAX_RECIENTES),
      actualizado: marcaTiempo
    });
    // Registro completo del día: cada visita queda guardada en cuanto ocurre, sin depender de que el administrador abra o actualice nada
    const previoLog = snapLog && snapLog.exists ? (snapLog.data() || {}) : {};
    const itemsLog = Array.isArray(previoLog.items) ? previoLog.items : [];
    tx.set(refLog, {
      dia,
      items: itemsLog.length < MAX_LOG_DIA ? [...itemsLog, visitaItem] : itemsLog,
      total: (Number(previoLog.total) || 0) + 1,
      actualizado: marcaTiempo
    });
  });
  return { contada: true, nuevoVisitante };
}

// Al crear la cuenta (cuando se pide el correo de verificación) se fija de dónde llegó la persona
async function guardarOrigenCuenta(db, { uid, nombre, email, origen, creadaMs, ahora }) {
  if (!uid || !origen) return 'sin_dato';
  const fuente = origenDeCuenta(origen, creadaMs);
  if (fuente === 'sin_dato') return fuente;
  const ref = db.collection('metricasMiembros').doc(String(uid));
  const previo = await ref.get();
  const actual = previo.exists ? (previo.data() || {}) : {};
  if (actual.origen && actual.origen !== 'sin_dato') return actual.origen;
  await ref.set({
    uid: String(uid), nombre: String(nombre || '').slice(0, 80), email: String(email || '').slice(0, 120),
    origen: fuente, creada: new Date(creadaMs).toISOString()
  }, { merge: true });
  return fuente;
}

// Datos listos para el panel del administrador: últimos `n` días (con ceros donde no hubo visitas)
function normalizarDia(clave, d) {
  const x = d || {};
  const lista = (obj, claves) => Object.fromEntries(claves.map(k => [k, Number(conteo(obj)[k]) || 0]));
  const horas = {};
  for (let h = 0; h < 24; h++) { const k = String(h).padStart(2, '0'); horas[k] = Number(conteo(x.horas)[k]) || 0; }
  return {
    dia: clave,
    total: Number(x.total) || 0,
    unicos: Number(x.unicos) || 0,
    miembros: Number(x.miembros) || 0,
    dispositivos: lista(x.dispositivos, DISPOSITIVOS),
    paises: Object.fromEntries(Object.entries(conteo(x.paises)).filter(([k, v]) => /^[A-Z]{2}$/.test(k) && Number(v) > 0).map(([k, v]) => [k, Number(v)])),
    paginas: lista(x.paginas, PAGINAS),
    fuentes: lista(x.fuentes, FUENTES),
    horas
  };
}

// Lee muchos documentos de golpe (db.getAll en lotes); si el almacén no lo ofrece, uno por uno
async function leerDocumentos(db, refs) {
  if (typeof db.getAll === 'function') {
    const salida = [];
    for (let i = 0; i < refs.length; i += 300) salida.push(...await db.getAll(...refs.slice(i, i + 300)));
    return salida;
  }
  return Promise.all(refs.map(r => r.get()));
}
function fechaMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}
// ¿Tiene membresía vigente? Por defecto la regla básica; el servidor pasa la suya (memberHasPremiumAccess) con opciones.esMiembro.
function esVipActivo(m) {
  if (!m || !['active', 'paid'].includes(m.status)) return false;
  const vence = fechaMs(m.accessUntil || m.nextPaymentDate);
  return !vence || vence > Date.now() - 24 * 3600 * 1000;
}

async function leerMetricas(db, { hoy, dias = DIAS_HISTORIAL } = {}, opciones = {}) {
  const n = Math.min(Math.max(Number(dias) || DIAS_HISTORIAL, 7), DIAS_MAX);
  const fin = esClaveDia(hoy) ? hoy : claveDia(new Date());
  const claves = [];
  for (let i = n - 1; i >= 0; i--) claves.push(sumarDias(fin, -i));
  const snaps = await leerDocumentos(db, claves.map(c => db.collection('metricasVisitas').doc(c)));
  const listaDias = snaps.map((s, i) => normalizarDia(claves[i], s.exists ? s.data() : null));
  const corte = claves[0];
  const miembrosSnap = await db.collection('metricasMiembros').get();
  const miembros = miembrosSnap.docs.map(d => {
    const m = d.data() || {};
    const diasM = conteo(m.dias);
    return {
      uid: String(m.uid || d.id),
      nombre: String(m.nombre || ''),
      email: String(m.email || ''),
      ultima: m.ultima || null,
      visitas: Number(m.visitas) || 0,
      dias: Object.fromEntries(Object.entries(diasM).filter(([k]) => k >= claves[0]))
    };
  }).filter(m => m.ultima && claveDia(m.ultima) >= corte)
    .sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)))
    .slice(0, 300);
  // De dónde salió cada cuenta (para saber qué red social trae más miembros) y si hoy es VIP activa
  const conOrigen = miembrosSnap.docs.map(d => {
    const m = d.data() || {};
    return { uid: String(m.uid || d.id), origen: FUENTES.includes(m.origen) ? m.origen : 'sin_dato', creada: m.creada || null };
  }).filter(o => o.origen !== 'sin_dato').slice(0, 5000);
  const fichas = await leerDocumentos(db, conOrigen.map(o => db.collection('members').doc(o.uid)));
  const origenes = conOrigen.map((o, i) => ({ ...o, vip: !!(fichas[i] && fichas[i].exists && (opciones.esMiembro || esVipActivo)(fichas[i].data())) }));
  const sinDato = miembrosSnap.docs.length - origenes.length;
  let recientes = [];
  try {
    const rec = await db.collection('metricasRecientes').doc('ultimas').get();
    recientes = rec.exists && Array.isArray((rec.data() || {}).items) ? rec.data().items.slice(0, MAX_RECIENTES).map(x => ({
      t: String(x.t || ''), pagina: PAGINAS.includes(x.pagina) ? x.pagina : '', fuente: FUENTES.includes(x.fuente) ? x.fuente : 'otros',
      pais: /^[A-Z]{2}$/.test(String(x.pais || '')) ? x.pais : 'ZZ', dispositivo: DISPOSITIVOS.includes(x.dispositivo) ? x.dispositivo : 'computadora', nuevo: x.nuevo === true,
      pistas: {
        ref: String((x.pistas && x.pistas.ref) || '').replace(/[^a-z0-9.-]/gi, '').slice(0, 40),
        utm: String((x.pistas && x.pistas.utm) || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 20),
        app: FUENTES.includes(x.pistas && x.pistas.app) ? x.pistas.app : '',
        fbclid: !!(x.pistas && x.pistas.fbclid === true),
        igshid: !!(x.pistas && x.pistas.igshid === true)
      }
    })) : [];
  } catch (_) { recientes = []; }
  return { zona: ZONA, hoy: fin, dias: listaDias, miembros, origenes, sinOrigen: sinDato, recientes, estado: estado() };
}

// Registro de visitas de un periodo (hoy, ayer, 7 o 30 días), de la más reciente a la más antigua
const PERIODOS_LOG = { hoy: 1, ayer: 1, '7': 7, '30': 30 };
function normalizarVisita(x) {
  const p = x && x.pistas ? x.pistas : {};
  return {
    t: String((x && x.t) || ''),
    pagina: PAGINAS.includes(x && x.pagina) ? x.pagina : '',
    fuente: FUENTES.includes(x && x.fuente) ? x.fuente : 'otros',
    pais: /^[A-Z]{2}$/.test(String((x && x.pais) || '')) ? x.pais : 'ZZ',
    dispositivo: DISPOSITIVOS.includes(x && x.dispositivo) ? x.dispositivo : 'computadora',
    nuevo: !!(x && x.nuevo === true),
    pistas: {
      ref: String(p.ref || '').replace(/[^a-z0-9.-]/gi, '').slice(0, 40),
      utm: String(p.utm || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 20),
      app: FUENTES.includes(p.app) ? p.app : '',
      fbclid: !!(p.fbclid === true),
      igshid: !!(p.igshid === true)
    }
  };
}
async function leerRegistroVisitas(db, { periodo = 'hoy', hoy, limite = 600 } = {}) {
  const k = Object.prototype.hasOwnProperty.call(PERIODOS_LOG, periodo) ? periodo : 'hoy';
  const fin = esClaveDia(hoy) ? hoy : claveDia(new Date());
  const ultimo = k === 'ayer' ? sumarDias(fin, -1) : fin;
  const n = PERIODOS_LOG[k];
  const claves = [];
  for (let i = n - 1; i >= 0; i--) claves.push(sumarDias(ultimo, -i));
  const snaps = await leerDocumentos(db, claves.map(c => db.collection('metricasLog').doc(c)));
  let total = 0;
  const todas = [];
  snaps.forEach(sn => {
    if (!sn.exists) return;
    const d = sn.data() || {};
    total += Number(d.total) || (Array.isArray(d.items) ? d.items.length : 0);
    (Array.isArray(d.items) ? d.items : []).forEach(x => todas.push(normalizarVisita(x)));
  });
  todas.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return { periodo: k, desde: claves[0], hasta: claves[claves.length - 1], total, items: todas.slice(0, limite), truncado: todas.length > limite };
}

// Borra SOLO los identificadores anónimos de días viejos (solo sirven para contar únicos del propio día); nada de miembros ni de métricas
async function limpiarVisitantesAntiguos(db, { hoy, conservarDias = 45 } = {}) {
  const fin = esClaveDia(hoy) ? hoy : claveDia(new Date());
  const corte = sumarDias(fin, -conservarDias);
  const dias = await db.collection('metricasVisitas').listDocuments();
  let borrados = 0;
  for (const ref of dias) {
    if (ref.id >= corte) continue;
    const visitantes = await ref.collection('visitantes').listDocuments();
    for (let i = 0; i < visitantes.length; i += 400) {
      const lote = db.batch();
      visitantes.slice(i, i + 400).forEach(v => lote.delete(v));
      await lote.commit();
      borrados += Math.min(400, visitantes.length - i);
    }
  }
  // El registro de visitas y el historial de los miembros NO se borran: aquí solo se quitan los identificadores anónimos de visitantes
  return borrados;
}

module.exports = {
  ZONA, PAGINAS, DISPOSITIVOS, FUENTES, DIAS_HISTORIAL, DIAS_MAX, DIAS_ACTIVIDAD_MIEMBRO, estado, marcarVisitaOk, marcarVisitaError, esVipActivo,
  claveDia, horaMexico, sumarDias, esClaveDia, esBot, dispositivoDe, fuenteDe, hashVisitante,
  paisDeIp, ipDeSolicitud, candidatasIp, esIpPublica, origenDeCuenta, guardarOrigenCuenta, registrarVisita, leerMetricas, leerRegistroVisitas, limpiarVisitantesAntiguos
};
