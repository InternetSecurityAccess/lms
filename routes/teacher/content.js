// routes/teacher/content.js
'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const router = express.Router();
const db = require('../../database');
const config = require('../../config');
const filesPolicy = require('../../config/files');
const { checkTeacher } = require('../shared/authz');
const { rateLimitAction } = require('../../middleware/rateLimit');
const {
handler, renderWith, renderErr, parseIdOr404, audit,
uploadWithFallback, friendlyFileError,
} = require('../shared/handlers');
const { pickStr, pickInt, pickIds } = require('../shared/form');
const {
loadSubjectAsTeacher,
loadTopicAsTeacher,
loadAssignmentAsTeacher,
} = require('../shared/loaders');
const { safeJoin, fixFilename } = require('../../utils/helpers');
const { sanitizeUrlOrNull } = require('../../utils/validation');
const { lectureUpload, lectureImageUpload, assignmentUpload } = require('../../utils/storage');
const { parseCsv, pick } = require('../../utils/csv');
const { sanitizeHtml, textToHtml } = require('../../utils/sanitize');
const { isValidImageBuffer } = require('../../utils/file-signature');
const {
cleanupAssignmentFiles, cleanupTopicFiles,
cleanupImagesFromHtml, cleanupTopicImages,
} = require('../../utils/storage/cleanup');
const attachments = require('../../utils/attachments');
const lifecycle = require('../../utils/lifecycle');
const { nowSql } = require('../../utils/dates');
const { utcToLocalParts, localPartsToUtc } = require('../../utils/timezone');
// ← НОВОЕ: подсистема тестирования
const {
getQuizForEditor,
applyQuizModeOnTopicSave,
} = require('../../utils/quiz-repo');
const { validateQuizPayload } = require('../../utils/quiz');
const csvTopicUpload = multer({
storage: multer.memoryStorage(),
limits: { fileSize: 2 * 1024 * 1024 },
});
const MAX_DESCRIPTION_LENGTH = 1_000_000;
const MAX_HOMEWORK_TEXT_LENGTH = 2000;
const TOPIC_TYPE_FILTERS = Object.freeze(['all', 'lectures', 'assignments', 'quizzes']);
// ← ИЗМЕНЕНО: добавлен 'quiz'
const TOPIC_MODES = Object.freeze(['none_with_hw', 'none_no_hw', 'internal', 'quiz']);
const QUILL_HEADER = `
<link href="/vendor/quill/quill.snow.css" rel="stylesheet">
<link href="/vendor/quill-resize/resize.css" rel="stylesheet">
<script src="/vendor/quill/quill.js"></script>
<script src="/vendor/quill-resize/resize.js" defer></script>
`;
// ← НОВОЕ: подключение стилей конструктора
const QUIZ_CSS = `<link rel="stylesheet" href="/css/quiz.css">`;
function normalizeDeadline(value) {
if (!value) return null;
const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
if (!m) return null;
const [, y, mo, d, h, mi] = m;
return localPartsToUtc(+y, +mo, +d, +h, +mi, config.COLLEGE.TZ);
}
function normalizeAvailableFrom(value) {
return normalizeDeadline(value);
}
function toInputDatetime(value) {
if (!value) return '';
const p = utcToLocalParts(String(value), config.COLLEGE.TZ);
if (!p) return '';
const pad = (n) => String(n).padStart(2, '0');
return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
function getSubjectCounts(subjectId) {
return {
assignments: db.prepare(
"SELECT COUNT(*) AS c FROM assignments WHERE subject_id = ? AND status='active' AND deleted_at IS NULL"
).get(subjectId).c,
topics: db.prepare(
'SELECT COUNT(*) AS c FROM topics WHERE subject_id = ? AND deleted_at IS NULL'
).get(subjectId).c,
groups: db.prepare(
'SELECT COUNT(*) AS c FROM subject_groups WHERE subject_id = ?'
).get(subjectId).c,
};
}
function normalizeTopicMode(raw) {
const v = String(raw || '').trim();
return TOPIC_MODES.includes(v) ? v : 'none_with_hw';
}
async function syncTopicAssignment({ teacherId, topic, body, topicStatus }) {
const mode = body.assignment_mode === 'internal' ? 'internal' : 'none';
if (mode === 'none') {
if (topic.assignment_id) {
const hasSubs = db.prepare(
'SELECT 1 FROM submissions WHERE assignment_id = ? AND deleted_at IS NULL LIMIT 1'
).get(topic.assignment_id);
if (hasSubs) {
db.prepare("UPDATE assignments SET status = 'finished' WHERE id = ?")
.run(topic.assignment_id);
} else {
try { await cleanupAssignmentFiles(db, topic.assignment_id); } catch { /* ignore */ }
db.prepare('DELETE FROM assignments WHERE id = ?').run(topic.assignment_id);
}
}
return null;
}
const title = pickStr(body.assignment_title, 200) || topic.title;
const description = pickStr(body.assignment_description, 2000);
const deadline = normalizeDeadline(body.assignment_deadline);
const assignStatus = topicStatus === 'draft' ? 'draft'
: topicStatus === 'finished' ? 'finished'
: 'active';
if (topic.assignment_id) {
db.prepare(`
UPDATE assignments
SET title = ?, description = ?, deadline = ?, status = ?
WHERE id = ? AND deleted_at IS NULL
`).run(title, description || null, deadline, assignStatus, topic.assignment_id);
return topic.assignment_id;
}
const r = db.prepare(`
INSERT INTO assignments
(teacher_id, subject_id, title, description, deadline, status)
VALUES (?, ?, ?, ?, ?, ?)
`).run(
teacherId, topic.subject_id, title, description || null, deadline, assignStatus
);
return Number(r.lastInsertRowid);
}
function normalizeDescription(raw) {
const value = String(raw || '').trim();
if (!value) return null;
return sanitizeHtml(value).slice(0, MAX_DESCRIPTION_LENGTH);
}
function resolveDescription(body) {
if (body.assignment_mode === 'internal' || body.assignment_mode === 'quiz') return null;
return normalizeDescription(body.description);
}
function resolveHomeworkText(body) {
const m = body.assignment_mode;
if (m === 'internal' || m === 'none_no_hw' || m === 'quiz') return null;
return pickStr(body.homework_text, MAX_HOMEWORK_TEXT_LENGTH) || null;
}
function resolveAssignmentUrl(body) {
const m = body.assignment_mode;
if (m === 'internal' || m === 'none_no_hw' || m === 'quiz') return null;
const raw = pickStr(body.assignment_url, 1000);
return raw ? raw : null;
}
function resolveTitle(req) {
let t = pickStr(req.body.title, 200);
if (!t) t = pickStr(req.body.assignment_title, 200);
return t;
}
function validUrlOrNull(raw) {
const s = pickStr(raw, 1000);
if (!s) return null;
return /^https?:\/\//i.test(s) ? s : null;
}
function topicFormLocalsFromBody(req, mode, existingFiles) {
const bodyMode = normalizeTopicMode(req.body.assignment_mode);
const rawDescription = pickStr(req.body.description, MAX_DESCRIPTION_LENGTH);
const initialHtml = rawDescription.includes('<')
? rawDescription
: (rawDescription ? textToHtml(rawDescription) : '');
const resolvedStatus = (mode === 'edit' && req.topic && req.topic.status === 'finished')
? 'finished'
: (['draft', 'published'].includes(req.body.status) ? req.body.status : 'published');
const availableFromRaw = pickStr(req.body.available_from, 30);
// ← НОВОЕ: headExtra включает quiz.css, если режим quiz
const isQuiz = bodyMode === 'quiz';
const headExtra = QUILL_HEADER + (isQuiz ? QUIZ_CSS : '');
return {
title: mode === 'create' ? 'Новая тема' : 'Редактировать тему',
subject: req.subject, mode,
topic: {
...(mode === 'edit' ? req.topic : {}),
title: resolveTitle(req),
description: rawDescription,
content_url: pickStr(req.body.content_url, 1000),
assignment_url: resolveAssignmentUrl(req.body) || '',
assignment_id: mode === 'edit' ? (req.topic.assignment_id || null) : null,
status: resolvedStatus,
homework_text: resolveHomeworkText(req.body),
available_from: normalizeAvailableFrom(availableFromRaw),
},
availableFromInput: availableFromRaw,
assignment: bodyMode === 'internal' ? {
title: pickStr(req.body.assignment_title, 200),
description: pickStr(req.body.assignment_description, 2000),
} : null,
assignmentDeadlineInput: pickStr(req.body.assignment_deadline, 30),
initialHtml,
defaultAssignmentMode: bodyMode,
existingFiles: existingFiles || [],
headExtra,
};
}
function assignmentFormLocalsFromBody(req, mode, existingFiles) {
const deadlineRaw = pickStr(req.body.deadline, 30);
return {
title: mode === 'create' ? 'Новое задание' : 'Редактировать задание',
subject: req.subject, mode,
assignment: {
...(mode === 'edit' ? req.assignment : {}),
title: pickStr(req.body.title, 200),
description: pickStr(req.body.description, 2000),
deadline: normalizeDeadline(deadlineRaw),
external_url: pickStr(req.body.external_url, 1000) || null,
},
deadlineInput: deadlineRaw,
existingFiles: existingFiles || [],
counts: getSubjectCounts(req.subject.id),
};
}
/* СПИСОК ПРЕДМЕТОВ */
router.get(
'/subjects',
checkTeacher,
handler((req, res) => {
const tid = req.session.teacherId;
const q = pickStr(req.query.q, 100);
let groupFilter = null;
if (req.query.group) {
const n = pickInt(req.query.group);
if (!n) return res.status(404).render('common/error', {
title: 'Не найдено', message: 'Группа не найдена.',
});
groupFilter = n;
}
let where = ' WHERE s.teacher_id = @tid AND s.deleted_at IS NULL';
const params = { tid };
if (q) { where += ' AND (s.title LIKE @q OR s.description LIKE @q)'; params.q = `%${q}%`; }
if (groupFilter) {
where += ` AND EXISTS (
SELECT 1 FROM subject_groups sg2
WHERE sg2.subject_id = s.id AND sg2.group_id = @groupId
)`;
params.groupId = groupFilter;
}
const subjects = db.prepare(`
SELECT s.*,
(SELECT COUNT(*) FROM topics t
WHERE t.subject_id = s.id AND t.status='published' AND t.deleted_at IS NULL) AS topics_count,
(SELECT COUNT(*) FROM topics t
WHERE t.subject_id = s.id AND t.deleted_at IS NULL) AS topics_total,
(SELECT COUNT(*) FROM subject_groups sg
WHERE sg.subject_id = s.id) AS groups_count,
(SELECT COUNT(*) FROM assignments a
WHERE a.subject_id = s.id AND a.status='active' AND a.deleted_at IS NULL) AS assignments_count,
(SELECT GROUP_CONCAT(g.name, ', ') FROM subject_groups sg
JOIN groups g ON g.id = sg.group_id
WHERE sg.subject_id = s.id) AS groups_list
FROM subjects s
${where}
ORDER BY s.title
`).all(params);
const myGroups = db.prepare(`
SELECT g.id, g.name FROM teacher_groups tg
JOIN groups g ON g.id = tg.group_id
WHERE tg.teacher_id = ? AND g.deleted_at IS NULL
ORDER BY g.name
`).all(tid);
const trashCount = db.prepare(`
SELECT
(SELECT COUNT(*) FROM subjects WHERE teacher_id = @tid AND deleted_at IS NOT NULL) +
(SELECT COUNT(*) FROM assignments WHERE teacher_id = @tid AND deleted_at IS NOT NULL) +
(SELECT COUNT(*) FROM topics t JOIN subjects s ON s.id = t.subject_id
WHERE s.teacher_id = @tid AND t.deleted_at IS NOT NULL) AS c
`).get({ tid }).c;
return renderWith(res, 'teacher/content/subjects', {
title: 'Мои предметы',
subjects, q, myGroups, trashCount,
selectedGroup: groupFilter ? String(groupFilter) : '',
});
})
);
router.get('/subjects/new', checkTeacher, handler((req, res) => {
return renderWith(res, 'teacher/content/subject-form', {
title: 'Новый предмет',
mode: 'create',
subject: { title: '', description: '' },
attachGroupId: pickInt(req.query.attach),
error: null,
});
}));
router.post('/subjects', checkTeacher, handler((req, res) => {
const title = pickStr(req.body.title, 200);
const description = pickStr(req.body.description, 2000);
const attachGroupId = pickInt(req.body.attach_group_id);
if (!title) {
return renderErr(res, 'teacher/content/subject-form', {
title: 'Новый предмет', mode: 'create',
subject: { title, description },
attachGroupId,
}, 'Укажите название предмета.');
}
const subjectId = db.transaction(() => {
const r = db.prepare(`
INSERT INTO subjects (teacher_id, title, description, status)
VALUES (?, ?, ?, 'active')
`).run(req.session.teacherId, title, description || null);
const sid = Number(r.lastInsertRowid);
if (attachGroupId) {
const isMyGroup = db.prepare(`
SELECT 1 FROM teacher_groups tg
JOIN groups g ON g.id = tg.group_id
WHERE tg.teacher_id = ? AND tg.group_id = ? AND g.deleted_at IS NULL
`).get(req.session.teacherId, attachGroupId);
if (isMyGroup) {
db.prepare(
'INSERT OR IGNORE INTO subject_groups (subject_id, group_id) VALUES (?, ?)'
).run(sid, attachGroupId);
}
}
return sid;
})();
audit(req, 'subject.create', 'subject', subjectId, {
title, attach_group_id: attachGroupId || null,
});
const nextUrl = pickStr(req.body._next, 20) || 'topics';
if (nextUrl === 'groups') {
return res.redirect(`/subjects/${subjectId}/groups?created=1`);
}
return res.redirect(`/subjects/${subjectId}/topics?created=1`);
}));
router.get(
'/subjects/:subjectId',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => res.redirect(`/subjects/${req.subject.id}/topics`))
);
router.get(
'/subjects/:subjectId/topics',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const topicsQ = pickStr(req.query.topics_q, 100);
const typeFilter = TOPIC_TYPE_FILTERS.includes(req.query.type) ? req.query.type : 'all';
const countsRaw = db.prepare(`
SELECT
COUNT(*) AS total,
SUM(CASE WHEN assignment_id IS NULL AND quiz_id IS NULL THEN 1 ELSE 0 END) AS lectures,
SUM(CASE WHEN assignment_id IS NOT NULL THEN 1 ELSE 0 END) AS assignments,
SUM(CASE WHEN quiz_id IS NOT NULL THEN 1 ELSE 0 END) AS quizzes
FROM topics
WHERE subject_id = ? AND deleted_at IS NULL
`).get(req.subject.id);
const topicCounts = {
all: Number(countsRaw.total || 0),
lectures: Number(countsRaw.lectures || 0),
assignments: Number(countsRaw.assignments || 0),
quizzes: Number(countsRaw.quizzes || 0),
};
let topicsWhere = ' WHERE t.subject_id = @sid AND t.deleted_at IS NULL';
const topicsParams = { sid: req.subject.id };
if (typeFilter === 'lectures') {
topicsWhere += ' AND t.assignment_id IS NULL AND t.quiz_id IS NULL';
} else if (typeFilter === 'assignments') {
topicsWhere += ' AND t.assignment_id IS NOT NULL';
} else if (typeFilter === 'quizzes') {
topicsWhere += ' AND t.quiz_id IS NOT NULL';
}
if (topicsQ) {
topicsWhere += ' AND (t.title LIKE @tq OR t.description LIKE @tq)';
topicsParams.tq = `%${topicsQ}%`;
}
const topics = db.prepare(`
SELECT t.*, a.title AS assignment_title,
qz.title AS quiz_title,
(SELECT COUNT(*) FROM submissions s
WHERE s.assignment_id = t.assignment_id AND s.deleted_at IS NULL) AS assignment_works_count,
(SELECT COUNT(*) FROM quiz_attempts qa
WHERE qa.quiz_id = t.quiz_id) AS quiz_attempts_count
FROM topics t
LEFT JOIN assignments a ON a.id = t.assignment_id
LEFT JOIN quizzes qz ON qz.id = t.quiz_id
${topicsWhere}
ORDER BY t.position ASC, t.id ASC
`).all(topicsParams);
for (const t of topics) {
t.attachments = attachments.listAttachments('topic', t.id);
t.is_future = !!(t.available_from && t.available_from > nowSql());
}
return renderWith(res, 'teacher/content/subject-topics', {
title: req.subject.title,
subject: req.subject,
topics, topicCounts, typeFilter,
counts: getSubjectCounts(req.subject.id),
topicsQ,
});
})
);
router.get(
'/subjects/:subjectId/groups',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const tid = req.session.teacherId;
const allGroups = db.prepare(`
SELECT g.id, g.name,
CASE WHEN sg.subject_id IS NULL THEN 0 ELSE 1 END AS attached,
CASE WHEN tg.teacher_id IS NULL THEN 0 ELSE 1 END AS subscribed,
(SELECT COUNT(*) FROM students s
WHERE s.group_id = g.id AND s.deleted_at IS NULL) AS students_count,
(SELECT COUNT(*) FROM submissions sub
JOIN assignments a ON a.id = sub.assignment_id
WHERE a.subject_id = ? AND sub.group_id = g.id
AND sub.deleted_at IS NULL) AS works_count,
(SELECT COUNT(*) FROM submissions sub
JOIN assignments a ON a.id = sub.assignment_id
WHERE a.subject_id = ? AND sub.group_id = g.id
AND sub.status = 'pending' AND sub.deleted_at IS NULL) AS pending_count
FROM groups g
LEFT JOIN subject_groups sg
ON sg.group_id = g.id AND sg.subject_id = ?
LEFT JOIN teacher_groups tg
ON tg.group_id = g.id AND tg.teacher_id = ?
WHERE g.deleted_at IS NULL
AND (sg.subject_id IS NOT NULL OR tg.teacher_id IS NOT NULL)
ORDER BY g.name
`).all(req.subject.id, req.subject.id, req.subject.id, tid);
const attachedCount = allGroups.filter((g) => g.attached).length;
const notSubscribed = allGroups.filter((g) => !g.subscribed).length;
const totalStudents = allGroups
.filter((g) => g.attached)
.reduce((sum, g) => sum + g.students_count, 0);
return renderWith(res, 'teacher/content/subject-groups', {
title: req.subject.title,
subject: req.subject,
allGroups, attachedCount, notSubscribed, totalStudents,
counts: getSubjectCounts(req.subject.id),
});
})
);
router.post(
'/subjects/:subjectId/groups',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const ids = pickIds(req.body.group_ids);
let validIds = [];
if (ids.length > 0) {
const ph = ids.map(() => '?').join(',');
validIds = db.prepare(`
SELECT id FROM groups WHERE id IN (${ph}) AND deleted_at IS NULL
`).all(...ids).map((r) => r.id);
}
let autoSubscribed = 0;
let detachedCount = 0;
const tx = db.transaction(() => {
const wasAttached = db.prepare(
'SELECT group_id FROM subject_groups WHERE subject_id = ?'
).all(req.subject.id).map((r) => r.group_id);
if (validIds.length > 0) {
const insertTG = db.prepare(
'INSERT OR IGNORE INTO teacher_groups (teacher_id, group_id) VALUES (?, ?)'
);
for (const gid of validIds) {
const r = insertTG.run(req.session.teacherId, gid);
if (r.changes) autoSubscribed++;
}
}
if (validIds.length > 0) {
const ph = validIds.map(() => '?').join(',');
db.prepare(`
DELETE FROM subject_groups
WHERE subject_id = ? AND group_id NOT IN (${ph})
`).run(req.subject.id, ...validIds);
} else {
db.prepare('DELETE FROM subject_groups WHERE subject_id = ?').run(req.subject.id);
}
const insertSG = db.prepare(
'INSERT OR IGNORE INTO subject_groups (subject_id, group_id) VALUES (?, ?)'
);
for (const gid of validIds) insertSG.run(req.subject.id, gid);
const validSet = new Set(validIds);
const insertHist = db.prepare(`
INSERT INTO subject_groups_history
(subject_id, group_id, finished_at, finished_by_teacher_id)
VALUES (?, ?, CURRENT_TIMESTAMP, ?)
`);
for (const gid of wasAttached) {
if (!validSet.has(gid)) {
insertHist.run(req.subject.id, gid, req.session.teacherId);
detachedCount++;
}
}
});
tx();
audit(req, 'subject.groups_update', 'subject', req.subject.id, {
group_ids: validIds,
auto_subscribed: autoSubscribed,
detached: detachedCount,
});
return res.redirect(`/subjects/${req.subject.id}/groups?saved=${validIds.length}`);
})
);
router.post(
'/subjects/:subjectId/attach',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const gid = pickInt(req.body.group_id);
const fallback = `/subjects/${req.subject.id}/groups`;
if (!gid) return res.redirect(fallback);
const group = db.prepare(
'SELECT id FROM groups WHERE id = ? AND deleted_at IS NULL'
).get(gid);
if (!group) return res.redirect(fallback);
db.transaction(() => {
db.prepare(
'INSERT OR IGNORE INTO teacher_groups (teacher_id, group_id) VALUES (?, ?)'
).run(req.session.teacherId, gid);
db.prepare(
'INSERT OR IGNORE INTO subject_groups (subject_id, group_id) VALUES (?, ?)'
).run(req.subject.id, gid);
})();
audit(req, 'subject.attach_group', 'subject', req.subject.id, { group_id: gid });
return res.redirect(fallback + '?saved=1');
})
);
router.post(
'/subjects/:subjectId/detach',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const gid = pickInt(req.body.group_id);
const fallback = `/subjects/${req.subject.id}/groups`;
if (!gid) return res.redirect(fallback);
db.transaction(() => {
db.prepare('DELETE FROM subject_groups WHERE subject_id = ? AND group_id = ?')
.run(req.subject.id, gid);
db.prepare(`
INSERT INTO subject_groups_history
(subject_id, group_id, finished_at, finished_by_teacher_id)
VALUES (?, ?, CURRENT_TIMESTAMP, ?)
`).run(req.subject.id, gid, req.session.teacherId);
})();
audit(req, 'subject.detach_group', 'subject', req.subject.id, {
group_id: gid, via: 'detach_route',
});
return res.redirect(fallback + '?saved=0');
})
);
router.post(
'/subjects/:subjectId/subscribe/:groupId',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const gid = parseIdOr404(req, res, 'groupId');
if (!gid) return;
const group = db.prepare(
'SELECT id FROM groups WHERE id = ? AND deleted_at IS NULL'
).get(gid);
if (!group) return res.redirect(`/subjects/${req.subject.id}/groups`);
db.prepare(
'INSERT OR IGNORE INTO teacher_groups (teacher_id, group_id) VALUES (?, ?)'
).run(req.session.teacherId, gid);
audit(req, 'subject.attach_group', 'subject', req.subject.id, {
group_id: gid, via: 'subscribe',
});
return res.redirect(`/subjects/${req.subject.id}/groups?saved=1`);
})
);
router.get(
'/subjects/:subjectId/edit',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
return renderWith(res, 'teacher/content/subject-form', {
title: 'Редактировать предмет',
mode: 'edit',
subject: req.subject,
attachGroupId: null,
error: null,
});
})
);
router.post(
'/subjects/:subjectId',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const title = pickStr(req.body.title, 200);
const description = pickStr(req.body.description, 2000);
if (!title) {
return renderErr(res, 'teacher/content/subject-form', {
title: 'Редактировать предмет', mode: 'edit',
subject: { ...req.subject, title, description },
attachGroupId: null,
}, 'Укажите название предмета.');
}
db.prepare(
'UPDATE subjects SET title = ?, description = ? WHERE id = ? AND deleted_at IS NULL'
).run(title, description || null, req.subject.id);
audit(req, 'subject.update', 'subject', req.subject.id, {
title, prev_title: req.subject.title,
});
return res.redirect(`/subjects/${req.subject.id}/topics?updated=1`);
})
);
router.post(
'/subjects/:subjectId/delete',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
lifecycle.softDelete('subjects', req.subject.id);
audit(req, 'subject.delete', 'subject', req.subject.id, {
title: req.subject.title, mode: 'soft', by: 'teacher',
});
return res.redirect('/subjects?deleted=1');
})
);
router.post(
'/subjects/:subjectId/images',
checkTeacher, loadSubjectAsTeacher,
rateLimitAction('lecture_image', { max: 30, windowMs: 60_000, blockMs: 60_000 }),
handler((req, res, next) => {
lectureImageUpload.single('image')(req, res, async (err) => {
if (err) {
if (err.code === 'LIMIT_FILE_SIZE') {
return res.status(413).json({
ok: false, error: 'file_too_large',
message: `Файл больше ${filesPolicy.MAX_FILE_SIZE_MB} МБ`,
});
}
if (err.code === 'INVALID_IMAGE_TYPE') {
return res.status(400).json({
ok: false, error: 'invalid_image_type',
message: 'Только ' + filesPolicy.formatExtList(filesPolicy.IMAGE_EXTENSIONS),
});
}
return res.status(400).json({
ok: false, error: 'upload_failed',
message: err.message || 'Ошибка загрузки',
});
}
try {
if (!req.file) {
return res.status(400).json({
ok: false, error: 'no_file', message: 'Файл не передан',
});
}
const meta = req.lectureImageMeta;
if (!meta || !meta.filename) {
try { fs.promises.unlink(req.file.path).catch(() => {}); } catch { /* ignore */ }
return res.status(500).json({
ok: false, error: 'save_failed', message: 'Не удалось сохранить файл',
});
}
const imageBytes = await fs.promises.readFile(req.file.path);
const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const expectedMime = mimeByExt[path.extname(req.file.filename).toLowerCase()];
if (!expectedMime || !isValidImageBuffer(imageBytes, expectedMime)) {
await fs.promises.unlink(req.file.path).catch(() => {});
return res.status(400).json({
ok: false, error: 'invalid_signature',
message: 'Содержимое не соответствует формату изображения',
});
}
const url = `/uploads/lecture-images/${req.subject.id}/${meta.filename}`;
return res.json({ ok: true, url });
} catch (e) {
if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
return next(e);
}
});
})
);
/* СПИСОК ЗАДАНИЙ ПО ВСЕМ ПРЕДМЕТАМ */
router.get(
'/assignments',
checkTeacher,
handler((req, res) => {
const tid = req.session.teacherId;
const q = pickStr(req.query.q, 100);
const subjectFilter = pickInt(req.query.subject);
const afilter = ['all', 'pending', 'draft'].includes(req.query.afilter)
? req.query.afilter : 'all';
let where = `
WHERE s.teacher_id = @tid
AND s.status = 'active' AND s.deleted_at IS NULL
AND t.assignment_id IS NOT NULL
AND t.deleted_at IS NULL
`;
const params = { tid };
if (subjectFilter) { where += ' AND s.id = @sid'; params.sid = subjectFilter; }
if (q) {
where += ' AND (t.title LIKE @q OR t.description LIKE @q OR s.title LIKE @q)';
params.q = `%${q}%`;
}
if (afilter === 'draft') where += " AND t.status = 'draft'";
const topics = db.prepare(`
SELECT t.*,
s.id AS subject_id, s.title AS subject_title,
a.title AS assignment_title,
a.deadline AS assignment_deadline,
a.status AS assignment_status,
(SELECT COUNT(*) FROM submissions sub
WHERE sub.assignment_id = t.assignment_id AND sub.deleted_at IS NULL) AS works_count,
(SELECT COUNT(*) FROM submissions sub
WHERE sub.assignment_id = t.assignment_id AND sub.status = 'pending'
AND sub.deleted_at IS NULL) AS pending_count
FROM topics t
JOIN subjects s ON s.id = t.subject_id
LEFT JOIN assignments a ON a.id = t.assignment_id
${where}
ORDER BY s.title, t.position, t.id
`).all(params);
const filtered = afilter === 'pending'
? topics.filter((t) => t.pending_count > 0)
: topics;
const countWhere = subjectFilter
? `WHERE s.teacher_id = @tid AND s.status='active' AND s.deleted_at IS NULL AND s.id = @sid AND t.assignment_id IS NOT NULL AND t.deleted_at IS NULL`
: `WHERE s.teacher_id = @tid AND s.status='active' AND s.deleted_at IS NULL AND t.assignment_id IS NOT NULL AND t.deleted_at IS NULL`;
const countParams = subjectFilter ? { tid, sid: subjectFilter } : { tid };
const countRows = db.prepare(`
SELECT t.id, t.status, t.assignment_id,
(SELECT COUNT(*) FROM submissions sub
WHERE sub.assignment_id = t.assignment_id AND sub.status='pending'
AND sub.deleted_at IS NULL) AS pending_count
FROM topics t
JOIN subjects s ON s.id = t.subject_id
${countWhere}
`).all(countParams);
const counts = {
all: countRows.length,
pending: countRows.filter((r) => r.pending_count > 0).length,
draft: countRows.filter((r) => r.status === 'draft').length,
};
const allSubjects = db.prepare(`
SELECT id, title FROM subjects
WHERE teacher_id = ? AND status='active' AND deleted_at IS NULL
ORDER BY title
`).all(tid);
const subjectsCount = allSubjects.length;
const singleSubjectId = subjectsCount === 1 ? allSubjects[0].id : null;
return renderWith(res, 'teacher/content/topics-list', {
title: 'Задания',
topics: filtered, subjects: allSubjects, counts,
subjectsCount, singleSubjectId,
q, subjectFilter, afilter,
});
})
);
/* СОЗДАНИЕ ТЕМЫ */
router.get(
'/subjects/:subjectId/topics/new',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const rawMode = req.query.assignment_mode;
const defaultAssignmentMode = rawMode === 'internal'
? 'internal'
: (rawMode === 'quiz' ? 'quiz' : 'none_with_hw');
// ← НОВОЕ: для режима quiz сразу кладём пустой initial для конструктора
const quizInitial = defaultAssignmentMode === 'quiz'
? { quiz: null, attemptsCount: 0 }
: null;
const isQuiz = defaultAssignmentMode === 'quiz';
return renderWith(res, 'teacher/content/topic-form', {
title: 'Новая тема',
subject: req.subject, mode: 'create',
topic: {
title: '', description: '', content_url: '',
assignment_url: '', assignment_id: null, status: 'published',
homework_text: null, available_from: null,
},
availableFromInput: '',
assignment: null,
assignmentDeadlineInput: '',
initialHtml: '',
error: null,
defaultAssignmentMode,
existingFiles: [],
headExtra: QUILL_HEADER + (isQuiz ? QUIZ_CSS : ''),
quizInitial,
});
})
);
router.post(
'/subjects/:subjectId/topics',
checkTeacher, loadSubjectAsTeacher,
uploadWithFallback(
lectureUpload.array('files', filesPolicy.MAX_FILES_PER_UPLOAD),
(err, req, res) => {
const locals = topicFormLocalsFromBody(req, 'create', []);
return renderErr(res, 'teacher/content/topic-form', locals, friendlyFileError(err));
}
),
handler(async (req, res) => {
const files = req.files || [];
const cleanup = () => {
for (const f of files) if (f.path) fs.promises.unlink(f.path).catch(() => {});
};
const title = resolveTitle(req);
const description = resolveDescription(req.body);
const homework_text = resolveHomeworkText(req.body);
const rawContent = pickStr(req.body.content_url, 1000);
const rawAssign = resolveAssignmentUrl(req.body);
const content_url = rawContent ? sanitizeUrlOrNull(rawContent) : null;
const assignment_url = rawAssign ? sanitizeUrlOrNull(rawAssign) : null;
const available_from = normalizeAvailableFrom(pickStr(req.body.available_from, 30));
const status = ['draft', 'published'].includes(req.body.status) ? req.body.status : 'published';
const bodyMode = normalizeTopicMode(req.body.assignment_mode);
const renderError = (msg) => {
cleanup();
const locals = topicFormLocalsFromBody(req, 'create', []);
return renderErr(res, 'teacher/content/topic-form', locals, msg);
};
if (!title) return renderError('Укажите название темы или задания.');
if (rawContent && !content_url) return renderError('Ссылка на источник должна начинаться с http:// или https://.');
if (rawAssign && !assignment_url) return renderError('Ссылка на ДЗ должна начинаться с http:// или https://.');
// ← НОВОЕ: обработка режима quiz
if (bodyMode === 'quiz') {
const quizJson = String(req.body.quiz_json || '{}');
// Валидация payload перед сохранением
let payload;
try { payload = JSON.parse(quizJson); }
catch { return renderError('Некорректный JSON теста.'); }
const forPublish = status === 'published';
const v = validateQuizPayload(payload, { forPublish });
if (!v.ok) return renderError(v.errors.join('; '));
}
const tempTopic = { title, subject_id: req.subject.id, assignment_id: null };
const assignmentId = bodyMode === 'quiz'
? null
: await syncTopicAssignment({
teacherId: req.session.teacherId,
topic: tempTopic,
body: req.body,
topicStatus: status,
});
const maxPos = db.prepare(
'SELECT COALESCE(MAX(position), 0) AS m FROM topics WHERE subject_id = ?'
).get(req.subject.id).m;
const publishedAt = status === 'published' ? nowSql() : null;
const newTopicId = db.transaction(() => {
const r = db.prepare(`
INSERT INTO topics
(subject_id, title, description, content_url, assignment_url,
assignment_id, homework_text, position, status, published_at,
available_from)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
req.subject.id, title, description || null,
content_url,
assignmentId ? null : assignment_url,
assignmentId,
homework_text,
maxPos + 1, status, publishedAt,
available_from
);
const topicId = Number(r.lastInsertRowid);
for (let i = 0; i < files.length; i++) {
attachments.addAttachment('topic', topicId, {
stored_name: req.storedNames[i],
filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
filesize: files[i].size,
});
}
return topicId;
})();
// ← НОВОЕ: применение quiz-режима
if (bodyMode === 'quiz') {
const quizJson = String(req.body.quiz_json || '{}');
const qr = applyQuizModeOnTopicSave({
topicId: newTopicId,
teacherId: req.session.teacherId,
mode: bodyMode,
quizJson,
});
if (!qr.ok) {
// Откат темы
lifecycle.softDeleteTopic(newTopicId);
cleanup();
return renderError(qr.error || 'Не удалось сохранить тест.');
}
}
audit(req, 'topic.create', 'topic', newTopicId, {
title, subject_id: req.subject.id,
assignment_id: assignmentId || null, status,
available_from, mode: bodyMode,
});
const action = pickStr(req.body._action, 20) || 'open';
if (action === 'again') {
return res.redirect(`/subjects/${req.subject.id}/topics/new?assignment_mode=${bodyMode}&added=1`);
}
if (assignmentId) {
return res.redirect(`/subjects/${req.subject.id}/assignments/${assignmentId}?created=1`);
}
if (bodyMode === 'quiz') {
return res.redirect(`/subjects/${req.subject.id}/topics/${newTopicId}?created=1`);
}
return res.redirect(`/subjects/${req.subject.id}/topics/${newTopicId}?created=1`);
})
);
/* ИМПОРТ ТЕМ */
router.get(
'/subjects/:subjectId/topics/import',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
return renderWith(res, 'teacher/content/topics-import', {
title: 'Импорт тем', subject: req.subject, result: null, error: null,
});
})
);
router.get(
'/subjects/:subjectId/topics/import/template',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const filename = `template-topics-${req.subject.id}.csv`;
res.setHeader('Content-Type', 'text/csv; charset=utf-8');
res.setHeader('Content-Disposition',
`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
return res.send(csv);
})
);
router.post(
'/subjects/:subjectId/topics/import',
checkTeacher, loadSubjectAsTeacher,
csvTopicUpload.single('file'),
handler((req, res) => {
if (!req.file || !req.file.buffer) {
return renderErr(res, 'teacher/content/topics-import', {
title: 'Импорт тем', subject: req.subject, result: null,
}, 'Файл не загружен.');
}
const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
const { rows } = parseCsv(text);
if (rows.length === 0) {
return renderErr(res, 'teacher/content/topics-import', {
title: 'Импорт тем', subject: req.subject, result: null,
}, 'Файл пустой.');
}
const maxPos = db.prepare(
'SELECT COALESCE(MAX(position), 0) AS m FROM topics WHERE subject_id = ?'
).get(req.subject.id).m;
const insert = db.prepare(`
INSERT INTO topics
(subject_id, title, description, content_url, assignment_url,
assignment_id, homework_text, position, status, published_at,
available_from)
VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
`);
const result = { created: 0, errors: [] };
let pos = maxPos;
const tx = db.transaction(() => {
for (let i = 0; i < rows.length; i++) {
const lineNum = i + 2;
const row = rows[i];
const title = pick(row, ['title', 'тема', 'название']).slice(0, 200);
const rawDescription = pick(row, ['description', 'описание']);
let description = null;
if (rawDescription) {
description = rawDescription.includes('<')
? sanitizeHtml(rawDescription).slice(0, MAX_DESCRIPTION_LENGTH)
: textToHtml(rawDescription).slice(0, MAX_DESCRIPTION_LENGTH);
}
const rawContent = pick(row, ['content_url', 'url', 'ссылка', 'материал']).slice(0, 1000);
const rawAssign = pick(row, ['assignment_url', 'assignment', 'задание', 'сдача']).slice(0, 1000);
const content_url = rawContent ? sanitizeUrlOrNull(rawContent) : null;
const assignment_url = rawAssign ? sanitizeUrlOrNull(rawAssign) : null;
const rawAvailable = pick(row, ['available_from', 'доступно_с']).slice(0, 30);
const available_from = normalizeAvailableFrom(rawAvailable);
const statusRaw = pick(row, ['status', 'статус']).toLowerCase();
const status = (statusRaw === 'draft' || statusRaw === 'черновик')
? 'draft' : 'published';
if (!title) { result.errors.push({ line: lineNum, reason: 'пустое название' }); continue; }
if (rawContent && !content_url) {
result.errors.push({ line: lineNum, reason: 'некорректный content_url' }); continue;
}
if (rawAssign && !assignment_url) {
result.errors.push({ line: lineNum, reason: 'некорректный assignment_url' }); continue;
}
if (rawAvailable && !available_from) {
result.errors.push({ line: lineNum, reason: 'некорректный available_from (ожидается YYYY-MM-DDTHH:MM)' }); continue;
}
pos++;
insert.run(
req.subject.id, title,
description,
content_url, assignment_url,
pos, status,
status === 'published' ? nowSql() : null,
available_from
);
result.created++;
}
});
tx();
if (result.created > 0) {
audit(req, 'topic.import', 'subject', req.subject.id, {
created: result.created, errors: result.errors.length,
});
}
return renderWith(res, 'teacher/content/topics-import', {
title: 'Импорт тем', subject: req.subject, result, error: null,
});
})
);
/* РЕДАКТИРОВАНИЕ / ПРОСМОТР ТЕМЫ */
router.get(
'/subjects/:subjectId/topics/:topicId/edit',
checkTeacher, loadSubjectAsTeacher, loadTopicAsTeacher,
handler((req, res) => {
const assignment = req.topic.assignment_id
? db.prepare('SELECT * FROM assignments WHERE id = ? AND deleted_at IS NULL')
.get(req.topic.assignment_id)
: null;
const rawDesc = req.topic.description || '';
const initialHtml = rawDesc.includes('<') ? rawDesc : (rawDesc ? textToHtml(rawDesc) : '');
let defaultAssignmentMode;
if (req.topic.quiz_id) {
defaultAssignmentMode = 'quiz';
} else if (req.topic.assignment_id) {
defaultAssignmentMode = 'internal';
} else if (!req.topic.homework_text && !req.topic.assignment_url) {
defaultAssignmentMode = 'none_no_hw';
} else {
defaultAssignmentMode = 'none_with_hw';
}
// ← НОВОЕ: данные конструктора теста
const quizInitial = defaultAssignmentMode === 'quiz'
? (getQuizForEditor(req.topic.id) || { quiz: null, attemptsCount: 0 })
: null;
const isQuiz = defaultAssignmentMode === 'quiz';
return renderWith(res, 'teacher/content/topic-form', {
title: 'Редактировать тему',
subject: req.subject, mode: 'edit',
topic: req.topic, assignment,
availableFromInput: toInputDatetime(req.topic.available_from),
assignmentDeadlineInput: assignment && assignment.deadline
? toInputDatetime(assignment.deadline) : '',
initialHtml,
error: null,
defaultAssignmentMode,
existingFiles: req.topic.attachments,
headExtra: QUILL_HEADER + (isQuiz ? QUIZ_CSS : ''),
quizInitial,
});
})
);
router.get(
'/subjects/:subjectId/topics/:topicId',
checkTeacher, loadSubjectAsTeacher, loadTopicAsTeacher,
handler((req, res) => {
if (req.topic.assignment_id) {
return res.redirect(`/subjects/${req.subject.id}/assignments/${req.topic.assignment_id}`);
}
return renderWith(res, 'teacher/content/topic-view', {
title: req.topic.title, subject: req.subject, topic: req.topic,
});
})
);
router.post(
'/subjects/:subjectId/topics/:topicId',
checkTeacher, loadSubjectAsTeacher, loadTopicAsTeacher,
uploadWithFallback(
lectureUpload.array('files', filesPolicy.MAX_FILES_PER_UPLOAD),
(err, req, res) => {
const existingFiles = attachments.listAttachments('topic', req.topic.id);
const locals = topicFormLocalsFromBody(req, 'edit', existingFiles);
return renderErr(res, 'teacher/content/topic-form', locals, friendlyFileError(err));
}
),
handler(async (req, res) => {
const files = req.files || [];
const cleanup = () => {
for (const f of files) if (f.path) fs.promises.unlink(f.path).catch(() => {});
};
const title = resolveTitle(req);
const description = resolveDescription(req.body);
const homework_text = resolveHomeworkText(req.body);
const rawContent = pickStr(req.body.content_url, 1000);
const rawAssign = resolveAssignmentUrl(req.body);
const content_url = rawContent ? sanitizeUrlOrNull(rawContent) : null;
const assignment_url = rawAssign ? sanitizeUrlOrNull(rawAssign) : null;
const available_from = normalizeAvailableFrom(pickStr(req.body.available_from, 30));
const status = req.topic.status === 'finished'
? 'finished'
: (['draft', 'published'].includes(req.body.status) ? req.body.status : 'published');
const bodyMode = normalizeTopicMode(req.body.assignment_mode);
const existingFiles = attachments.listAttachments('topic', req.topic.id);
const renderError = (msg) => {
cleanup();
const locals = topicFormLocalsFromBody(req, 'edit', existingFiles);
return renderErr(res, 'teacher/content/topic-form', locals, msg);
};
if (!title) return renderError('Укажите название темы или задания.');
if (rawContent && !content_url) return renderError('Ссылка на источник должна начинаться с http:// или https://.');
if (rawAssign && !assignment_url) return renderError('Ссылка на ДЗ должна начинаться с http:// или https://.');
// ← НОВОЕ: обработка quiz-режима
if (bodyMode === 'quiz') {
const quizJson = String(req.body.quiz_json || '{}');
let payload;
try { payload = JSON.parse(quizJson); }
catch { return renderError('Некорректный JSON теста.'); }
const forPublish = status === 'published';
const v = validateQuizPayload(payload, { forPublish });
if (!v.ok) return renderError(v.errors.join('; '));
}
// ← НОВОЕ: если у темы был quiz, а теперь режим не quiz — пробуем отвязать.
// Если есть попытки — detachQuizFromTopic вернёт ошибку.
const prevMode = req.topic.quiz_id ? 'quiz'
: (req.topic.assignment_id ? 'internal' : 'none');
if (prevMode === 'quiz' && bodyMode !== 'quiz') {
const detach = applyQuizModeOnTopicSave({
topicId: req.topic.id,
teacherId: req.session.teacherId,
mode: bodyMode,
quizJson: '{}',
});
if (!detach.ok) {
cleanup();
const locals = topicFormLocalsFromBody(req, 'edit', existingFiles);
return renderErr(res, 'teacher/content/topic-form', locals, detach.error || 'Нельзя изменить тип темы.');
}
}
const assignmentId = bodyMode === 'quiz'
? null
: await syncTopicAssignment({
teacherId: req.session.teacherId,
topic: req.topic,
body: req.body,
topicStatus: status,
});
const publishedAt = status === 'published'
? (req.topic.published_at || nowSql())
: (req.topic.published_at || null);
const removeIds = pickIds(req.body.remove_file_ids);
const removedStored = [];
db.transaction(() => {
db.prepare(`
UPDATE topics
SET title = ?, description = ?, content_url = ?, assignment_url = ?,
assignment_id = ?, homework_text = ?, status = ?, published_at = ?,
available_from = ?
WHERE id = ?
`).run(
title, description || null,
content_url,
assignmentId ? null : assignment_url,
assignmentId,
homework_text,
status, publishedAt,
available_from,
req.topic.id
);
for (const id of removeIds) {
const a = attachments.getAttachment(id);
if (a && a.owner_kind === 'topic' && a.owner_id === req.topic.id) {
removedStored.push(a.stored_name);
attachments.removeAttachment(id);
}
}
for (let i = 0; i < files.length; i++) {
attachments.addAttachment('topic', req.topic.id, {
stored_name: req.storedNames[i],
filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
filesize: files[i].size,
});
}
})();
// ← НОВОЕ: сохранение/обновление теста
if (bodyMode === 'quiz') {
const quizJson = String(req.body.quiz_json || '{}');
const qr = applyQuizModeOnTopicSave({
topicId: req.topic.id,
teacherId: req.session.teacherId,
mode: bodyMode,
quizJson,
});
if (!qr.ok) {
cleanup();
const locals = topicFormLocalsFromBody(req, 'edit', existingFiles);
return renderErr(res, 'teacher/content/topic-form', locals, qr.error || 'Не удалось сохранить тест.');
}
}
for (const sn of removedStored) {
try { fs.promises.unlink(safeJoin(config.STORAGE_DIR, sn)).catch(() => {}); } catch { /* ignore */ }
}
audit(req, 'topic.update', 'topic', req.topic.id, {
title, subject_id: req.subject.id,
assignment_id: assignmentId || null, status,
available_from, mode: bodyMode,
});
const action = pickStr(req.body._action, 20) || 'open';
if (action === 'again') {
return res.redirect(`/subjects/${req.subject.id}/topics/new?assignment_mode=${bodyMode}&added=1`);
}
if (assignmentId) {
return res.redirect(`/subjects/${req.subject.id}/assignments/${assignmentId}?updated=1`);
}
return res.redirect(`/subjects/${req.subject.id}/topics/${req.topic.id}?updated=1`);
})
);
router.post(
'/subjects/:subjectId/topics/:topicId/delete',
checkTeacher, loadSubjectAsTeacher, loadTopicAsTeacher,
handler((req, res) => {
const result = lifecycle.softDeleteTopic(req.topic.id);
audit(req, 'topic.delete', 'topic', req.topic.id, {
title: req.topic.title, subject_id: req.subject.id,
assignment_id: req.topic.assignment_id || null,
assignment_action: result.assignmentAction || null,
mode: 'soft', by: 'teacher',
});
return res.redirect(`/subjects/${req.subject.id}/topics?deleted=1`);
})
);
/* СПИСОК ЗАДАНИЙ ПРЕДМЕТА */
router.get(
'/subjects/:subjectId/assignments',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
const q = pickStr(req.query.q, 100);
const wfilter = ['pending', 'accepted', 'all'].includes(req.query.wfilter)
? req.query.wfilter : 'all';
let where = ' WHERE a.subject_id = @sid AND a.teacher_id = @tid AND a.deleted_at IS NULL';
const params = { sid: req.subject.id, tid: req.session.teacherId };
if (q) {
where += ' AND (a.title LIKE @q OR a.description LIKE @q)';
params.q = `%${q}%`;
}
const allAssignments = db.prepare(`
SELECT a.*,
(SELECT COUNT(*) FROM submissions sub
WHERE sub.assignment_id = a.id AND sub.deleted_at IS NULL) AS works_count,
(SELECT COUNT(*) FROM submissions sub
WHERE sub.assignment_id = a.id AND sub.status = 'pending'
AND sub.deleted_at IS NULL) AS pending_count,
(SELECT COUNT(*) FROM submissions sub
WHERE sub.assignment_id = a.id AND sub.status = 'accepted'
AND sub.deleted_at IS NULL) AS accepted_count,
(SELECT COUNT(*) FROM submissions sub
WHERE sub.assignment_id = a.id AND sub.status = 'rejected'
AND sub.deleted_at IS NULL) AS rejected_count,
(SELECT COUNT(DISTINCT sub.student_id) FROM submissions sub
WHERE sub.assignment_id = a.id AND sub.deleted_at IS NULL) AS submitted_students
FROM assignments a
${where}
ORDER BY (a.status = 'active') DESC, a.created_at DESC
`).all(params);
let assignments;
if (wfilter === 'pending') {
assignments = allAssignments.filter((a) => a.pending_count > 0);
} else if (wfilter === 'accepted') {
assignments = allAssignments.filter((a) => a.accepted_count > 0);
} else {
assignments = allAssignments;
}
const groups = db.prepare(`
SELECT g.id, g.name,
(SELECT COUNT(*) FROM students s
WHERE s.group_id = g.id AND s.deleted_at IS NULL) AS students_count
FROM subject_groups sg
JOIN groups g ON g.id = sg.group_id
WHERE sg.subject_id = ? AND g.deleted_at IS NULL
ORDER BY g.name
`).all(req.subject.id);
const totalStudents = groups.reduce((sum, g) => sum + g.students_count, 0);
const workCounts = {
all: allAssignments.length,
pending: allAssignments.filter((a) => a.pending_count > 0).length,
accepted: allAssignments.filter((a) => a.accepted_count > 0).length,
};
return renderWith(res, 'teacher/content/assignments-list', {
title: req.subject.title,
subject: req.subject,
assignments, groups, totalStudents,
counts: getSubjectCounts(req.subject.id),
workCounts,
q, wfilter,
});
})
);
router.get(
'/subjects/:subjectId/assignments/new',
checkTeacher, loadSubjectAsTeacher,
handler((req, res) => {
return renderWith(res, 'teacher/content/assignment-form', {
title: 'Новое задание',
subject: req.subject, mode: 'create',
assignment: { title: '', description: '', deadline: '', external_url: null },
deadlineInput: '', error: null,
existingFiles: [],
counts: getSubjectCounts(req.subject.id),
});
})
);
router.post(
'/subjects/:subjectId/assignments',
checkTeacher, loadSubjectAsTeacher,
uploadWithFallback(
assignmentUpload.array('files', filesPolicy.MAX_FILES_PER_UPLOAD),
(err, req, res) => {
const locals = assignmentFormLocalsFromBody(req, 'create', []);
return renderErr(res, 'teacher/content/assignment-form', locals, friendlyFileError(err));
}
),
handler((req, res) => {
const files = req.files || [];
const cleanup = () => {
for (const f of files) if (f.path) fs.promises.unlink(f.path).catch(() => {});
};
const title = pickStr(req.body.title, 200);
const description = pickStr(req.body.description, 2000);
const deadline = normalizeDeadline(req.body.deadline);
const rawUrl = pickStr(req.body.external_url, 1000);
const externalUrl = validUrlOrNull(rawUrl);
const renderError = (msg) => {
cleanup();
const locals = assignmentFormLocalsFromBody(req, 'create', []);
return renderErr(res, 'teacher/content/assignment-form', locals, msg);
};
if (rawUrl && !externalUrl) return renderError('Ссылка должна начинаться с http:// или https://.');
if (!title) return renderError('Укажите название задания.');
const newId = db.transaction(() => {
const r = db.prepare(`
INSERT INTO assignments
(teacher_id, subject_id, title, description, deadline, external_url, status)
VALUES (?, ?, ?, ?, ?, ?, 'active')
`).run(
req.session.teacherId, req.subject.id, title, description || null, deadline, externalUrl
);
const aid = Number(r.lastInsertRowid);
for (let i = 0; i < files.length; i++) {
attachments.addAttachment('assignment', aid, {
stored_name: req.storedNames[i],
filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
filesize: files[i].size,
});
}
return aid;
})();
audit(req, 'assignment.create', 'assignment', newId, {
title, subject_id: req.subject.id,
});
const action = pickStr(req.body._action, 20) || 'open';
if (action === 'again') {
return res.redirect(`/subjects/${req.subject.id}/assignments/new?added=1`);
}
return res.redirect(`/subjects/${req.subject.id}/assignments/${newId}?created=1`);
})
);
router.get(
'/subjects/:subjectId/assignments/:assignmentId',
checkTeacher, loadSubjectAsTeacher, loadAssignmentAsTeacher,
handler((req, res) => {
const groupFilter = pickInt(req.query.group);
const topic = db.prepare(
'SELECT * FROM topics WHERE assignment_id = ? AND deleted_at IS NULL LIMIT 1'
).get(req.assignment.id) || null;
if (topic) topic.attachments = attachments.listAttachments('topic', topic.id);
const attachedGroups = db.prepare(`
SELECT g.id, g.name FROM subject_groups sg
JOIN groups g ON g.id = sg.group_id
WHERE sg.subject_id = ? AND g.deleted_at IS NULL
ORDER BY g.name
`).all(req.subject.id);
let where = ' WHERE s.assignment_id = ? AND s.teacher_id = ? AND s.deleted_at IS NULL';
const params = [req.assignment.id, req.session.teacherId];
if (groupFilter) { where += ' AND s.group_id = ?'; params.push(groupFilter); }
const works = db.prepare(`
SELECT s.*, st.name AS student_name, st.login AS student_login,
g.name AS group_name,
(SELECT COUNT(*) FROM messages m
WHERE m.submission_id = s.id AND m.sender_type = 'student'
AND m.is_read = 0 AND m.deleted_at IS NULL) AS unread_count,
(SELECT COUNT(*) FROM attachments a
WHERE a.owner_kind = 'submission' AND a.owner_id = s.id) AS files_count
FROM submissions s
JOIN students st ON st.id = s.student_id
JOIN groups g ON g.id = s.group_id
${where}
ORDER BY s.uploaded_at DESC, s.id DESC
`).all(...params);
const students = db.prepare(`
SELECT s.id, s.name, s.login, s.group_id, g.name AS group_name
FROM students s
JOIN groups g ON g.id = s.group_id
WHERE s.group_id IN (SELECT group_id FROM subject_groups WHERE subject_id = ?)
AND s.deleted_at IS NULL
ORDER BY g.name, s.name
`).all(req.subject.id);
return renderWith(res, 'teacher/content/assignment', {
title: req.assignment.title,
subject: req.subject,
assignment: req.assignment,
topic, works, students, attachedGroups,
selectedGroup: groupFilter || null,
deadlineInput: toInputDatetime(req.assignment.deadline),
});
})
);
router.get(
'/subjects/:subjectId/assignments/:assignmentId/edit',
checkTeacher, loadSubjectAsTeacher, loadAssignmentAsTeacher,
handler((req, res) => {
return renderWith(res, 'teacher/content/assignment-form', {
title: 'Редактировать задание',
subject: req.subject, mode: 'edit',
assignment: req.assignment,
deadlineInput: toInputDatetime(req.assignment.deadline),
error: null,
existingFiles: req.assignment.attachments,
counts: getSubjectCounts(req.subject.id),
});
})
);
router.post(
'/subjects/:subjectId/assignments/:assignmentId',
checkTeacher, loadSubjectAsTeacher, loadAssignmentAsTeacher,
uploadWithFallback(
assignmentUpload.array('files', filesPolicy.MAX_FILES_PER_UPLOAD),
(err, req, res) => {
const existingFiles = attachments.listAttachments('assignment', req.assignment.id);
const locals = assignmentFormLocalsFromBody(req, 'edit', existingFiles);
return renderErr(res, 'teacher/content/assignment-form', locals, friendlyFileError(err));
}
),
handler((req, res) => {
const files = req.files || [];
const cleanup = () => {
for (const f of files) if (f.path) fs.promises.unlink(f.path).catch(() => {});
};
const title = pickStr(req.body.title, 200);
const description = pickStr(req.body.description, 2000);
const deadline = normalizeDeadline(req.body.deadline);
const rawUrl = pickStr(req.body.external_url, 1000);
const externalUrl = validUrlOrNull(rawUrl);
const existingFiles = attachments.listAttachments('assignment', req.assignment.id);
const renderError = (msg) => {
cleanup();
const locals = assignmentFormLocalsFromBody(req, 'edit', existingFiles);
return renderErr(res, 'teacher/content/assignment-form', locals, msg);
};
if (rawUrl && !externalUrl) return renderError('Ссылка должна начинаться с http:// или https://.');
if (!title) return renderError('Укажите название задания.');
const removeIds = pickIds(req.body.remove_file_ids);
const removedStored = [];
db.transaction(() => {
db.prepare(`
UPDATE assignments
SET title = ?, description = ?, deadline = ?, external_url = ?
WHERE id = ? AND deleted_at IS NULL
`).run(title, description || null, deadline, externalUrl, req.assignment.id);
for (const id of removeIds) {
const a = attachments.getAttachment(id);
if (a && a.owner_kind === 'assignment' && a.owner_id === req.assignment.id) {
removedStored.push(a.stored_name);
attachments.removeAttachment(id);
}
}
for (let i = 0; i < files.length; i++) {
attachments.addAttachment('assignment', req.assignment.id, {
stored_name: req.storedNames[i],
filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
filesize: files[i].size,
});
}
})();
for (const sn of removedStored) {
try { fs.promises.unlink(safeJoin(config.STORAGE_DIR, sn)).catch(() => {}); } catch { /* ignore */ }
}
audit(req, 'assignment.update', 'assignment', req.assignment.id, {
title, subject_id: req.subject.id,
});
const action = pickStr(req.body._action, 20) || 'open';
if (action === 'again') {
return res.redirect(`/subjects/${req.subject.id}/assignments/new?added=1`);
}
return res.redirect(`/subjects/${req.subject.id}/assignments/${req.assignment.id}?updated=1`);
})
);
router.post(
'/subjects/:subjectId/assignments/:assignmentId/delete',
checkTeacher, loadSubjectAsTeacher, loadAssignmentAsTeacher,
handler((req, res) => {
lifecycle.softDelete('assignments', req.assignment.id);
audit(req, 'assignment.delete', 'assignment', req.assignment.id, {
title: req.assignment.title, subject_id: req.subject.id,
mode: 'soft', by: 'teacher',
});
return res.redirect(`/subjects/${req.subject.id}/assignments?deleted=1`);
})
);
module.exports = router;