'use strict';
// PDF del certificado (A4 horizontal) con QR de verificación. Misma estructura que el de Alintec Food con los colores de FisioTeck:
// doble marco, logo, medalla, título, nombre, curso, carga académica, QR, las DOS FIRMAS originales del Club (Directora Académica y
// Coordinación de Certificación), sello y barra con el folio. Usa las fuentes estándar de PDF (Times/Helvetica) para no depender de archivos.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const ANCHO = 1040, ALTO = 735;                 // espacio de dibujo (misma proporción que A4)
const A4_ANCHO = 841.89, A4_ALTO = 595.28;
const AZUL_OSCURO = '#0A3E68', AZUL = '#0D5FA0', TURQUESA = '#159E92', GRIS = '#5B7186', LINEA = '#C9D8E6';

const ASSETS = path.join(__dirname, '..', 'assets', 'cert');
const leer = nombre => { try { return fs.readFileSync(path.join(ASSETS, nombre)); } catch (_) { return null; } };
const LOGO = leer('logo.png');
const FIRMA_DIRECTORA = leer('firma-directora.png');
const FIRMA_COORDINACION = leer('firma-coordinacion.png');

// Las fuentes estándar de PDF solo cubren Latin-1/CP1252: se conservan acentos y ñ y cualquier otro carácter se simplifica
const SOPORTADO = /[ -~ -ÿ–—‘’“”•…]/;
function seguro(texto) {
  return Array.from(String(texto == null ? '' : texto).normalize('NFC')).map(c => {
    if (SOPORTADO.test(c)) return c;
    const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return SOPORTADO.test(base) && base.length === 1 ? base : '';
  }).join('').replace(/\s+/g, ' ').trim();
}

function fechaLarga(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
}

function dibujarMedalla(doc, x0, y0) {
  doc.save(); doc.translate(x0, y0);
  doc.lineWidth(1.3).strokeColor(AZUL_OSCURO).circle(13, 10, 7).stroke();
  doc.lineWidth(0.8).strokeColor(TURQUESA).circle(13, 10, 4).stroke();
  doc.lineWidth(1.3).lineJoin('round').strokeColor(AZUL_OSCURO).moveTo(9, 16).lineTo(7, 25).lineTo(13, 21).lineTo(19, 25).lineTo(17, 16).stroke();
  doc.restore();
}

function dibujarSello(doc, x0, y0) {
  doc.save(); doc.translate(x0, y0).scale(86 / 90);
  doc.lineWidth(1.4).strokeColor(AZUL_OSCURO).circle(45, 40, 34).stroke();
  doc.lineWidth(0.8).strokeColor(TURQUESA).circle(45, 40, 27).stroke();
  doc.font('Times-Bold').fontSize(24).fillColor(AZUL_OSCURO).text('FT', 0, 27, { width: 90, align: 'center', lineBreak: false });
  doc.moveTo(30, 66).lineTo(24, 104).lineTo(45, 90).lineTo(66, 104).lineTo(60, 66).closePath().fill(AZUL_OSCURO);
  doc.moveTo(33, 68).lineTo(29, 96).lineTo(45, 85).lineTo(61, 96).lineTo(57, 68).closePath().fill(AZUL);
  doc.lineWidth(0.5).strokeColor(TURQUESA).dash(0.5, { space: 3 }).circle(45, 40, 34).stroke().undash();
  doc.restore();
}

async function generarPdf(cert, urlVerificacion) {
  const qr = await QRCode.toBuffer(urlVerificacion, { margin: 0, width: 288, errorCorrectionLevel: 'M', color: { dark: AZUL_OSCURO, light: '#FFFFFF' } });
  const doc = new PDFDocument({ size: [A4_ANCHO, A4_ALTO], margin: 0, info: { Title: 'Certificado ' + cert.folio, Author: 'Club FisioTeck', Subject: seguro(cert.cursoTitulo) } });
  const trozos = [];
  doc.on('data', c => trozos.push(c));
  const fin = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(trozos))); doc.on('error', reject); });

  // Se dibuja en el espacio 1040x735; pdfkit decide los saltos de página con las medidas SIN escalar, así que se le informa del espacio real
  doc.scale(A4_ANCHO / ANCHO);
  doc.page.width = ANCHO; doc.page.height = ALTO;
  const centro = ANCHO / 2;

  // Marcos
  doc.lineWidth(2.5).strokeColor(AZUL_OSCURO).rect(26, 26, 988, 683).stroke();
  doc.lineWidth(1).strokeColor(TURQUESA).rect(33, 33, 974, 669).stroke();
  doc.rect(26, 26, 988, 8).fill(AZUL_OSCURO); doc.rect(26, 701, 988, 8).fill(TURQUESA);

  // Logo y lema
  if (LOGO) doc.image(LOGO, centro - 118, 54, { height: 48 });
  else doc.font('Helvetica-Bold').fontSize(22).fillColor(AZUL_OSCURO).text('CLUB FISIOTECK', 0, 64, { width: ANCHO, align: 'center', characterSpacing: 3, lineBreak: false });
  doc.font('Helvetica').fontSize(10.5).fillColor(GRIS).text('FORMACIÓN CONSTANTE, RESULTADOS EXCELENTES', 0, 110, { width: ANCHO, align: 'center', characterSpacing: 2.2, lineBreak: false });

  // Medalla entre dos líneas
  doc.lineWidth(1).strokeColor(LINEA);
  doc.moveTo(centro - 13 - 14 - 90, 154).lineTo(centro - 13 - 14, 154).stroke();
  doc.moveTo(centro + 13 + 14, 154).lineTo(centro + 13 + 14 + 90, 154).stroke();
  dibujarMedalla(doc, centro - 13, 141);

  // Título
  doc.font('Times-Bold').fontSize(34).fillColor(AZUL_OSCURO).text('CERTIFICADO DE ACREDITACIÓN', 0, 176, { width: ANCHO, align: 'center', characterSpacing: 4, lineBreak: false });
  doc.rect(centro - 45, 226, 90, 2).fill(TURQUESA);

  // Destinatario
  doc.font('Helvetica').fontSize(14).fillColor(GRIS).text('Se otorga la presente constancia a', 0, 252, { width: ANCHO, align: 'center', lineBreak: false });
  const nombre = seguro(cert.nombre).toUpperCase() || 'ALUMNO';
  let tamNombre = 44;
  doc.font('Times-Bold');
  while (tamNombre > 22 && doc.fontSize(tamNombre).widthOfString(nombre, { characterSpacing: 2 }) > 700) tamNombre--;
  doc.fontSize(tamNombre).fillColor(AZUL_OSCURO).text(nombre, 0, 282 + (44 - tamNombre) / 2, { width: ANCHO, align: 'center', characterSpacing: 2, lineBreak: false });
  doc.rect(centro - 230, 344, 460, 1).fillOpacity(0.55).fill(AZUL).fillOpacity(1);

  doc.font('Helvetica').fontSize(13).fillColor(GRIS).text('Por haber acreditado satisfactoriamente el programa académico denominado:', 0, 368, { width: ANCHO, align: 'center', lineBreak: false });

  // Curso (se reduce si es muy largo)
  const curso = seguro(cert.cursoTitulo) || 'Programa académico';
  let tamCurso = 28;
  doc.font('Times-BoldItalic');
  while (tamCurso > 16 && doc.fontSize(tamCurso).heightOfString(curso, { width: 800, align: 'center' }) > 66) tamCurso--;
  const altoCurso = doc.fontSize(tamCurso).heightOfString(curso, { width: 800, align: 'center' });
  doc.fillColor(AZUL).text(curso, (ANCHO - 800) / 2, 396, { width: 800, align: 'center' });

  // Carga académica y fecha
  const clases = Number(cert.clases) || 0;
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(GRIS).text(('CARGA ACADÉMICA: ' + clases + (clases === 1 ? ' SESIÓN' : ' SESIONES') + '   |   MODALIDAD: EN LÍNEA').toUpperCase(), 0, 396 + altoCurso + 18, { width: ANCHO, align: 'center', characterSpacing: 1.4, lineBreak: false });
  doc.font('Helvetica-Oblique').fontSize(11).fillColor(GRIS).text('Emitido el ' + fechaLarga(cert.emitidoEn), 0, 396 + altoCurso + 38, { width: ANCHO, align: 'center', lineBreak: false });

  // Pie: QR · firma · firma · sello
  const base = 640;
  const hueco = (848 - (150 + 256 + 256 + 100)) / 3;
  const xQr = 96, xF1 = xQr + 150 + hueco, xF2 = xF1 + 256 + hueco, xSello = xF2 + 256 + hueco;
  doc.image(qr, xQr + 27, base - 128, { width: 96, height: 96 });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRIS).text('ESCANEA\nPARA VALIDAR', xQr, base - 128 + 96 + 8, { width: 150, align: 'center', characterSpacing: 1.6, lineGap: 3 });

  const firma = (x, imagen, nombreFirma, rol, inst) => {
    const top = base - 120;
    if (imagen) doc.image(imagen, x + (256 - 256 * 0.76) / 2, top, { fit: [256 * 0.76, 60], align: 'center', valign: 'bottom' });
    doc.lineWidth(1).strokeColor('#9AA9B8').moveTo(x, top + 70).lineTo(x + 256, top + 70).stroke();
    doc.font('Times-Bold').fontSize(15).fillColor(AZUL_OSCURO).text(nombreFirma, x, top + 80, { width: 256, align: 'center', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRIS).text(rol.toUpperCase(), x, top + 102, { width: 256, align: 'center', characterSpacing: 1.2, lineBreak: false });
    if (inst) doc.font('Helvetica').fontSize(8.5).fillColor(GRIS).text(inst, x, top + 116, { width: 256, align: 'center', lineBreak: false });
  };
  firma(xF1, FIRMA_DIRECTORA, 'Lic. Paulina Torres Montalvo', 'Directora Académica', 'Club FisioTeck');
  firma(xF2, FIRMA_COORDINACION, 'Coordinación de Certificación', 'IPCI Latinoamericano', '');
  dibujarSello(doc, xSello + 7, base - 112);

  // Barra inferior con el folio
  doc.lineWidth(1).strokeColor(LINEA).moveTo(48, 668).lineTo(ANCHO - 48, 668).stroke();
  const piezas = [{ t: 'Folio: ', f: 'Helvetica' }, { t: seguro(cert.folio), f: 'Helvetica-Bold' }, { t: '  ·  club.fisioteck.com  ·  Certificado emitido digitalmente por Club FisioTeck / IPCI Latinoamericano', f: 'Helvetica' }];
  doc.fontSize(9);
  const total = piezas.reduce((s, p) => s + doc.font(p.f).widthOfString(p.t), 0);
  let x = (ANCHO - total) / 2;
  for (const p of piezas) { doc.font(p.f).fillColor(GRIS).text(p.t, x, 678, { lineBreak: false }); x += doc.widthOfString(p.t); }

  doc.end();
  return fin;
}

module.exports = { generarPdf, seguro };
