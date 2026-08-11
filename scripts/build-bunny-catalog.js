const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.resolve(process.argv[2] || path.join(root, '..', 'club-fisioteck', 'data', 'content.json'));
const outputPath = path.resolve(process.argv[3] || path.join(root, 'data', 'bunny-catalog.json'));

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
let previous = { courses: [] };
if (fs.existsSync(outputPath)) previous = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

const previousVideos = new Map();
for (const course of previous.courses || []) {
  for (const lesson of course.lessons || []) {
    previousVideos.set(`${course.courseId}:${lesson.lessonId}`, lesson.bunnyVideoId || '');
  }
}

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  libraryId: previous.libraryId || '',
  courses: (source.courses || []).map(course => ({
    courseId: course.id,
    title: String(course.title || '').trim(),
    lessons: (course.lessons || []).map((lesson, index) => ({
      lessonId: lesson.id,
      title: String(lesson.title || '').trim(),
      index,
      isPreview: index === 0,
      sourceUrl: lesson.videoUrl || '',
      bunnyVideoId: previousVideos.get(`${course.id}:${lesson.id}`) || ''
    }))
  }))
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(catalog, null, 2) + '\n');

const lessonCount = catalog.courses.reduce((sum, course) => sum + course.lessons.length, 0);
console.log(`Catálogo Bunny generado: ${catalog.courses.length} cursos, ${lessonCount} videos`);
console.log(outputPath);
