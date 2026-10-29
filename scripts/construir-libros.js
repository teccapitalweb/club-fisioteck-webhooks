'use strict';
// Convierte los libros originales de FisioTeck (libros-fuente/<carpeta>/*.md) en PDF (libros-privados/<carpeta>.pdf) y actualiza data/libros-base.json.
// Uso:  node scripts/construir-libros.js            (todos)     node scripts/construir-libros.js biomecanica   (uno)
// Formato Markdown admitido: # Capítulo, ## Sección, ### Subsección, párrafos, listas (- / 1.), citas (> ), **negritas** y *cursivas*.
// Fuentes: Georgia (texto) y Arial (títulos) de Windows, incrustadas en el PDF. El PDF se genera aquí y se sube ya hecho: el servidor no necesita esas fuentes.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const RAIZ = path.join(__dirname, '..');
const FUENTES = path.join(RAIZ, 'libros-fuente'), SALIDA = path.join(RAIZ, 'libros-privados'), BASE = path.join(RAIZ, 'data', 'libros-base.json');
const F = { texto: 'C:/Windows/Fonts/georgia.ttf', negrita: 'C:/Windows/Fonts/georgiab.ttf', cursiva: 'C:/Windows/Fonts/georgiai.ttf', negritaCursiva: 'C:/Windows/Fonts/georgiaz.ttf', titulo: 'C:/Windows/Fonts/arialbd.ttf', ligera: 'C:/Windows/Fonts/arial.ttf' };

const LIBROS = [
  { carpeta: 'anatomia-fisiologia', id: 'ft-anatomia-fisiologia', titulo: 'Anatomía y fisiología esenciales para fisioterapeutas', orden: 1,
    descripcion: 'Del tejido al movimiento: organización del cuerpo, huesos, articulaciones, músculo, sistema nervioso, corazón, pulmón y reparación de tejidos, explicados para quien trata personas.' },
  { carpeta: 'biomecanica', id: 'ft-biomecanica', titulo: 'Biomecánica y física del movimiento humano', orden: 2,
    descripcion: 'Fuerzas, palancas, equilibrio, marcha, postura y propiedades mecánicas de los tejidos, con ejemplos clínicos y ergonómicos para la consulta.' },
  { carpeta: 'dolor-neurociencia', id: 'ft-dolor-neurociencia', titulo: 'Dolor, neurociencia y comunicación con el paciente', orden: 3,
    descripcion: 'Cómo se produce el dolor, por qué persiste y cómo explicarlo, escuchar y acompañar: entrevista, educación, adherencia, seguridad y ética.' },
  { carpeta: 'ejercicio-terapeutico', id: 'ft-ejercicio-terapeutico', titulo: 'Ejercicio terapéutico: principios, dosificación y progresión', orden: 4,
    descripcion: 'Principios del entrenamiento, fuerza, resistencia, movilidad, equilibrio y control motor; cómo dosificar, progresar y mantener seguro un programa.' },
  { carpeta: 'valoracion-clinica', id: 'ft-valoracion-clinica', titulo: 'Valoración fisioterapéutica y razonamiento clínico', orden: 5,
    descripcion: 'Del motivo de consulta al plan: entrevista, observación, medición, escalas, objetivos, documentación, bioseguridad y ética profesional.' }
];

// ---------- Markdown → bloques ----------
function inline(texto) {
  const partes = []; const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g; let ult = 0, m;
  while ((m = re.exec(texto)) !== null) {
    if (m.index > ult) partes.push({ t: texto.slice(ult, m.index) });
    const raw = m[0]; if (raw.startsWith('**')) partes.push({ t: raw.slice(2, -2), b: true }); else partes.push({ t: raw.slice(1, -1), i: true });
    ult = m.index + raw.length;
  }
  if (ult < texto.length) partes.push({ t: texto.slice(ult) });
  return partes.filter(p => p.t);
}
function bloques(md) {
  const L = md.replace(/\r/g, '').split('\n'), out = []; let par = [], cita = [], lista = null;
  const cerrarPar = () => { if (par.length) { out.push({ tipo: 'p', t: par.join(' ') }); par = []; } };
  const cerrarCita = () => { if (cita.length) { out.push({ tipo: 'cita', t: cita.join(' ') }); cita = []; } };
  const cerrarLista = () => { if (lista) { out.push(lista); lista = null; } };
  const cerrarTodo = () => { cerrarPar(); cerrarCita(); cerrarLista(); };
  for (const crudo of L) {
    const l = crudo.trimEnd();
    if (!l.trim()) { cerrarTodo(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(l))) { cerrarTodo(); out.push({ tipo: 'h' + m[1].length, t: m[2].trim() }); continue; }
    if ((m = /^>\s?(.*)$/.exec(l))) { cerrarPar(); cerrarLista(); cita.push(m[1].trim()); continue; }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(l))) { cerrarPar(); cerrarCita(); if (!lista || lista.tipo !== 'ul') { cerrarLista(); lista = { tipo: 'ul', items: [] }; } lista.items.push(m[1].trim()); continue; }
    if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(l))) { cerrarPar(); cerrarCita(); if (!lista || lista.tipo !== 'ol') { cerrarLista(); lista = { tipo: 'ol', items: [] }; } lista.items.push(m[2].trim()); continue; }
    if (lista && /^\s+\S/.test(l)) { lista.items[lista.items.length - 1] += ' ' + l.trim(); continue; } // continuación de un elemento de lista
    cerrarCita(); cerrarLista(); par.push(l.trim());
  }
  cerrarTodo();
  return out;
}

// ---------- PDF ----------
const COLOR = { azul: '#0A3E68', acento: '#0D5FA0', texto: '#1b2430', suave: '#5b6b7b', linea: '#c9d6e2', fondoNota: '#EEF5FB' };
function construir(libro) {
  const dir = path.join(FUENTES, libro.carpeta);
  if (!fs.existsSync(dir)) throw new Error('No existe ' + dir);
  const archivos = fs.readdirSync(dir).filter(f => /\.md$/i.test(f)).sort();
  if (!archivos.length) throw new Error('Sin capítulos en ' + dir);
  const capitulos = archivos.map(f => ({ archivo: f, bloques: bloques(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  const palabras = capitulos.reduce((t, c) => t + c.bloques.reduce((a, b) => a + ((b.t || (b.items || []).join(' ')) || '').split(/\s+/).filter(Boolean).length, 0), 0);

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 78, bottom: 78, left: 82, right: 82 }, bufferPages: true, info: { Title: libro.titulo, Author: 'FisioTeck', Subject: 'Libro de educación continua del Club FisioTeck', Keywords: 'fisioterapia, rehabilitación' } });
  const salida = path.join(SALIDA, libro.carpeta + '.pdf'); fs.mkdirSync(SALIDA, { recursive: true });
  doc.pipe(fs.createWriteStream(salida));
  for (const [k, v] of Object.entries(F)) doc.registerFont(k, v);
  const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const nuevaPagina = () => doc.addPage();

  // Portada
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLOR.azul);
  doc.rect(0, 250, doc.page.width, 6).fill('#F5C75B');
  doc.fillColor('#9CC9EC').font('titulo').fontSize(11).text('FISIOTECK · CLUB DE EDUCACIÓN CONTINUA', 82, 120, { characterSpacing: 2 });
  doc.fillColor('#FFFFFF').font('titulo').fontSize(33).text(libro.titulo, 82, 290, { width: ancho, lineGap: 6 });
  doc.fillColor('#DCEBF7').font('texto').fontSize(13).text(libro.descripcion, 82, doc.y + 24, { width: ancho - 40, lineGap: 4 });
  doc.fillColor('#9CC9EC').font('ligera').fontSize(10).text('Edición 2026 · Obra original de FisioTeck', 82, doc.page.height - 110);
  // Aviso legal
  nuevaPagina();
  doc.fillColor(COLOR.azul).font('titulo').fontSize(16).text('Aviso legal y de uso', 82, 100);
  doc.moveDown(1).fillColor(COLOR.texto).font('texto').fontSize(10.5).text(
    'Esta es una obra original de FisioTeck, elaborada con texto propio a partir de conocimiento científico de uso general. Todos los derechos reservados. Se entrega a los miembros del Club FisioTeck para su estudio personal; no puede copiarse, revenderse ni redistribuirse sin autorización por escrito.\n\n' +
    'Es material educativo y no sustituye el criterio clínico, la formación presencial supervisada ni las normas de tu institución, región o colegio profesional. Los ejemplos clínicos son ilustrativos y no son prescripciones. Ante un caso real, valora a la persona, consulta fuentes actualizadas y, cuando corresponda, deriva a atención médica.\n\n' +
    'Las lecturas recomendadas del final se citan solo como referencia: no se copió su contenido. Cuando se menciona una obra de licencia abierta (por ejemplo, de OpenStax, CC BY 4.0), es solo como lectura sugerida.', { width: ancho, lineGap: 4, align: 'left' });
  // Índice (se llena después)
  nuevaPagina(); const paginaIndice = doc.bufferedPageRange().count - 1;
  const entradas = [];

  // Contenido
  for (const cap of capitulos) {
    nuevaPagina();
    let primera = true;
    for (const b of cap.bloques) {
      if (b.tipo === 'h1') {
        entradas.push({ nivel: 1, t: b.t, pag: doc.bufferedPageRange().count });
        const m = /^(cap[ií]tulo\s+\d+)[.:]\s*(.*)$/i.exec(b.t);
        doc.y = 150;
        if (m) { doc.fillColor(COLOR.acento).font('titulo').fontSize(11).text(m[1].toUpperCase(), { characterSpacing: 3 }); doc.moveDown(0.4); doc.fillColor(COLOR.azul).font('titulo').fontSize(24).text(m[2], { lineGap: 4 }); }
        else { doc.fillColor(COLOR.azul).font('titulo').fontSize(24).text(b.t, { lineGap: 4 }); }
        doc.moveDown(0.5); doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + 80, doc.y).lineWidth(3).strokeColor('#F5C75B').stroke(); doc.moveDown(1.6);
        primera = false; continue;
      }
      if (primera) { doc.y = 150; primera = false; }
      if (b.tipo === 'h2') { if (doc.y > doc.page.height - 170) nuevaPagina(); doc.moveDown(0.9); doc.fillColor(COLOR.azul).font('titulo').fontSize(15).text(b.t, { width: ancho, lineGap: 3 }); doc.moveDown(0.45); continue; }
      if (b.tipo === 'h3') { if (doc.y > doc.page.height - 150) nuevaPagina(); doc.moveDown(0.6); doc.fillColor(COLOR.acento).font('titulo').fontSize(12.5).text(b.t, { width: ancho, lineGap: 2 }); doc.moveDown(0.3); continue; }
      if (b.tipo === 'p') { parrafo(doc, b.t, { ancho }); doc.moveDown(0.7); continue; }
      if (b.tipo === 'ul' || b.tipo === 'ol') {
        b.items.forEach((it, i) => { const marca = b.tipo === 'ul' ? '•' : (i + 1) + '.'; const x = doc.page.margins.left; const y0 = doc.y; if (y0 > doc.page.height - 110) nuevaPagina(); doc.fillColor(COLOR.acento).font('negrita').fontSize(11.5).text(marca, x + 4, doc.y, { width: 22, continued: false });
          doc.y = doc.y - 16.5; parrafo(doc, it, { x: x + 28, ancho: ancho - 28 }); doc.moveDown(0.35); });
        doc.moveDown(0.4); continue;
      }
      if (b.tipo === 'cita') {
        const x = doc.page.margins.left; doc.font('cursiva').fontSize(11); const alto = doc.heightOfString(b.t.replace(/\*+/g, ''), { width: ancho - 34, lineGap: 4 }) + 22;
        if (doc.y + alto > doc.page.height - 80) nuevaPagina();
        const y = doc.y; doc.rect(x, y, ancho, alto).fill(COLOR.fondoNota); doc.rect(x, y, 4, alto).fill(COLOR.acento);
        doc.y = y + 11; parrafo(doc, b.t, { x: x + 20, ancho: ancho - 34, fuente: 'cursiva', color: COLOR.azul, tam: 11 }); doc.y = y + alto + 12; continue;
      }
    }
  }
  // Índice
  doc.switchToPage(paginaIndice);
  doc.fillColor(COLOR.azul).font('titulo').fontSize(20).text('Contenido', 82, 100); doc.moveDown(1.2);
  for (const e of entradas) { const t = e.t.replace(/^cap[ií]tulo\s+(\d+)[.:]\s*/i, '$1. '); doc.fillColor(COLOR.texto).font('texto').fontSize(11.5); const y = doc.y; doc.text(t, 82, y, { width: ancho - 40, lineBreak: true }); doc.text(String(e.pag), 82 + ancho - 36, y, { width: 36, align: 'right' }); doc.moveDown(0.5); }
  // Pie con número de página y título (desde el aviso legal)
  const total = doc.bufferedPageRange().count;
  for (let i = 2; i < total; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 48; doc.page.margins.bottom = 0;
    doc.moveTo(82, y - 8).lineTo(82 + ancho, y - 8).lineWidth(0.5).strokeColor(COLOR.linea).stroke();
    doc.fillColor(COLOR.suave).font('ligera').fontSize(8.5).text(libro.titulo, 82, y, { width: ancho - 50, lineBreak: false }); doc.text(String(i + 1), 82 + ancho - 40, y, { width: 40, align: 'right', lineBreak: false });
  }
  doc.end();
  return new Promise(resolve => doc.on('end', () => resolve({ salida, paginas: total, palabras })));
}
// Párrafo con negritas y cursivas incrustadas
function parrafo(doc, texto, o) {
  const partes = inline(texto), x = o.x === undefined ? doc.page.margins.left : o.x;
  doc.fillColor(o.color || COLOR.texto).fontSize(o.tam || 11.5);
  partes.forEach((p, i) => {
    doc.font(o.fuente === 'cursiva' ? (p.b ? 'negritaCursiva' : 'cursiva') : p.b && p.i ? 'negritaCursiva' : p.b ? 'negrita' : p.i ? 'cursiva' : 'texto');
    const ultimo = i === partes.length - 1;
    if (i === 0) doc.text(p.t, x, doc.y, { width: o.ancho, align: 'justify', lineGap: o.tam ? 4 : 4.6, continued: !ultimo });
    else doc.text(p.t, { width: o.ancho, align: 'justify', lineGap: 4.6, continued: !ultimo });
  });
}

(async () => {
  const solo = process.argv[2];
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  for (const libro of LIBROS.filter(l => !solo || l.carpeta === solo)) {
    const r = await construir(libro);
    console.log(libro.carpeta + ': ' + r.paginas + ' páginas · ' + r.palabras + ' palabras');
    const prev = base.libros.findIndex(l => l.id === libro.id);
    const ficha = { id: libro.id, titulo: libro.titulo, autor: 'FisioTeck', idioma: 'Español', descripcion: libro.descripcion, portada: '', archivo: libro.carpeta + '.pdf', paginas: r.paginas, requiereRetos: 10, orden: libro.orden, activo: true, licencia: 'Obra original FisioTeck', fuente: 'FisioTeck' };
    if (prev >= 0) base.libros[prev] = ficha; else base.libros.push(ficha);
  }
  fs.writeFileSync(BASE, JSON.stringify(base, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
