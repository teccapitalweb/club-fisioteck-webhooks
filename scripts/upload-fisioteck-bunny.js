'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tus = require('tus-js-client');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.bunny-fisioteck');
const OUTPUT_DIR = path.join(ROOT, 'migration-output');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'fisioteck-upload-manifest.json');
const MANIFEST_CSV_PATH = path.join(OUTPUT_DIR, 'fisioteck-upload-manifest.csv');
const STATE_PATH = path.join(OUTPUT_DIR, 'fisioteck-upload-state.json');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`No existe el archivo de entorno: ${filePath}`);
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function normalizedKey(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toUpperCase();
}

const COURSE_NAMES = new Map([
  ['ESTIMULACION NEUROPLASTICA EN REHABILITACION NEUROLOGICA', 'Estimulación neuroplástica en rehabilitación neurológica'],
  ['FISIOPATOLOGIA LESIONES DEPORTIVAS MAS COMUNES', 'Fisiopatología de las lesiones deportivas más comunes'],
  ['FISIOTERAPIA PULMONAR HIPOXEMIA VENTILACION', 'Fisioterapia pulmonar: hipoxemia y ventilación'],
  ['FISIOTERAPIA RESPIRATORIA EN PACIENTES GERIATRICOS', 'Fisioterapia respiratoria en pacientes geriátricos'],
  ['LIBERACION MIOFASCIAL ESTETICA FACIAL Y CORPORAL', 'Liberación miofascial estética facial y corporal'],
  ['MANEJO DEL DOLOR EN TERAPIA FISICA', 'Manejo del dolor en terapia física'],
  ['MANEJO DEL DOLOR LUMBAR CRONICO', 'Manejo del dolor lumbar crónico'],
  ['MEJORA DE LA MOVILIDAD Y LA FUNCION MOTORA EN PACIENTES GERIATRICOS', 'Mejora de la movilidad y la función motora en pacientes geriátricos'],
  ['NEUROPLASTICIDAD Y REHABILITACION FUNCIONAL', 'Neuroplasticidad y rehabilitación funcional'],
  ['REHABILITACION DEPORTIVA', 'Rehabilitación deportiva'],
  ['REHABILITACION EN HIPERTENSION PULMUNAR Y ENFERMEDADES VASCULARES PULMUNARES', 'Rehabilitación en hipertensión pulmonar y enfermedades vasculares pulmonares'],
  ['TERAPIA MANUAL ORTOPEDICA FUNCIONAL', 'Terapia manual ortopédica funcional'],
  ['TRATAMIENTO FISIOTERAPEUTICO EN PARALISIS CEREBLAL INFANTIL', 'Tratamiento fisioterapéutico en parálisis cerebral infantil'],
  ['TRATAMIENTO FISIOTERAPEUTICO EN PARALISIS CEREBRAL INFANTIL', 'Tratamiento fisioterapéutico en parálisis cerebral infantil'],
  ['VENDAJE NEUROMUSCULAR AVANZADO EN ORTOPEDIA', 'Vendaje neuromuscular avanzado en ortopedia']
]);

function canonicalCourseName(rawName) {
  const withoutDriveSuffix = rawName.replace(/-?\d{8}T\d{6}Z-\d+-\d+$/i, '').trim();
  return COURSE_NAMES.get(normalizedKey(withoutDriveSuffix)) || withoutDriveSuffix
    .toLocaleLowerCase('es-MX')
    .replace(/(^|[.!?]\s+)(\p{L})/gu, (_, prefix, letter) => prefix + letter.toLocaleUpperCase('es-MX'));
}

function isMp4(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return bytesRead >= 12 && header.toString('ascii', 4, 8) === 'ftyp';
  } finally {
    fs.closeSync(fd);
  }
}

function walkFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

function lessonInfo(fileName) {
  const knownExtension = /\.(mp4|mov|m4v|avi|mkv|wmv|webm|mts|m2ts)$/i;
  const sourceTitle = fileName.replace(knownExtension, '');
  const match = sourceTitle.match(/CLASES?\s*(?:NO\.?\s*)?(.+)/i);
  if (!match) return { order: 999, sessionNumbers: [], label: sourceTitle.trim() };
  const sessionNumbers = [...match[1].matchAll(/\d+/g)].map(item => Number(item[0]));
  if (!sessionNumbers.length) return { order: 999, sessionNumbers: [], label: sourceTitle.trim() };
  const formatted = sessionNumbers.map(number => String(number).padStart(2, '0'));
  const label = formatted.length === 1
    ? `Sesión ${formatted[0]}`
    : `Sesiones ${formatted.slice(0, -1).join(', ')} y ${formatted.at(-1)}`;
  return {
    order: sessionNumbers[0],
    sessionNumbers,
    label
  };
}

function buildManifest(sourceDir) {
  const videos = [];
  for (const filePath of walkFiles(sourceDir)) {
    if (!isMp4(filePath)) continue;
    const stat = fs.statSync(filePath);
    const rawCourse = path.basename(path.dirname(filePath));
    const course = canonicalCourseName(rawCourse);
    const lesson = lessonInfo(path.basename(filePath));
    videos.push({
      course,
      collectionName: course,
      lessonOrder: lesson.order,
      sessionNumbers: lesson.sessionNumbers,
      title: `${course} — ${lesson.label}`,
      sourceFileName: path.basename(filePath),
      relativePath: path.relative(sourceDir, filePath),
      sourcePath: filePath,
      sizeBytes: stat.size,
      sizeMB: Number((stat.size / 1024 / 1024).toFixed(2)),
      detectedFormat: 'video/mp4'
    });
  }
  videos.sort((a, b) => a.course.localeCompare(b.course, 'es') || a.lessonOrder - b.lessonOrder || a.title.localeCompare(b.title, 'es'));
  return videos;
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join('|') : String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function writeManifest(videos, sourceDir) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const courses = [...new Set(videos.map(video => video.course))];
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: sourceDir,
    courseCount: courses.length,
    videoCount: videos.length,
    totalBytes: videos.reduce((sum, video) => sum + video.sizeBytes, 0),
    courses: courses.map(course => ({
      name: course,
      videoCount: videos.filter(video => video.course === course).length
    })),
    videos
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const headers = ['course', 'lessonOrder', 'sessionNumbers', 'title', 'sourceFileName', 'relativePath', 'sizeBytes', 'sizeMB', 'detectedFormat'];
  const rows = videos.map(video => headers.map(header => csvEscape(video[header])).join(','));
  fs.writeFileSync(MANIFEST_CSV_PATH, `${headers.map(csvEscape).join(',')}\n${rows.join('\n')}\n`, 'utf8');
  return payload;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { version: 1, collections: {}, videos: {} };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, STATE_PATH);
}

async function apiJson(libraryId, apiKey, endpoint, options = {}) {
  const method = options.method || 'GET';
  const maximumAttempts = method === 'GET' ? 8 : 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(`https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}${endpoint}`, {
        method,
        headers: {
          AccessKey: apiKey,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) {
        const error = new Error(`Bunny respondió ${response.status} al solicitar ${endpoint}`);
        error.statusCode = response.status;
        error.details = data;
        throw error;
      }
      return data;
    } catch (error) {
      const retryable = method === 'GET' && (!error.statusCode || error.statusCode === 429 || error.statusCode >= 500);
      if (!retryable || attempt === maximumAttempts) throw error;
      const delay = Math.min(60_000, attempt * 5_000);
      console.log(`Conexión temporalmente interrumpida; reintento GET ${attempt}/${maximumAttempts} en ${delay / 1000}s.`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function listAll(libraryId, apiKey, resource) {
  const items = [];
  let page = 1;
  while (true) {
    const data = await apiJson(libraryId, apiKey, `/${resource}?page=${page}&itemsPerPage=100`);
    items.push(...(data.items || []));
    if (items.length >= Number(data.totalItems || 0) || !(data.items || []).length) return items;
    page += 1;
  }
}

function uploadTus(libraryId, apiKey, videoId, filePath, title, collectionId, record, persistState) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const expirationTime = Math.floor(Date.now() / 1000) + (48 * 60 * 60);
    const signature = crypto
      .createHash('sha256')
      .update(`${libraryId}${apiKey}${expirationTime}${videoId}`)
      .digest('hex');
    const stream = fs.createReadStream(filePath);
    let lastReportedPercentage = -5;
    let lastPersistedAt = 0;
    const upload = new tus.Upload(stream, {
      endpoint: 'https://video.bunnycdn.com/tusupload',
      uploadUrl: record.tusUploadUrl || null,
      uploadSize: stat.size,
      chunkSize: 32 * 1024 * 1024,
      retryDelays: [0, 3_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 180_000, 300_000],
      headers: {
        AuthorizationSignature: signature,
        AuthorizationExpire: String(expirationTime),
        LibraryId: String(libraryId),
        VideoId: String(videoId)
      },
      metadata: {
        filetype: 'video/mp4',
        title,
        collection: collectionId
      },
      onUploadUrlAvailable() {
        if (upload.url && record.tusUploadUrl !== upload.url) {
          record.tusUploadUrl = upload.url;
          persistState();
        }
      },
      onProgress(bytesUploaded, bytesTotal) {
        const percentage = Math.floor((bytesUploaded / bytesTotal) * 100);
        const now = Date.now();
        if (percentage >= lastReportedPercentage + 5 || percentage === 100) {
          lastReportedPercentage = percentage;
          console.log(`    ${percentage}% | ${title}`);
        }
        if (now - lastPersistedAt >= 15_000 || percentage === 100) {
          lastPersistedAt = now;
          record.bytesUploaded = bytesUploaded;
          record.bytesTotal = bytesTotal;
          record.progress = percentage;
          persistState();
        }
      },
      onError(error) {
        stream.destroy();
        reject(new Error(`TUS no pudo subir ${path.basename(filePath)}: ${error.message}`));
      },
      onSuccess() {
        record.bytesUploaded = stat.size;
        record.bytesTotal = stat.size;
        record.progress = 100;
        persistState();
        resolve(upload.url);
      }
    });
    upload.start();
  });
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

async function main() {
  loadEnv(ENV_PATH);
  const sourceDir = path.resolve(process.env.FISIOTECK_SOURCE_DIR || '');
  if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error(`No existe FISIOTECK_SOURCE_DIR: ${sourceDir}`);

  const videos = buildManifest(sourceDir);
  const summary = writeManifest(videos, sourceDir);
  console.log(`Auditoría local: ${summary.courseCount} cursos, ${summary.videoCount} videos, ${(summary.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB.`);
  for (const course of summary.courses) console.log(`  ${course.videoCount} videos | ${course.name}`);
  console.log(`Inventario: ${MANIFEST_PATH}`);

  const args = new Set(process.argv.slice(2));
  const verifyOnly = args.has('--verify');
  const shouldUpload = args.has('--upload') && process.env.BUNNY_UPLOAD_DRY_RUN === 'false';
  if (!shouldUpload && !verifyOnly) {
    console.log('SIMULACIÓN COMPLETADA: no se creó ni subió nada a Bunny.');
    return;
  }

  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  if (!libraryId || !apiKey) throw new Error('Faltan BUNNY_STREAM_LIBRARY_ID o BUNNY_STREAM_API_KEY.');

  const collections = await listAll(libraryId, apiKey, 'collections');
  const remoteVideos = await listAll(libraryId, apiKey, 'videos');
  console.log(`Conexión Bunny correcta: ${collections.length} colecciones y ${remoteVideos.length} videos existentes.`);

  const state = loadState();
  if (verifyOnly) {
    const byId = new Map(remoteVideos.map(video => [video.guid, video]));
    let found = 0;
    for (const record of Object.values(state.videos)) {
      const remote = byId.get(record.videoId);
      if (!remote) console.log(`NO ENCONTRADO | ${record.title}`);
      else {
        found += 1;
        console.log(`${remote.status === 4 ? 'LISTO' : `ESTADO ${remote.status}`} | ${remote.encodeProgress}% | ${record.title}`);
      }
    }
    console.log(`Verificación: ${found}/${Object.keys(state.videos).length} videos localizados en Bunny.`);
    return;
  }

  const collectionByName = new Map(collections.map(collection => [collection.name.toLocaleLowerCase('es-MX'), collection]));
  for (const course of summary.courses) {
    const key = course.name.toLocaleLowerCase('es-MX');
    let collection = collectionByName.get(key);
    if (!collection) {
      const previousName = Object.keys(state.collections).find(name => canonicalCourseName(name) === course.name);
      const previousGuid = previousName ? state.collections[previousName] : null;
      const previousCollection = previousGuid ? collections.find(item => item.guid === previousGuid) : null;
      if (previousCollection) {
        await apiJson(libraryId, apiKey, `/collections/${encodeURIComponent(previousGuid)}`, {
          method: 'POST',
          body: { name: course.name }
        });
        collection = { ...previousCollection, name: course.name };
        collectionByName.set(key, collection);
        if (previousName !== course.name) delete state.collections[previousName];
        console.log(`Colección renombrada: ${course.name}`);
      }
    }
    if (!collection) {
      collection = await apiJson(libraryId, apiKey, '/collections', { method: 'POST', body: { name: course.name } });
      collectionByName.set(key, collection);
      console.log(`Colección creada: ${course.name}`);
    } else {
      console.log(`Colección reutilizada: ${course.name}`);
    }
    state.collections[course.name] = collection.guid;
    saveState(state);
  }

  const concurrency = Math.max(1, Math.min(Number(process.env.BUNNY_UPLOAD_CONCURRENCY) || 1, 3));
  await runPool(videos, concurrency, async (video, index) => {
    const stateKey = video.relativePath;
    const collectionId = state.collections[video.course];
    let record = state.videos[stateKey];
    if (record && (record.title !== video.title || record.collectionId !== collectionId)) {
      await apiJson(libraryId, apiKey, `/videos/${encodeURIComponent(record.videoId)}`, {
        method: 'POST',
        body: { title: video.title, collectionId }
      });
      record.title = video.title;
      record.collectionId = collectionId;
      saveState(state);
      console.log(`[${index + 1}/${videos.length}] Nombre normalizado: ${video.title}`);
    }
    if (record?.status === 'uploaded') {
      console.log(`[${index + 1}/${videos.length}] Ya subido: ${video.title}`);
      return;
    }
    if (!record) {
      const existing = remoteVideos.find(item => item.collectionId === collectionId && item.title === video.title);
      if (existing) {
        const alreadyHasContent = Number(existing.storageSize || 0) > 0 || Number(existing.status || 0) > 0;
        record = { videoId: existing.guid, collectionId, title: video.title, status: alreadyHasContent ? 'uploaded' : 'created', reused: true };
      } else {
        const created = await apiJson(libraryId, apiKey, '/videos', {
          method: 'POST',
          body: { title: video.title, collectionId }
        });
        record = { videoId: created.guid, collectionId, title: video.title, status: 'created', reused: false };
      }
      state.videos[stateKey] = record;
      saveState(state);
    }
    if (record.status !== 'uploaded') {
      console.log(`[${index + 1}/${videos.length}] Subiendo ${video.sizeMB} MB: ${video.title}`);
      await uploadTus(
        libraryId,
        apiKey,
        record.videoId,
        video.sourcePath,
        video.title,
        collectionId,
        record,
        () => saveState(state)
      );
      record.status = 'uploaded';
      record.uploadedAt = new Date().toISOString();
      saveState(state);
      console.log(`[${index + 1}/${videos.length}] Carga aceptada: ${video.title}`);
    }
  });
  console.log(`CARGA COMPLETADA: ${videos.length} videos enviados a Bunny Stream.`);
  console.log('Ejecuta npm run bunny:verify para revisar el progreso de codificación.');
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  if (error.statusCode === 401) console.error('Usa la Stream API Key de la misma biblioteca indicada por BUNNY_STREAM_LIBRARY_ID.');
  process.exitCode = 1;
});
