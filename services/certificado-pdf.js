// PDF del certificado (carta horizontal) con QR de verificación.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const AZUL = '#0D5FA0';
const AZUL_OSCURO = '#0A3E68';
const TURQUESA = '#159E92';
const GRIS = '#5B7186';

function fechaLarga(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
}

async function generarPdf(cert, urlVerificacion) {
  const qr = await QRCode.toBuffer(urlVerificacion, { margin: 1, width: 220, color: { dark: AZUL_OSCURO, light: '#FFFFFF' } });
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0, info: { Title: 'Certificado ' + cert.folio, Author: 'Club FisioTeck' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const fin = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  const W = doc.page.width, H = doc.page.height;

  doc.rect(0, 0, W, H).fill('#FFFFFF');
  doc.rect(0, 0, W, 14).fill(AZUL);
  doc.rect(0, H - 14, W, 14).fill(TURQUESA);
  doc.lineWidth(1.2).strokeColor('#BFD5E8').rect(30, 34, W - 60, H - 68).stroke();

  doc.fillColor(AZUL_OSCURO).font('Helvetica-Bold').fontSize(20).text('CLUB FISIOTECK', 0, 62, { align: 'center', characterSpacing: 3 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(11).text('Formación constante, resultados excelentes', 0, 88, { align: 'center' });

  doc.fillColor(TURQUESA).font('Helvetica-Bold').fontSize(12).text('CERTIFICADO DE FINALIZACIÓN', 0, 128, { align: 'center', characterSpacing: 4 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(13).text('Se otorga a', 0, 160, { align: 'center' });
  doc.fillColor(AZUL_OSCURO).font('Helvetica-Bold').fontSize(34).text(cert.nombre, 60, 184, { align: 'center', width: W - 120 });
  doc.fillColor(GRIS).font('Helvetica').fontSize(13).text('por haber completado las ' + (cert.clases || '') + ' clases del curso', 0, 244, { align: 'center' });
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(20).text(cert.cursoTitulo, 90, 270, { align: 'center', width: W - 180 });

  doc.fillColor(GRIS).font('Helvetica').fontSize(11).text('Emitido el ' + fechaLarga(cert.emitidoEn), 0, 345, { align: 'center' });
  doc.image(qr, 70, H - 150, { width: 86 });
  doc.fillColor(GRIS).fontSize(9).text('Verifica este certificado', 70, H - 58, { width: 86, align: 'center' });
  doc.fillColor(AZUL_OSCURO).font('Helvetica-Bold').fontSize(11).text('Folio ' + cert.folio, W - 270, H - 118, { width: 200, align: 'right' });
  doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(urlVerificacion, W - 420, H - 98, { width: 350, align: 'right' });

  doc.end();
  return fin;
}

module.exports = { generarPdf };
