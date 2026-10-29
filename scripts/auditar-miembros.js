'use strict';
// AUDITORÍA DE SOLO LECTURA: comprueba que los miembros ya existentes conservan su avance, sus logros y sus cursos abiertos.
// No escribe ni borra NADA en Firestore. Imprime solo totales (y, si hay algo raro, las primeras 6 letras del id de la cuenta); no imprime nombres ni correos.
//
// Cómo usarlo (en TU computadora, con tu llave de Firebase; yo no tengo acceso a ella):
//   1) Abre una terminal en la carpeta club-fisioteck-webhooks.
//   2) Opción A: pega el JSON de la cuenta de servicio en la variable de entorno y corre el script:
//        PowerShell:  $env:FIREBASE_SERVICE_ACCOUNT = Get-Content C:\ruta\cuenta-de-servicio.json -Raw ; node scripts/auditar-miembros.js
//      Opción B: node scripts/auditar-miembros.js C:\ruta\cuenta-de-servicio.json
//   3) Copia el resultado y mándaselo a Claude si algo no cuadra.
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { calcularAcceso, inicioMembresia, configEscalonado } = require('../services/acceso');

function credencial() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(fs.readFileSync(arg, 'utf8'));
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  console.error('Falta la cuenta de servicio: pasa la ruta del archivo JSON como argumento o define FIREBASE_SERVICE_ACCOUNT.'); process.exit(1);
}
const corto = id => String(id).slice(0, 6) + '…';
const aFecha = v => { if (!v) return null; if (typeof v.toDate === 'function') return v.toDate(); const d = new Date(String(v).length === 10 ? v + 'T00:00:00Z' : v); return isNaN(d) ? null : d; };

(async () => {
  admin.initializeApp({ credential: admin.credential.cert(credencial()) });
  const db = admin.firestore();
  const catalogo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'bunny-catalog.json'), 'utf8'));
  const cfgSnap = await db.collection('config').doc('club').get(), cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const conf = configEscalonado(cfg);
  console.log('== Configuración de cursos escalonados ==');
  console.log('Activo:', conf.activo, '| días entre cursos:', conf.dias, '| encendido desde:', conf.desde || '(sin fecha)', '| aplicar también a antiguos:', conf.paraTodos);

  const miembros = await db.collection('members').get();
  const t = { total: 0, conMembresia: 0, antiguos: 0, nuevos: 0, antiguosTodoAbierto: 0, antiguosConCandado: [], nuevosConCalendario: 0, sinFechaInicio: 0,
    conAvance: 0, conLogrosAnteriores: 0, conLogrosMigrados: 0, logrosAnterioresSinMigrar: 0, conCertificados: 0 };
  const ahora = new Date();
  const activos = [];
  miembros.forEach(d => { t.total++; const m = d.data() || {}; if (['active', 'paid', 'cancelled'].includes(m.status)) { t.conMembresia++; activos.push({ id: d.id, m }); } });

  for (const { id, m } of activos) {
    const inicio = inicioMembresia(m), desde = aFecha(conf.desde);
    const antiguo = !inicio || (desde && inicio < desde);
    if (!inicio) t.sinFechaInicio++;
    if (antiguo) t.antiguos++; else t.nuevos++;
    const a = calcularAcceso({ miembro: m, catalogo, cfg, retosSuperados: 0, retosHechos: {}, ahora, esAdmin: false, adelantados: [], conMembresia: true });
    if (antiguo) { const cerrados = Object.values(a.cursos || {}).filter(c => !c.abierto).length; if (cerrados === 0) t.antiguosTodoAbierto++; else t.antiguosConCandado.push(corto(id)); }
    else if (a.escalonado) t.nuevosConCalendario++;
  }
  // Documentos de avance y logros de TODAS las cuentas (en lotes)
  const refs = [];
  miembros.forEach(d => ['courses', 'achievements', 'logros'].forEach(n => refs.push(db.collection('members').doc(d.id).collection('progress').doc(n))));
  const existe = new Set();
  for (let i = 0; i < refs.length; i += 300) { const docs = await db.getAll(...refs.slice(i, i + 300)); docs.forEach(x => { if (x.exists) existe.add(x.ref.path); }); }
  miembros.forEach(d => {
    const base = 'members/' + d.id + '/progress/';
    if (existe.has(base + 'courses')) t.conAvance++;
    if (existe.has(base + 'achievements')) t.conLogrosAnteriores++;
    if (existe.has(base + 'logros')) t.conLogrosMigrados++;
  });
  const certs = await db.collection('certificados').get(); const dueños = new Set(); certs.forEach(c => dueños.add((c.data() || {}).uid)); t.conCertificados = dueños.size;

  console.log('\n== Miembros ==');
  console.log('Cuentas en total:', t.total, '| con membresía (activa, pagada o cancelada con acceso):', t.conMembresia);
  console.log('Antiguos (pagaron antes de encender el escalonado):', t.antiguos, '| con TODOS los cursos abiertos según la regla actual:', t.antiguosTodoAbierto);
  console.log('Antiguos que hoy tendrían candados (revisar):', t.antiguosConCandado.length, t.antiguosConCandado.length ? t.antiguosConCandado.slice(0, 20).join(', ') : '');
  console.log('Nuevos (siguen la regla):', t.nuevos, '| con calendario activo:', t.nuevosConCalendario, '| sin fecha de inicio (se tratan como antiguos):', t.sinFechaInicio);
  console.log('\n== Avance y logros conservados ==');
  console.log('Cuentas con avance de cursos guardado:', t.conAvance);
  console.log('Cuentas con logros del sistema anterior:', t.conLogrosAnteriores, '| con logros ya migrados al sistema nuevo:', t.conLogrosMigrados, '(los demás se migran solos al abrir Logros)');
  console.log('Cuentas con al menos un certificado emitido:', t.conCertificados);
  console.log('\nListo. Este script no escribió ni borró nada.');
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
