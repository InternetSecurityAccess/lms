// routes/teacher/quiz.js
'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const router = express.Router();

const db = require('../../database');
const config = require('../../config');
const filesPolicy = require('../../config/files');
const { checkTeacher } = require('../shared/authz');
const {
  handler, renderWith, renderErr, audit, notFound,
  uploadWithFallback, friendlyFileError,
} = require('../shared/handlers');
const { pickStr, pickIds } = require('../shared/form');
const { loadSubjectAsTeacher, loadTopicAsTeacher } = require('../shared/loaders');
const { lectureUpload } = require('../../utils/storage');
const { sanitizeHtml, textToHtml } = require('../../utils/sanitize');
const { sanitizeUrlOrNull } = require('../../utils/validation');
const { safeJoin, fixFilename } = require('../../utils/helpers');
const attachments = require('../../utils/attachments');
const { nowSql } = require('../../utils/dates');
const { utcToLocalParts, localPartsToUtc } = require('../../utils/timezone');
const { cleanupAssignmentFiles } = require('../../utils/storage/cleanup');
const { validateQuizPayload } = require('../../utils/quiz');
const quizRepo = require('../../utils/quiz-repo');

/* ═══════════════════════════════════════════════════════════
   Темы-тесты на стороне преподавателя.

   Роутер стоит ДО content.js и перехватывает только «свои» запросы:
     GET  /subjects/:sid/topics/new?assignment_mode=quiz
     GET  /subjects/:sid/topics/:tid/edit    — если topics.quiz_id
     GET  /subjects/:sid/topics/:tid         — редирект на результаты
     POST /subjects/:sid/topics?quiz=1
     POST /subjects/:sid/topics/:tid?quiz=1
   Флаг ?quiz=1 ставит форма (см. topic-form.ejs): он нужен, чтобы
   решить «наш ли это запрос» ДО разбора multipart-тела.
   Всё остальное уходит в content.js через next().
   ═══════════════════════════════════════════════════════════ */

const MAX_DESCRIPTION_LENGTH = 1_000_000;
const TOPIC_MODES = ['none_with_hw', 'none_no_hw', 'internal', 'quiz'];

const QUILL_HEADER = `
<link href="/vendor/quill/quill.snow.css" rel="stylesheet">
<link href="/vendor/quill-resize/resize.css" rel="stylesheet">
<script src="/vendor/quill/quill.js"></script>
<script src="/vendor/quill-resize/resize.js" defer></script>
`;

function normalizeMode(raw) {
  const v = String(raw || '').trim();
  return TOPIC_MODES.includes(v) ? v : 'none_with_hw';
}

function normalizeDatetime(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return localPartsToUtc(+y, +mo, +d, +h, +mi, config.COLLEGE.TZ);
}

function toInputDatetime(value) {
  if (!value) return '';
  const p = utcToLocalParts(String(value), config.COLLEGE.TZ);
  if (!p) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

function normalizeDescription(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  return sanitizeHtml(value).slice(0, MAX_DESCRIPTION_LENGTH);
}

function isTeacherReq(req) {
  return !!req.session?.teacherId;
}

// Дешёвая проверка «тема моя и это тест» — без загрузчиков и без 404.
function peekTopic(req) {
  const sid = Number(req.params.subjectId);
  const tid = Number(req.params.topicId);
  if (!Number.isSafeInteger(sid) || sid < 1) return null;
  if (!Number.isSafeInteger(tid) || tid < 1) return null;
  return db.prepare(`
    SELECT t.id, t.quiz_id
    FROM topics t JOIN subjects s ON s.id = t.subject_id
    WHERE t.id = ? AND t.subject_id = ? AND s.teacher_id = ?
      AND t.deleted_at IS NULL AND s.deleted_at IS NULL
  `).get(tid, sid, req.session.teacherId) || null;
}

/* ═══════════════ Локалы формы ═══════════════ */

function baseLocals(req, mode) {
  return {
    title: mode === 'create' ? 'Новая тема' : 'Редактировать тему',
    subject: req.subject,
    mode,
    topic: {
      title: '', description: '', content_url: '', assignment_url: '',
      assignment_id: null, quiz_id: null, status: 'published',
      homework_text: null, available_from: null,
    },
    assignment: null,
    assignmentDeadlineInput: '',
    availableFromInput: '',
    initialHtml: '',
    error: null,
    existingFiles: [],
    headExtra: QUILL_HEADER,
    defaultAssignmentMode: 'quiz',
    quizData: null,
    quizAttemptsCount: 0,
    quizErrors: [],
  };
}

function bodyLocals(req, mode, existingFiles, error, quizErrors) {
  const rawDescription = pickStr(req.body.description, MAX_DESCRIPTION_LENGTH);
  const modeVal = normalizeMode(req.body.assignment_mode);
  const status = (mode === 'edit' && req.topic && req.topic.status === 'finished')
    ? 'finished'
    : (['draft', 'published'].includes(req.body.status) ? req.body.status : 'published');

  let quizPayload = null;
  try { quizPayload = JSON.parse(req.body.quiz_json || 'null'); } catch { /* ignore */ }

  return {
    ...baseLocals(req, mode),
    topic: {
      ...(mode === 'edit' ? req.topic : {}),
      title: pickStr(req.body.title, 200) || pickStr(req.body.assignment_title, 200),
      description: rawDescription,
      content_url: pickStr(req.body.content_url, 1000),
      assignment_url: pickStr(req.body.assignment_url, 1000),
      homework_text: pickStr(req.body.homework_text, 2000),
      status,
      available_from: normalizeDatetime(pickStr(req.body.available_from, 30)),
    },
    assignment: modeVal === 'internal'
      ? {
        title: pickStr(req.body.assignment_title, 200),
        description: pickStr(req.body.assignment_description, 2000),
      }
      : null,
    assignmentDeadlineInput: pickStr(req.body.assignment_deadline, 30),
    availableFromInput: pickStr(req.body.available_from, 30),
    initialHtml: rawDescription.includes('<')
      ? rawDescription
      : (rawDescription ? textToHtml(rawDescription) : ''),
    defaultAssignmentMode: modeVal,
    existingFiles: existingFiles || [],
    error,
    quizData: quizPayload,
    quizAttemptsCount: (mode === 'edit' && req.topic?.quiz_id)
      ? quizRepo.countAttempts(req.topic.quiz_id)
      : 0,
    quizErrors: Array.isArray(quizErrors) ? quizErrors : [],
  };
}

/* ═══════════════ Синхронизация задания (как в content.js) ═══════════════ */

async function syncTopicAssignment({ teacherId, topic, body, topicStatus, modeVal }) {
  if (modeVal !== 'internal') {
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
  const deadline = normalizeDatetime(body.assignment_deadline);
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
    INSERT INTO assignments (teacher_id, subject_id, title, description, deadline, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(teacherId, topic.subject_id, title, description || null, deadline, assignStatus);
  return Number(r.lastInsertRowid);
}

/* ═══════════════ GET: форма создания теста ═══════════════ */

router.get('/subjects/:subjectId/topics/new', (req, res, next) => {
  if (!isTeacherReq(req) || req.query.assignment_mode !== 'quiz') return next();
  return checkTeacher(req, res, () => loadSubjectAsTeacher(req, res, () => handler((rq, rs) => {
    const locals = baseLocals(rq, 'create');
    locals.defaultAssignmentMode = 'quiz';
    return renderWith(rs, 'teacher/content/topic-form', locals);
  })(req, res, next)));
});

/* ═══════════════ GET: форма редактирования темы-теста ═══════════════ */

router.get('/subjects/:subjectId/topics/:topicId/edit', (req, res, next) => {
  if (!isTeacherReq(req)) return next();
  const peek = peekTopic(req);
  if (!peek || !peek.quiz_id) return next();

  return checkTeacher(req, res, () => loadSubjectAsTeacher(req, res, () => loadTopicAsTeacher(req, res, () => handler((rq, rs) => {
    const data = quizRepo.getQuizForEditor(rq.topic.id);
    const rawDesc = rq.topic.description || '';
    const locals = {
      ...baseLocals(rq, 'edit'),
      topic: rq.topic,
      availableFromInput: toInputDatetime(rq.topic.available_from),
      initialHtml: rawDesc.includes('<') ? rawDesc : (rawDesc ? textToHtml(rawDesc) : ''),
      existingFiles: rq.topic.attachments,
      defaultAssignmentMode: 'quiz',
      quizData: data ? data.quiz : null,
      quizAttemptsCount: data ? data.attemptsCount : 0,
    };
    return renderWith(rs, 'teacher/content/topic-form', locals);
  })(req, res, next))));
});

/* ═══════════════ GET: просмотр темы-теста → результаты ═══════════════ */

router.get('/subjects/:subjectId/topics/:topicId', (req, res, next) => {
  if (!isTeacherReq(req)) return next();
  const peek = peekTopic(req);
  if (!peek || !peek.quiz_id) return next();
  return res.redirect(`/teacher/quiz/${peek.id}/results`);
});

/* ═══════════════ POST: сохранение темы ═══════════════ */

async function handleSave(req, res, mode) {
  const files = req.files || [];
  const cleanup = () => {
    for (const f of files) if (f.path) fs.promises.unlink(f.path).catch(() => {});
  };
  const existingFiles = mode === 'edit'
    ? attachments.listAttachments('topic', req.topic.id)
    : [];

  const fail = (msg, quizErrors) => {
    cleanup();
    return renderErr(
      res,
      'teacher/content/topic-form',
      bodyLocals(req, mode, existingFiles, msg, quizErrors),
      msg
    );
  };

  const modeVal = normalizeMode(req.body.assignment_mode);
  const title = pickStr(req.body.title, 200) || pickStr(req.body.assignment_title, 200);
  if (!title) return fail('Укажите название темы.');

  const rawContent = pickStr(req.body.content_url, 1000);
  const rawAssign = pickStr(req.body.assignment_url, 1000);
  const contentUrl = rawContent ? sanitizeUrlOrNull(rawContent) : null;
  const assignUrl = rawAssign ? sanitizeUrlOrNull(rawAssign) : null;

  if (modeVal === 'none_with_hw' || modeVal === 'none_no_hw') {
    if (rawContent && !contentUrl) {
      return fail('Ссылка на источник должна начинаться с http:// или https://.');
    }
    if (modeVal === 'none_with_hw' && rawAssign && !assignUrl) {
      return fail('Ссылка на ДЗ должна начинаться с http:// или https://.');
    }
  }

  const availableFrom = normalizeDatetime(pickStr(req.body.available_from, 30));
  const status = (mode === 'edit' && req.topic.status === 'finished')
    ? 'finished'
    : (['draft', 'published'].includes(req.body.status) ? req.body.status : 'published');

  // ── Валидация теста ДО любых записей ──
  let quizPayload = null;
  if (modeVal === 'quiz') {
    try { quizPayload = JSON.parse(req.body.quiz_json || '{}'); }
    catch { return fail('Некорректный JSON теста.'); }

    const hasAtt = mode === 'edit' && req.topic.quiz_id
      ? quizRepo.countAttempts(req.topic.quiz_id) > 0
      : false;
    const effective = hasAtt
      ? { ...quizPayload, questions: quizRepo.questionsPayloadFromDb(req.topic.quiz_id) }
      : quizPayload;

    const v = validateQuizPayload(effective, { forPublish: status === 'published' });
    if (!v.ok) {
      return fail(
        status === 'published'
          ? 'Тест не готов к публикации. Исправьте замечания или сохраните как черновик.'
          : 'Проверьте настройки теста и вопросы.',
        v.errors
      );
    }
  }

  const description = (modeVal === 'quiz' || modeVal === 'internal')
    ? null
    : normalizeDescription(req.body.description);
  const homeworkText = modeVal === 'none_with_hw'
    ? (pickStr(req.body.homework_text, 2000) || null)
    : null;
  const finalContentUrl = (modeVal === 'quiz' || modeVal === 'internal') ? null : contentUrl;

  const topicForSync = mode === 'edit'
    ? req.topic
    : { title, subject_id: req.subject.id, assignment_id: null };

  const assignmentId = await syncTopicAssignment({
    teacherId: req.session.teacherId,
    topic: topicForSync,
    body: req.body,
    topicStatus: status,
    modeVal,
  });

  const finalAssignUrl = (modeVal === 'none_with_hw' && !assignmentId) ? assignUrl : null;

  let topicId;
  const removeIds = mode === 'edit' ? pickIds(req.body.remove_file_ids) : [];
  const removedStored = [];

  if (mode === 'create') {
    const maxPos = db.prepare(
      'SELECT COALESCE(MAX(position), 0) AS m FROM topics WHERE subject_id = ?'
    ).get(req.subject.id).m;

    topicId = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO topics
          (subject_id, title, description, content_url, assignment_url,
           assignment_id, homework_text, position, status, published_at, available_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.subject.id, title, description, finalContentUrl, finalAssignUrl,
        assignmentId, homeworkText, maxPos + 1, status,
        status === 'published' ? nowSql() : null,
        availableFrom
      );
      const id = Number(r.lastInsertRowid);
      for (let i = 0; i < files.length; i++) {
        attachments.addAttachment('topic', id, {
          stored_name: req.storedNames[i],
          filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
          filesize: files[i].size,
        });
      }
      return id;
    })();
  } else {
    topicId = req.topic.id;
    const publishedAt = status === 'published'
      ? (req.topic.published_at || nowSql())
      : (req.topic.published_at || null);

    db.transaction(() => {
      db.prepare(`
        UPDATE topics
        SET title = ?, description = ?, content_url = ?, assignment_url = ?,
            assignment_id = ?, homework_text = ?, status = ?, published_at = ?,
            available_from = ?
        WHERE id = ?
      `).run(
        title, description, finalContentUrl, finalAssignUrl,
        assignmentId, homeworkText, status, publishedAt, availableFrom,
        topicId
      );

      for (const id of removeIds) {
        const a = attachments.getAttachment(id);
        if (a && a.owner_kind === 'topic' && a.owner_id === topicId) {
          removedStored.push(a.stored_name);
          attachments.removeAttachment(id);
        }
      }
      for (let i = 0; i < files.length; i++) {
        attachments.addAttachment('topic', topicId, {
          stored_name: req.storedNames[i],
          filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
          filesize: files[i].size,
        });
      }
    })();

    for (const sn of removedStored) {
      try { fs.promises.unlink(safeJoin(config.STORAGE_DIR, sn)).catch(() => {}); } catch { /* ignore */ }
    }
  }

  // ── Тест: сохранить или отвязать ──
  let quizLocked = false;
  if (modeVal === 'quiz') {
    const r = quizRepo.saveQuizForTopic({
      topicId,
      teacherId: req.session.teacherId,
      payload: quizPayload,
      forPublish: status === 'published',
    });
    if (!r.ok) {
      return renderErr(
        res,
        'teacher/content/topic-form',
        bodyLocals(req, mode, existingFiles, r.error, r.errors),
        r.error
      );
    }
    quizLocked = !!r.locked;
  } else if (mode === 'edit' && req.topic.quiz_id) {
    const d = quizRepo.detachQuizFromTopic(topicId);
    if (!d.ok) {
      return renderErr(
        res,
        'teacher/content/topic-form',
        bodyLocals(req, mode, existingFiles, d.error, d.errors),
        d.error
      );
    }
  }

  audit(req, mode === 'create' ? 'topic.create' : 'topic.update', 'topic', topicId, {
    title,
    subject_id: req.subject.id,
    assignment_id: assignmentId || null,
    status,
    available_from: availableFrom,
    mode: modeVal,
    quiz_locked: quizLocked,
  });

  const action = pickStr(req.body._action, 20) || 'open';
  if (action === 'again') {
    return res.redirect(
      `/subjects/${req.subject.id}/topics/new?assignment_mode=${modeVal}&added=1`
    );
  }
  if (modeVal === 'quiz') {
    return res.redirect(
      `/subjects/${req.subject.id}/topics/${topicId}/edit?saved=1${quizLocked ? '&locked=1' : ''}`
    );
  }
  if (assignmentId) {
    return res.redirect(`/subjects/${req.subject.id}/assignments/${assignmentId}?updated=1`);
  }
  return res.redirect(`/subjects/${req.subject.id}/topics/${topicId}?updated=1`);
}

function uploadErrorHandler(req, res) {
  const mode = req.topic ? 'edit' : 'create';
  const existingFiles = req.topic ? attachments.listAttachments('topic', req.topic.id) : [];
  const msg = friendlyFileError({ code: 'LIMIT_FILE_SIZE' });
  return renderErr(
    res,
    'teacher/content/topic-form',
    bodyLocals(req, mode, existingFiles, msg, []),
    msg
  );
}

router.post('/subjects/:subjectId/topics', (req, res, next) => {
  if (!isTeacherReq(req) || req.query.quiz !== '1') return next();
  return checkTeacher(req, res, () => loadSubjectAsTeacher(req, res, () => {
    uploadWithFallback(
      lectureUpload.array('files', filesPolicy.MAX_FILES_PER_UPLOAD),
      (err, rq, rs) => uploadErrorHandler(rq, rs)
    )(req, res, (err) => {
      if (err) return next(err);
      return handler((rq, rs) => handleSave(rq, rs, 'create'))(req, res, next);
    });
  }));
});

router.post('/subjects/:subjectId/topics/:topicId', (req, res, next) => {
  if (!isTeacherReq(req) || req.query.quiz !== '1') return next();
  return checkTeacher(req, res, () => loadSubjectAsTeacher(req, res, () => loadTopicAsTeacher(req, res, () => {
    uploadWithFallback(
      lectureUpload.array('files', filesPolicy.MAX_FILES_PER_UPLOAD),
      (err, rq, rs) => uploadErrorHandler(rq, rs)
    )(req, res, (err) => {
      if (err) return next(err);
      return handler((rq, rs) => handleSave(rq, rs, 'edit'))(req, res, next);
    });
  })));
});

/* ═══════════════ AJAX-сохранение теста (совместимость) ═══════════════ */

router.post('/teacher/quiz/:topicId/save', checkTeacher, handler((req, res) => {
  const topicId = Number(req.params.topicId);
  if (!Number.isSafeInteger(topicId) || topicId < 1) {
    return res.status(400).json({ ok: false, error: 'Неверный ID темы' });
  }
  let payload;
  try { payload = JSON.parse(req.body.quiz_json || '{}'); }
  catch { return res.status(400).json({ ok: false, error: 'Некорректный JSON теста' }); }

  const topic = db.prepare('SELECT status FROM topics WHERE id = ?').get(topicId);
  const result = quizRepo.saveQuizForTopic({
    topicId,
    teacherId: req.session.teacherId,
    payload,
    forPublish: topic?.status === 'published',
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, quizId: result.quizId, hasAttempts: result.hasAttempts });
}));

/* ═══════════════ Результаты теста ═══════════════ */

router.get('/teacher/quiz/:topicId/results', checkTeacher, handler((req, res) => {
  const topicId = Number(req.params.topicId);
  if (!Number.isSafeInteger(topicId) || topicId < 1) {
    return notFound(res, 'Тема не найдена.');
  }

  const topic = db.prepare(`
    SELECT t.id, t.title AS topic_title, t.subject_id, t.quiz_id, t.status,
           s.title AS subject_title, s.teacher_id
    FROM topics t JOIN subjects s ON s.id = t.subject_id
    WHERE t.id = ? AND t.deleted_at IS NULL
  `).get(topicId);

  if (!topic || Number(topic.teacher_id) !== Number(req.session.teacherId)) {
    return notFound(res, 'Тема не найдена.');
  }

  const quiz = topic.quiz_id
    ? db.prepare('SELECT * FROM quizzes WHERE id = ?').get(topic.quiz_id)
    : null;
  const entries = quiz ? (quizRepo.getAttemptsForQuiz(quiz.id, req.session.teacherId) || []) : [];

  // Фильтр по группе (как в работах по заданиям): ?group=<id>, пустой — все группы.
  const groupFilter = Number(req.query.group) || null;
  const visibleEntries = groupFilter
    ? entries.filter((e) => Number(e.student.group_id) === groupFilter)
    : entries;

  // Список групп предмета для чипов-фильтров.
  const groupsList = db.prepare(`
    SELECT DISTINCT g.id, g.name
    FROM quiz_attempts qa
    JOIN students st ON st.id = qa.student_id
    JOIN groups g    ON g.id = st.group_id
    WHERE qa.quiz_id = ?
    ORDER BY g.name
  `).all(quiz ? quiz.id : -1);

  const resultsGroups = quizRepo.groupResultsByGroup(visibleEntries);

  return renderWith(res, 'teacher/quiz/quiz-results', {
    title: 'Результаты теста',
    topic, quiz,
    groups: visibleEntries,
    resultsGroups,
    groupsList,
    selectedGroup: groupFilter,
    passedCount: entries.filter((e) => e.best && e.best.passed).length,
    pageTop: { title: 'Результаты теста' },
  });
}));

/* ═══════════════ Разбор попытки ═══════════════ */

router.get('/teacher/quiz/:topicId/attempt/:attemptId', checkTeacher, handler((req, res) => {
  const attemptId = Number(req.params.attemptId);
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    return notFound(res, 'Попытка не найдена.');
  }
  const data = quizRepo.getAttemptForReview(attemptId, req.session.teacherId);
  if (!data) return notFound(res, 'Попытка не найдена.');

  return renderWith(res, 'teacher/quiz/quiz-attempt-review', {
    title: 'Разбор попытки',
    attempt: data.attempt,
    questions: data.questions,
    pageTop: { title: 'Разбор попытки' },
  });
}));

module.exports = router;