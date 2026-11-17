// routes/teacher/content-topics.js
'use strict';
/**
 * HTTP-обработчики тем преподавателя: список заданий по всем предметам,
 * создание, импорт (CSV), редактирование, просмотр и удаление тем.
 * Выделено из content.js без изменения поведения (лимит размера файла).
 */
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const router = express.Router();
const db = require('../../database');
const filesPolicy = require('../../config/files');
const { checkTeacher } = require('../shared/authz');
const {
  handler, renderWith, renderErr, audit,
  uploadWithFallback, friendlyFileError,
} = require('../shared/handlers');
const { pickStr, pickInt } = require('../shared/form');
const {
  loadSubjectAsTeacher,
  loadTopicAsTeacher,
} = require('../shared/loaders');
const { fixFilename } = require('../../utils/helpers');
const { sanitizeUrlOrNull } = require('../../utils/validation');
const { lectureUpload } = require('../../utils/storage');
const { parseCsv, pick } = require('../../utils/csv');
const { sanitizeHtml, textToHtml } = require('../../utils/sanitize');
const attachments = require('../../utils/attachments');
const lifecycle = require('../../utils/lifecycle');
const { nowSql } = require('../../utils/dates');
const {
  normalizeAvailableFrom, getSubjectCounts,
  normalizeTopicMode, syncTopicAssignment, resolveDescription, resolveHomeworkText,
  resolveAssignmentUrl, resolveTitle,
  topicFormLocalsFromBody,
  MAX_DESCRIPTION_LENGTH,
} = require('./content-form');
const {
  getQuizForEditor,
  applyQuizModeOnTopicSave,
} = require('../../utils/quiz-repo');
const { validateQuizPayload } = require('../../utils/quiz');

const csvTopicUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

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
// flash-сообщения (в т.ч. ошибки сохранения из POST) — как во всём приложении
const newFlash = req.session?.formFlash;
if (newFlash) delete req.session.formFlash;
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
headExtra: topicHeadExtra(defaultAssignmentMode),
quizInitial,
flashes: newFlash ? [{ type: 'red', text: newFlash }] : undefined,
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
// Ошибки формы выводятся через flash-сообщения (как во всём приложении):
// сохраняем текст в сессии и делаем redirect back.
const renderError = (msg) => {
cleanup();
if (req.session) req.session.formFlash = msg;
return res.redirect(req.headers.referer || `/subjects/${req.subject.id}/topics`);
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
// Шаблон CSV для импорта тем (разделитель «;», BOM для Excel).
// Колонки соответствуют полям, которые читает POST /topics/import.
const csv = '\uFEFF' + [
'title;description;content_url;assignment_url;available_from;status',
'Название темы;Краткое описание темы;https://example.com/material;https://example.com/submit;2026-01-15T08:00;published',
'Вторая тема;Описание второй темы;;;;draft',
].join('\r\n') + '\r\n';
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
// flash-сообщения (в т.ч. ошибки сохранения из POST) — как во всём приложении
const editFlash = req.session?.formFlash;
if (editFlash) delete req.session.formFlash;
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
headExtra: topicHeadExtra(defaultAssignmentMode),
quizInitial,
flashes: editFlash ? [{ type: 'red', text: editFlash }] : undefined,
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
// Ошибки формы выводятся через flash-сообщения (как во всём приложении):
// сохраняем текст в сессии и делаем redirect back.
const renderError = (msg) => {
cleanup();
if (req.session) req.session.formFlash = msg;
return res.redirect(req.headers.referer || `/subjects/${req.subject.id}/topics/${req.topic.id}/edit`);
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

module.exports = router;
