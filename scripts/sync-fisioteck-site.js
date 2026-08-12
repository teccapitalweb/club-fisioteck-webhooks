'use strict';

const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const siteRoot = path.resolve(backendRoot, '..', 'club-fisioteck');
const envPath = path.join(backendRoot, '.env.bunny-fisioteck');
const manifestPath = path.join(backendRoot, 'migration-output', 'fisioteck-upload-manifest.json');
const statePath = path.join(backendRoot, 'migration-output', 'fisioteck-upload-state.json');
const siteContentPath = path.join(siteRoot, 'data', 'content.json');

function loadEnv(filePath) {
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

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toUpperCase();
}

const metadataAliases = new Map([
  ['FISIOPATOLOGIA DE LAS LESIONES DEPORTIVAS MAS COMUNES', 'FISIOPATOLOGIA LESIONES DEPORTIVAS MAS COMUNES'],
  ['FISIOTERAPIA PULMONAR HIPOXEMIA Y VENTILACION', 'FISIOTERAPIA PULMONAR HIPOXEMIA VENTILACION']
]);

function formatDuration(seconds) {
  const totalMinutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  if (!minutes) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

function lessonDisplayTitle(courseTitle, fullTitle) {
  const prefix = `${courseTitle} — `;
  return fullTitle.startsWith(prefix) ? fullTitle.slice(prefix.length) : fullTitle;
}

async function listAllVideos(libraryId, apiKey) {
  const videos = [];
  let page = 1;
  while (true) {
    const response = await fetch(`https://video.bunnycdn.com/library/${encodeURIComponent(libraryId)}/videos?page=${page}&itemsPerPage=100`, {
      headers: { AccessKey: apiKey, Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Bunny respondió ${response.status} al consultar videos.`);
    const data = await response.json();
    videos.push(...(data.items || []));
    if (videos.length >= Number(data.totalItems || 0) || !(data.items || []).length) return videos;
    page += 1;
  }
}

async function main() {
  loadEnv(envPath);
  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  if (!libraryId || !apiKey) throw new Error('Faltan las credenciales locales de Bunny Stream.');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const previousSiteData = JSON.parse(fs.readFileSync(siteContentPath, 'utf8'));
  const remoteVideos = await listAllVideos(libraryId, apiKey);
  const remoteById = new Map(remoteVideos.map(video => [video.guid, video]));

  if (manifest.courseCount !== 14 || manifest.videoCount !== 58) {
    throw new Error(`El inventario esperado es 14 cursos y 58 videos; se encontraron ${manifest.courseCount} y ${manifest.videoCount}.`);
  }

  const duplicateRemoteTitles = remoteVideos
    .map(video => `${video.collectionId}:${video.title}`)
    .filter((key, index, all) => all.indexOf(key) !== index);
  if (duplicateRemoteTitles.length) throw new Error('Bunny contiene títulos duplicados dentro de una colección.');

  const previousByNormalizedTitle = new Map(
    (previousSiteData.courses || []).map(course => [normalize(course.title), course])
  );

  const courses = manifest.courses.map(courseSummary => {
    const title = courseSummary.name;
    const normalizedTitle = normalize(title);
    const previousKey = metadataAliases.get(normalizedTitle) || normalizedTitle;
    const previous = previousByNormalizedTitle.get(previousKey);
    if (!previous) throw new Error(`No se encontró metadata visual previa para: ${title}`);

    const courseVideos = manifest.videos
      .filter(video => video.course === title)
      .sort((left, right) => left.lessonOrder - right.lessonOrder || left.title.localeCompare(right.title, 'es'));
    if (courseVideos.length !== courseSummary.videoCount) throw new Error(`Conteo inconsistente en: ${title}`);
    if ((previous.lessons || []).length !== courseVideos.length) {
      throw new Error(`El curso ${title} cambió de ${previous.lessons?.length || 0} a ${courseVideos.length} clases; requiere IDs nuevos explícitos.`);
    }

    const lessons = courseVideos.map((video, index) => {
      const upload = state.videos[video.relativePath];
      if (!upload || upload.status !== 'uploaded' || !upload.videoId) {
        throw new Error(`El video no está confirmado como subido: ${video.relativePath}`);
      }
      const remote = remoteById.get(upload.videoId);
      if (!remote) throw new Error(`Bunny no devolvió el video ${upload.videoId}.`);
      if (remote.status !== 4) throw new Error(`El video todavía no está listo en Bunny: ${remote.title} (estado ${remote.status}).`);
      if (remote.collectionId !== state.collections[title]) {
        throw new Error(`El video quedó en una colección incorrecta: ${remote.title}`);
      }

      return {
        id: previous.lessons[index].id,
        title: lessonDisplayTitle(title, video.title),
        desc: `Contenido grabado del curso ${title}.`,
        duration: formatDuration(remote.length),
        sessionNumbers: video.sessionNumbers,
        isPreview: index === 0,
        videoProvider: 'bunny',
        bunnyVideoId: upload.videoId,
        bunnyCollectionId: state.collections[title]
      };
    });

    const totalSeconds = courseVideos.reduce((sum, video) => {
      const upload = state.videos[video.relativePath];
      return sum + Number(remoteById.get(upload.videoId)?.length || 0);
    }, 0);

    return {
      id: previous.id,
      title,
      desc: previous.desc,
      category: previous.category,
      date: '2026-08-11',
      badge: 'Certificado',
      thumbnail: previous.thumbnail || '',
      temarioImg: previous.temarioImg || '',
      availableDate: '',
      duration: formatDuration(totalSeconds),
      bunnyCollectionId: state.collections[title],
      lessons,
      type: 'video'
    };
  });

  const nextSiteData = {
    ...previousSiteData,
    bunnyStream: {
      provider: 'bunny',
      libraryId: Number(libraryId),
      migratedAt: new Date().toISOString(),
      courseCount: courses.length,
      videoCount: courses.reduce((sum, course) => sum + course.lessons.length, 0)
    },
    stats: {
      ...(previousSiteData.stats || {}),
      courses: courses.length,
      pdfs: (previousSiteData.pdfs || []).length,
      live: (previousSiteData.live || []).length
    },
    courses
  };

  fs.writeFileSync(siteContentPath, `${JSON.stringify(nextSiteData, null, 2)}\n`, 'utf8');
  console.log(`Sitio sincronizado: ${courses.length} cursos y ${courses.reduce((sum, course) => sum + course.lessons.length, 0)} videos.`);
  console.log(siteContentPath);
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});

