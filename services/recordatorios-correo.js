'use strict';

// ══ RECORDATORIOS DE PAGO · TEXTO DE LOS CORREOS (7 pasos por vuelta, 3 vueltas; HTML sobrio y texto plano) ══
// Puro: recibe datos y devuelve { asunto, html, text }. Todo lo que viene de datos de personas (nombre, curso) se ESCAPA en el HTML.
// Los beneficios son solo los que existen hoy: cursos grabados con certificado de folio verificable, material descargable que se desbloquea
// conforme terminas las clases, retos, herramientas clínicas, clases en vivo, foro y directorio.
// Nada de urgencia falsa: los cupones valen 24 h de verdad (así lo hace Stripe) y el precio se dice claro en cada correo.
// En las vueltas 2 y 3 cambian los asuntos y la apertura («volvemos a escribirte»), para que no sea el mismo correo repetido.

const { variante, definicion, CONFIG } = require('./recordatorios-pago');

const SITIO = 'https://www.fisioteck.com';
const CLUB = () => String(process.env.CLUB_URL || 'https://club.fisioteck.com').replace(/\/+$/, '');
const URL_COMPRA = CLUB() + '/';
const URL_AVISO = SITIO + '/aviso-de-privacidad.html';
const URL_LOGO = CLUB() + '/icon-192.png';
const CORREO_CONTACTO = 'teccapitalweb@gmail.com';

const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const limpio = t => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const pesos = n => '$' + Number(n).toLocaleString('es-MX');

function primerNombre(nombre) {
  const n = limpio(nombre).split(' ')[0] || '';
  return n.length > 30 ? n.slice(0, 30) : n;
}
const mayuscula = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const cicloValido = c => Math.min(CONFIG.maxCiclos, Math.max(1, Math.floor(Number(c)) || 1));

function vencimientoLegible(ms, zona = CONFIG.zona) {
  return new Date(ms).toLocaleString('es-MX', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
}

// ───────── Asuntos: sin emojis, sin mayúsculas gritadas y sin signos de admiración (Gmail los lee como publicidad) ─────────
// {n} = primer nombre (si no hay nombre, se usa la versión sin él); {m} = descuento; {p} = precio del primer mes
// Vuelta 1: 4 variantes por cada paso.
const ASUNTOS = Object.freeze({
  1: [
    ['{n}, esto es lo que abre la membresía de FisioTeck', 'Esto es lo que abre la membresía de FisioTeck'],
    ['{n}, tu cuenta de FisioTeck puede hacer más', 'Tu cuenta de FisioTeck puede hacer más'],
    ['{n}, te cuento qué hay dentro del Club de FisioTeck', 'Qué hay dentro del Club de FisioTeck'],
    ['{n}, cursos, materiales y comunidad en un solo lugar', 'Cursos, materiales y comunidad en un solo lugar']
  ],
  2: [
    ['{n}, {m} menos en tu primer mes de FisioTeck', '{m} menos en tu primer mes de FisioTeck'],
    ['{n}, tu primer mes puede costar {p}', 'Tu primer mes puede costar {p}'],
    ['{n}, tu código de {m} vale 24 horas', 'Tu código de {m} vale 24 horas'],
    ['{n}, un código para tu primer mes en FisioTeck', 'Un código para tu primer mes en FisioTeck']
  ],
  3: [
    ['{n}, subimos el descuento: {m} menos en tu primer mes', 'Subimos el descuento: {m} menos en tu primer mes'],
    ['{n}, tu primer mes puede quedar en {p}', 'Tu primer mes puede quedar en {p}'],
    ['{n}, un código de {m} para empezar en FisioTeck', 'Un código de {m} para empezar en FisioTeck'],
    ['{n}, nuevo código: primer mes en {p}', 'Nuevo código: primer mes en {p}']
  ],
  4: [
    ['{n}, otro código de {m} para tu primer mes', 'Otro código de {m} para tu primer mes'],
    ['{n}, tu primer mes en FisioTeck puede costar {p}', 'Tu primer mes en FisioTeck puede costar {p}'],
    ['{n}, seguimos con un descuento de {m}', 'Seguimos con un descuento de {m}'],
    ['{n}, un código nuevo de {m} por 24 horas', 'Un código nuevo de {m} por 24 horas']
  ],
  5: [
    ['{n}, un código de {m} para tu primer mes, de nuevo', 'Un código de {m} para tu primer mes, de nuevo'],
    ['{n}, primer mes en {p} con tu nuevo código', 'Primer mes en {p} con tu nuevo código'],
    ['{n}, te dejamos otro código de {m}', 'Te dejamos otro código de {m}'],
    ['{n}, un código de {m} para empezar cuando quieras', 'Un código de {m} para empezar cuando quieras']
  ],
  6: [
    ['{n}, otro código de {m} por 24 horas', 'Otro código de {m} por 24 horas'],
    ['{n}, tu código de {m} para el primer mes', 'Tu código de {m} para el primer mes'],
    ['{n}, primer mes en {p}, si te sirve', 'Primer mes en {p}, si te sirve'],
    ['{n}, vuelve el descuento de {m}', 'Vuelve el descuento de {m}']
  ],
  7: [
    ['{n}, el último código de esta vuelta: {m} menos', 'El último código de esta vuelta: {m} menos'],
    ['{n}, cerramos esta vuelta con un código de {m}', 'Cerramos esta vuelta con un código de {m}'],
    ['{n}, tu primer mes en {p}: último código de la vuelta', 'Tu primer mes en {p}: último código de la vuelta'],
    ['{n}, un último código de {m} antes de una pausa', 'Un último código de {m} antes de una pausa']
  ]
});
// Vueltas 2 y 3: asuntos propios por tipo de correo (tres variantes cada uno)
const ASUNTOS_VUELTA = Object.freeze({
  2: {
    beneficios: [
      ['{n}, volvemos a escribirte sobre la membresía de FisioTeck', 'Volvemos a escribirte sobre la membresía de FisioTeck'],
      ['{n}, pasaron unos días: esto sigue esperándote en FisioTeck', 'Pasaron unos días: esto sigue esperándote en FisioTeck'],
      ['{n}, un recordatorio tranquilo de lo que incluye el Club', 'Un recordatorio tranquilo de lo que incluye el Club']
    ],
    bajo: [
      ['{n}, segunda vuelta: {m} menos en tu primer mes', 'Segunda vuelta: {m} menos en tu primer mes'],
      ['{n}, de nuevo un código de {m} para tu primer mes', 'De nuevo un código de {m} para tu primer mes'],
      ['{n}, tu primer mes en {p} con este código', 'Tu primer mes en {p} con este código']
    ],
    alto: [
      ['{n}, en esta vuelta el código es de {m}', 'En esta vuelta el código es de {m}'],
      ['{n}, primer mes en {p} con un código de {m}', 'Primer mes en {p} con un código de {m}'],
      ['{n}, subimos el código a {m} otra vez', 'Subimos el código a {m} otra vez']
    ],
    cierre: [
      ['{n}, cerramos la segunda vuelta con {m} menos', 'Cerramos la segunda vuelta con {m} menos'],
      ['{n}, último código de esta vuelta: primer mes en {p}', 'Último código de esta vuelta: primer mes en {p}'],
      ['{n}, hacemos una pausa; antes, un código de {m}', 'Hacemos una pausa; antes, un código de {m}']
    ]
  },
  3: {
    beneficios: [
      ['{n}, una última vuelta de correos sobre la membresía', 'Una última vuelta de correos sobre la membresía'],
      ['{n}, empieza la última vuelta de correos de FisioTeck', 'Empieza la última vuelta de correos de FisioTeck'],
      ['{n}, antes de despedirnos: qué incluye el Club de FisioTeck', 'Antes de despedirnos: qué incluye el Club de FisioTeck']
    ],
    bajo: [
      ['{n}, última vuelta: un código de {m}', 'Última vuelta: un código de {m}'],
      ['{n}, tu primer mes en {p}, en esta última vuelta', 'Tu primer mes en {p}, en esta última vuelta'],
      ['{n}, otro código de {m}, ya casi terminamos', 'Otro código de {m}, ya casi terminamos']
    ],
    alto: [
      ['{n}, código de {m} en esta última vuelta', 'Código de {m} en esta última vuelta'],
      ['{n}, primer mes en {p}, con tu código de {m}', 'Primer mes en {p}, con tu código de {m}'],
      ['{n}, un código de {m} en la recta final', 'Un código de {m} en la recta final']
    ],
    cierre: [
      ['{n}, este es nuestro último correo', 'Este es nuestro último correo'],
      ['{n}, el último código: primer mes en {p}', 'El último código: primer mes en {p}'],
      ['{n}, nos despedimos con un código de {m}', 'Nos despedimos con un código de {m}']
    ]
  }
});
const NUM_VARIANTES = 4;

// Tipo de correo según el paso (para los asuntos de las vueltas 2 y 3)
function tipoDe(paso) {
  const d = definicion(paso);
  if (!d || !d.monto) return 'beneficios';
  if (paso === CONFIG.serie[CONFIG.serie.length - 1].paso) return 'cierre';
  return d.monto === Math.min(...CONFIG.serie.map(s => s.monto).filter(Boolean)) ? 'bajo' : 'alto';
}

// La variante rota con el paso, así dos correos seguidos del mismo tipo no llevan el mismo asunto
function asunto({ uid = '', ciclo = 1, paso, nombre, monto, precioMes }) {
  ciclo = cicloValido(ciclo);
  const lista = ciclo > 1 && ASUNTOS_VUELTA[ciclo] ? ASUNTOS_VUELTA[ciclo][tipoDe(paso)] : (ASUNTOS[paso] || ASUNTOS[1]);
  const par = lista[(variante(uid, 0, lista.length) + paso + ciclo) % lista.length];
  const n = primerNombre(nombre);
  const plantilla = n ? par[0] : mayuscula(par[1]);
  return plantilla.replace(/\{n\}/g, n).replace(/\{m\}/g, pesos(monto || 0)).replace(/\{p\}/g, pesos(Math.max(0, (precioMes || 0) - (monto || 0))));
}

// ───────── Beneficios REALES (los mismos que hoy ofrece el Club) ─────────
const BENEFICIOS = Object.freeze([
  '<b>Cursos grabados con certificado</b>: al terminar uno recibes un certificado con folio que cualquiera puede verificar en nuestro sitio.',
  '<b>Material descargable de cada curso</b> (PDF, hojas de cálculo y presentaciones) que se va desbloqueando conforme terminas las clases.',
  '<b>Retos</b> para practicar lo que aprendes, y juegos y preguntas al final de cada clase.',
  '<b>Herramientas clínicas</b> para tu práctica diaria y una biblioteca de PDFs.',
  '<b>Clases en vivo y webinars</b> con el equipo de FisioTeck.',
  '<b>Foro y directorio</b> para conocer a otras personas de la comunidad.'
]);

// ───────── Cuerpos ─────────
// Devuelve { parrafos: [html], destacado, boton, lista, cierre }. Los textos con <b> son nuestros; los datos de personas SIEMPRE pasan por esc().
function cuerpo({ ciclo = 1, paso, uid, nombre, cursoPrueba, monto, precioMes }) {
  ciclo = cicloValido(ciclo);
  const n = primerNombre(nombre);
  const hola = n ? 'Hola ' + esc(n) + ',' : 'Hola,';
  const curso = limpio(cursoPrueba).slice(0, 120);
  const precioFinal = Math.max(0, precioMes - monto);
  const precio = 'Tu primer mes: <b>' + pesos(precioFinal) + '</b> (en lugar de ' + pesos(precioMes) + '). Desde el segundo mes: ' + pesos(precioMes) + ', y puedes cancelar cuando quieras.';
  const v = variante(uid, paso + 10, 2);
  const cursoLinea = curso
    ? 'Elegiste «' + esc(curso) + '» como tu curso de prueba. Con la membresía abres todas sus clases, incluida la última, y al terminar recibes tu certificado.'
    : '';
  const ultimoDeLaSerie = ciclo >= CONFIG.maxCiclos && paso >= CONFIG.serie[CONFIG.serie.length - 1].paso;
  const vuelta = ciclo === 2 ? 'segunda' : 'tercera y última';
  const codigoUnico = 'Es solo tuyo, sirve una vez y vale 24 horas.';
  switch (paso) {
    case 1: {
      const apertura = ciclo === 1
        ? (v ? 'Creaste tu cuenta en FisioTeck y queremos contarte con claridad qué incluye la membresía, por si te sirve para lo que haces.'
          : 'Gracias por crear tu cuenta en FisioTeck. Te cuento, sin rodeos, qué incluye la membresía por si te sirve para lo que haces.')
        : ciclo === 2
          ? (v ? 'Pasaron unos días y volvemos a escribirte, con calma, para recordarte qué incluye la membresía de FisioTeck.'
            : 'Volvemos a escribirte después de unos días de pausa. Por si ahora sí es buen momento, te recuerdo qué incluye la membresía.')
          : (v ? 'Volvemos a escribirte una última vez en esta etapa: en esta tercera y última vuelta de correos te recordamos qué incluye la membresía y, después, no te escribiremos más.'
            : 'Esta es la tercera y última vuelta de correos que te enviamos. Volvemos a escribirte para recordarte qué incluye la membresía; después de esta vuelta no te enviaremos más.');
      return {
        boton: 'Ver la membresía',
        parrafos: [hola, apertura, ...(cursoLinea ? [cursoLinea] : []), 'Con la membresía tienes:'],
        lista: BENEFICIOS,
        cierre: 'El plan mensual cuesta ' + pesos(precioMes) + ' y puedes cancelar cuando quieras. Si todavía no es el momento, no pasa nada.'
      };
    }
    case 2:
      return {
        destacado: true, boton: 'Usar mi código',
        parrafos: [
          hola,
          ...(ciclo > 1 ? ['Seguimos con la ' + vuelta + ' vuelta de correos.'] : []),
          'Para que empezar sea más fácil, tienes un código de ' + pesos(monto) + ' para tu primer mes de membresía mensual. ' + codigoUnico,
          ...(cursoLinea ? [cursoLinea] : ['Con la membresía abres los cursos, el material descargable, los retos y la comunidad.']),
          precio
        ]
      };
    case 3:
      return {
        destacado: true, boton: 'Usar mi código',
        parrafos: [
          hola,
          'Tu código anterior ya venció. Te mandamos uno nuevo, esta vez de ' + pesos(monto) + ', para tu primer mes de membresía mensual. ' + codigoUnico,
          ...(cursoLinea ? [cursoLinea] : []),
          precio
        ]
      };
    case 4:
    case 6:
      return {
        destacado: true, boton: 'Usar mi código',
        parrafos: [
          hola,
          'Por si no era el momento antes, aquí tienes otro código de ' + pesos(monto) + ' para tu primer mes de membresía mensual. Sirve una vez y vale 24 horas.',
          v ? 'Recuerda lo que incluye: cursos con certificado verificable, material de cada curso que se desbloquea por clase, retos, herramientas clínicas, foro y directorio.'
            : 'Dentro encuentras cursos con certificado verificable, material para descargar, retos, herramientas clínicas, foro y directorio.',
          precio
        ]
      };
    case 5:
      return {
        destacado: true, boton: 'Usar mi código',
        parrafos: [
          hola,
          'Seguimos por aquí con otro código, de ' + pesos(monto) + ', para tu primer mes de membresía mensual. ' + codigoUnico,
          ...(cursoLinea ? [cursoLinea] : []),
          precio
        ]
      };
    default:
      return {
        destacado: true, boton: 'Usar mi código', ultimo: true,
        parrafos: [
          hola,
          ultimoDeLaSerie
            ? 'Este es nuestro último correo: un código de ' + pesos(monto) + ' para tu primer mes de membresía mensual. Sirve una vez y vale 24 horas.'
            : 'Este es el último código de esta vuelta de correos: ' + pesos(monto) + ' para tu primer mes de membresía mensual. Sirve una vez y vale 24 horas.',
          precio,
          ultimoDeLaSerie
            ? 'Después de este correo no te enviaremos más recordatorios con códigos. La membresía seguirá disponible cuando quieras en ' + SITIO.replace('https://', '') + '.'
            : 'Después de este correo haremos una pausa de unos días. La membresía seguirá disponible cuando quieras en ' + SITIO.replace('https://', '') + '.'
        ]
      };
  }
}

// ───────── Armado ─────────
// datos: { paso, ciclo, uid, nombre, cursoPrueba, precioMes, codigo, venceMs, urlCompra, urlBaja, correoContacto, primerAviso, prueba }
function plantilla(datos) {
  const d = datos || {};
  const paso = definicion(d.paso) ? d.paso : 1;
  const ciclo = cicloValido(d.ciclo);
  const def = definicion(paso);
  const monto = def.monto;
  const precioMes = Number(d.precioMes) > 0 ? Number(d.precioMes) : CONFIG.precioMesMXN;
  const uid = String(d.uid || '');
  const urlCompra = d.urlCompra || URL_COMPRA;
  const urlBaja = d.urlBaja || '';
  const contacto = d.correoContacto || CORREO_CONTACTO;
  const c = cuerpo({ ciclo, paso, uid, nombre: d.nombre, cursoPrueba: d.cursoPrueba, monto, precioMes, venceMs: d.venceMs });
  const asuntoFinal = asunto({ uid, ciclo, paso, nombre: d.nombre, monto, precioMes });
  const precioFinal = Math.max(0, precioMes - monto);
  const vence = d.venceMs ? 'Vence el ' + vencimientoLegible(d.venceMs) + ' (hora de Ciudad de México).' : 'Vale 24 horas.';
  const aviso = d.primerAviso === true
    ? 'Te escribimos porque tienes una cuenta en FisioTeck y todavía no eres miembro. Si no quieres recibir recordatorios y promociones por correo, puedes darte de baja en un clic aquí: '
    : '';

  const caja = c.destacado ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;"><tr><td style="background:#F2F7FC;border:2px dashed #0D5FA0;border-radius:12px;padding:18px;text-align:center;">
            <div style="font-size:12px;font-weight:700;color:#0D5FA0;letter-spacing:1px;text-transform:uppercase;">Tu código personal</div>
            <div style="font-size:28px;font-weight:800;color:#0B1A30;letter-spacing:2px;margin:6px 0;font-family:Consolas,'Courier New',monospace;">${esc(d.codigo)}</div>
            <div style="font-size:14px;color:#33475B;">Tu primer mes: <b>${esc(pesos(precioFinal))}</b> (en lugar de ${esc(pesos(precioMes))})</div>
            <div style="font-size:13px;color:#0B3A66;margin-top:6px;font-weight:600;">${esc(vence)}</div>
          </td></tr></table>` : '';
  const lista = c.lista ? '<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.65;color:#33475B;">' + c.lista.map(x => '<li style="margin-bottom:6px;">' + x + '</li>').join('') + '</ul>' : '';
  const parrafos = c.parrafos.map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#33475B;">${p}</p>`).join('');
  const cierre = c.cierre ? `<p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#33475B;">${esc(c.cierre)}</p>` : '';
  const avisoHtml = aviso && urlBaja
    ? `<p style="margin:0 0 18px;padding:12px 14px;background:#E6F6F4;border-radius:10px;font-size:13px;line-height:1.55;color:#0B3A66;">${esc(aviso)}<a href="${esc(urlBaja)}" style="color:#0B3A66;font-weight:700;">darme de baja</a>.</p>` : '';
  const instruccion = c.destacado
    ? '<p style="margin:10px 0 0;font-size:13px;line-height:1.55;color:#5B6E82;">Entra con esta misma cuenta, elige el plan mensual y tu código se aplica solo. Si no, escríbelo en «Agregar código promocional».</p>' : '';
  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(asuntoFinal)}</title></head>
<body style="margin:0;padding:0;background:#EEF3F8;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3F8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #D8E3EE;">
        <tr><td style="background:#0D5FA0;padding:22px 24px;text-align:center;border-bottom:4px solid #159E92;">
          <img src="${URL_LOGO}" width="64" height="64" alt="FisioTeck" style="display:block;margin:0 auto 8px;border-radius:50%;border:2px solid #FFFFFF;">
          <div style="font-size:22px;font-weight:800;color:#FFFFFF;">FisioTeck</div>
          <div style="font-size:12px;font-weight:600;color:#BFE6E1;margin-top:3px;letter-spacing:1px;text-transform:uppercase;">Club de fisioterapia</div>
        </td></tr>
        <tr><td style="padding:26px 24px;">
          ${avisoHtml}${parrafos}${lista}${caja}${cierre}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px;"><tr><td style="border-radius:10px;background:#0D5FA0;">
            <a href="${esc(urlCompra)}" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;">${esc(c.boton)}</a>
          </td></tr></table>
          ${instruccion}
        </td></tr>
      </table>
      <p style="margin:14px 0 4px;font-size:12px;line-height:1.6;color:#7C8DA0;max-width:540px;">Recibes este correo porque creaste una cuenta en fisioteck.com y todavía no eres miembro. Es un mensaje promocional sobre la membresía.<br>
      ${urlBaja ? `<a href="${esc(urlBaja)}" style="color:#5B6E82;">No quiero recibir recordatorios ni promociones</a> · ` : ''}<a href="${URL_AVISO}" style="color:#5B6E82;">Aviso de privacidad</a></p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#7C8DA0;">FisioTeck · <a href="mailto:${esc(contacto)}" style="color:#5B6E82;">${esc(contacto)}</a></p>
    </td></tr>
  </table>
</body></html>`;

  const plano = s => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [
    ...(aviso && urlBaja ? [aviso + urlBaja, ''] : []),
    ...c.parrafos.map(plano),
    ...(c.lista ? c.lista.map(x => '- ' + plano(x)) : []),
    ...(c.destacado ? ['', 'Tu código personal: ' + d.codigo, 'Tu primer mes: ' + pesos(precioFinal) + ' (en lugar de ' + pesos(precioMes) + ').', vence,
      'Entra con esta misma cuenta, elige el plan mensual y tu código se aplica solo. Si no, escríbelo en «Agregar código promocional».'] : []),
    ...(c.cierre ? ['', c.cierre] : []),
    '', c.boton + ': ' + urlCompra,
    '', '--',
    'Recibes este correo porque creaste una cuenta en fisioteck.com y todavía no eres miembro. Es un mensaje promocional sobre la membresía.',
    ...(urlBaja ? ['No quiero recibir recordatorios ni promociones: ' + urlBaja] : []),
    'Aviso de privacidad: ' + URL_AVISO,
    'FisioTeck · ' + contacto
  ].join('\n');
  return { asunto: (d.prueba ? '[PRUEBA] ' : '') + asuntoFinal, html, text, monto, precioFinal, ciclo, paso };
}

module.exports = { ASUNTOS, ASUNTOS_VUELTA, NUM_VARIANTES, BENEFICIOS, SITIO, URL_COMPRA, URL_AVISO, URL_LOGO, CORREO_CONTACTO, esc, pesos, primerNombre, vencimientoLegible, tipoDe, asunto, cuerpo, plantilla };
