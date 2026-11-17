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
const {
    normalizeDeadline, normalizeAvailableFrom, toInputDatetime, getSubjectCounts,
    normalizeTopicMode, syncTopicAssignment, resolveDescription, resolveHomeworkText,
    resolveAssignmentUrl, resolveTitle, validUrlOrNull,
    topicFormLocalsFromBody, assignmentFormLocalsFromBody,
    QUILL_HEADER, QUIZ_CSS, topicHeadExtra,
    MAX_DESCRIPTION_LENGTH, MAX_HOMEWORK_TEXT_LENGTH, TOPIC_MODES,
} = require('./content-form');
// ← НОВОЕ: подсистема тестирования
const {
getQuizForEditor,
applyQuizModeOnTopicSave,
} = require('../../utils/quiz-repo');
const { validateQuizPayload } = require('../../utils/quiz');
const topicsRouter = require('./content-topics');
router.use(topicsRouter);

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