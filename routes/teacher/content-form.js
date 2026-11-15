// routes/teacher/content-form.js
'use strict';
/**
 * Хелперы нормализации формы темы/задания (рефакторинг content.js).
 * Тело функций перенесено дословно, без изменения поведения.
 */
const db = require('../../database');
const config = require('../../config');
const { pickStr } = require('../shared/form');
const { sanitizeHtml, textToHtml } = require('../../utils/sanitize');
const { utcToLocalParts, localPartsToUtc } = require('../../utils/timezone');
const { cleanupAssignmentFiles } = require('../../utils/storage/cleanup');

/** Подключение редактора Quill на страницах форм. */
const QUILL_HEADER = `
    <link href="/vendor/quill/quill.snow.css" rel="stylesheet">
    <link href="/vendor/quill-resize/resize.css" rel="stylesheet">
    <script src="/vendor/quill/quill.js"></script>
    <script src="/vendor/quill-resize/resize.js" defer></script>
`;
/** Стили конструктора тестов (режим quiz). */
const QUIZ_CSS = `<link rel="stylesheet" href="/css/quiz.css">`;
/** headExtra для форм тем: Quill + quiz.css, если режим quiz. */
function topicHeadExtra(bodyMode) {
    return QUILL_HEADER + (bodyMode === 'quiz' ? QUIZ_CSS : '');
}

const MAX_DESCRIPTION_LENGTH = 1_000_000;
const MAX_HOMEWORK_TEXT_LENGTH = 2000;
const TOPIC_MODES = Object.freeze(['none_with_hw', 'none_no_hw', 'internal', 'quiz']);

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

module.exports = {
    QUILL_HEADER,
    QUIZ_CSS,
    topicHeadExtra,
    MAX_DESCRIPTION_LENGTH,
    MAX_HOMEWORK_TEXT_LENGTH,
    TOPIC_MODES,
    normalizeDeadline,
    normalizeAvailableFrom,
    toInputDatetime,
    getSubjectCounts,
    normalizeTopicMode,
    syncTopicAssignment,
    normalizeDescription,
    resolveDescription,
    resolveHomeworkText,
    resolveAssignmentUrl,
    resolveTitle,
    validUrlOrNull,
    topicFormLocalsFromBody,
    assignmentFormLocalsFromBody,
};
