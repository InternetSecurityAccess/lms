// routes/student/quiz.js
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');

const { checkStudent } = require('../shared/authz');
const { loadStudentRow } = require('../shared/loaders');
const { handler, notFound } = require('../shared/handlers');
const { buildAttempt } = require('../../utils/quiz');
const { submitAttempt } = require('../../utils/quiz-submit');
const { nowSql } = require('../../utils/dates');

/* ═══════════════════════════════════════════════════════════
   Тесты на стороне студента.

   Канонические URL (их же генерят шаблоны):
     GET  /my-subjects/:sid/topics/:tid/quiz
     POST /my-subjects/:sid/topics/:tid/quiz/start
     GET  /my-subjects/:sid/topics/:tid/quiz/attempt/:aid
     POST /my-subjects/:sid/topics/:tid/quiz/attempt/:aid/submit
     GET  /my-subjects/:sid/topics/:tid/quiz/attempt/:aid/result

   Плюс перехват клика «Открыть» в списке тем:
     GET  /t/:teacherId/subjects/:sid/topics/:tid  → редирект на тест.
   ═══════════════════════════════════════════════════════════ */

function safeJsonArray(s, fallback = []) {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : fallback;
  } catch { return fallback; }
}

function safeJsonObject(s, fallback = {}) {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback;
  } catch { return fallback; }
}

function quizUrl(subjectId, topicId) {
  return `/my-subjects/${subjectId}/topics/${topicId}/quiz`;
}

/* ─── Перехват темы-теста в общем списке ─── */
router.get('/t/:teacherId/subjects/:subjectId/topics/:topicId', (req, res, next) => {
  if (!req.session?.studentId) return next();
  const sid = Number(req.params.subjectId);
  const tid = Number(req.params.topicId);
  if (!Number.isSafeInteger(sid) || !Number.isSafeInteger(tid)) return next();

  const row = db.prepare(
    'SELECT quiz_id FROM topics WHERE id = ? AND subject_id = ? AND deleted_at IS NULL'
  ).get(tid, sid);
  if (!row || !row.quiz_id) return next();

  return res.redirect(quizUrl(sid, tid));
});

/* ─── Доступ к теме-тесту: единая точка для всех маршрутов ─── */
function loadQuizTopic(req, res, next) {
  const topicId = Number(req.params.topicId);
  const subjectId = Number(req.params.subjectId);
  if (!Number.isSafeInteger(topicId) || topicId < 1
    || !Number.isSafeInteger(subjectId) || subjectId < 1) {
    return notFound(res, 'Тест не найден или недоступен.');
  }

  const row = db.prepare(`
    SELECT
      t.id, t.title AS topic_title, t.status, t.available_from, t.created_at,
      t.quiz_id, t.subject_id, t.deleted_at,
      s.title AS subject_title, s.status AS subject_status,
      s.deleted_at AS subject_deleted_at, s.teacher_id,
      te.status AS teacher_status, te.deleted_at AS teacher_deleted_at,
      qz.title AS quiz_title, qz.description, qz.pass_percent,
      qz.max_attempts, qz.time_limit_minutes, qz.show_correct
    FROM topics t
    JOIN subjects s  ON s.id = t.subject_id
    JOIN teachers te ON te.id = s.teacher_id
    LEFT JOIN quizzes qz ON qz.id = t.quiz_id
    WHERE t.id = ? AND t.subject_id = ?
    LIMIT 1
  `).get(topicId, subjectId);

  const me = req.me;
  if (!row || !me) return notFound(res, 'Тест не найден или недоступен.');
  if (row.deleted_at || row.subject_deleted_at || row.teacher_deleted_at) {
    return notFound(res, 'Тест не найден или недоступен.');
  }
  if (!row.quiz_id) return notFound(res, 'Тест не найден или недоступен.');
  if (row.status !== 'published' && row.status !== 'finished') {
    return notFound(res, 'Тест не найден или недоступен.');
  }

  // Активная пара предмет↔группа либо readonly-история.
  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(row.subject_id, me.group_id);

  const history = !activePair
    ? db.prepare(`
        SELECT finished_at FROM subject_groups_history
        WHERE subject_id = ? AND group_id = ?
        ORDER BY finished_at DESC LIMIT 1
      `).get(row.subject_id, me.group_id)
    : null;

  if (!activePair && !history) return notFound(res, 'Тест не найден или недоступен.');

  if (activePair) {
    if (row.available_from && String(row.available_from) > nowSql()) {
      return notFound(res, 'Тест ещё не открыт.');
    }
  } else {
    const f = history.finished_at;
    if (row.created_at && String(row.created_at) > String(f)) {
      return notFound(res, 'Тест не найден или недоступен.');
    }
    if (row.available_from && String(row.available_from) > String(f)) {
      return notFound(res, 'Тест не найден или недоступен.');
    }
  }

  row.readonly = !activePair
    || row.status !== 'published'
    || row.subject_status !== 'active'
    || row.teacher_status !== 'active'
    || me.status !== 'active'
    || me.group_status !== 'active';

  req.quizTopic = row;
  return next();
}

/* ─── Вопросы в порядке снимка попытки ─── */
function buildAttemptView(att, { withAnswers = false } = {}) {
  const order = safeJsonArray(att.question_order);
  const optionOrders = safeJsonObject(att.option_orders);

  let questionIds = order.length > 0
    ? order
    : db.prepare(
      'SELECT id FROM quiz_questions WHERE quiz_id = ? ORDER BY position ASC, id ASC'
    ).all(att.quiz_id).map((r) => r.id);

  if (questionIds.length === 0) return [];

  const ph = questionIds.map(() => '?').join(',');
  const qRows = db.prepare(`SELECT * FROM quiz_questions WHERE id IN (${ph})`).all(...questionIds);
  const qById = new Map(qRows.map((q) => [q.id, q]));

  const oRows = db.prepare(`SELECT * FROM quiz_options WHERE question_id IN (${ph})`).all(...questionIds);
  const oByQ = new Map();
  for (const o of oRows) {
    if (!oByQ.has(o.question_id)) oByQ.set(o.question_id, []);
    oByQ.get(o.question_id).push(o);
  }

  const ansByQ = new Map();
  if (withAnswers) {
    for (const a of db.prepare('SELECT * FROM quiz_answers WHERE attempt_id = ?').all(att.id)) {
      ansByQ.set(a.question_id, a);
    }
  }

  const result = [];
  for (const qid of questionIds) {
    const q = qById.get(qid);
    if (!q) continue;

    const all = oByQ.get(q.id) || [];
    let opts = all;
    const snap = optionOrders[q.id];
    if (Array.isArray(snap) && snap.length === all.length) {
      const idx = new Map(all.map((o) => [o.id, o]));
      const ordered = [];
      for (const oid of snap) if (idx.has(oid)) ordered.push(idx.get(oid));
      if (ordered.length === all.length) opts = ordered;
    }

    const item = { ...q, options: opts };
    if (withAnswers) {
      const a = ansByQ.get(q.id);
      item.selected_ids = a ? safeJsonArray(a.option_ids) : [];
      item.got_score = a ? a.score : 0;
    }
    result.push(item);
  }
  return result;
}

const quizGuards = [checkStudent, loadStudentRow, loadQuizTopic];

/* ═══════════════ Инфо ═══════════════ */

router.get('/my-subjects/:subjectId/topics/:topicId/quiz', ...quizGuards, handler((req, res) => {
  const topic = req.quizTopic;

  const attempts = db.prepare(`
    SELECT * FROM quiz_attempts
    WHERE quiz_id = ? AND student_id = ?
    ORDER BY started_at DESC, id DESC
  `).all(topic.quiz_id, req.me.id);

  const inProgress = attempts.find((a) => a.status === 'in_progress') || null;
  const finished = attempts.filter((a) => a.status !== 'in_progress');
  const best = finished.length > 0
    ? finished.reduce((b, a) => ((a.score || 0) > (b.score || 0) ? a : b), finished[0])
    : null;

  const attemptsUsed = finished.length;
  const attemptsLeft = Number(topic.max_attempts) === 0
    ? Infinity
    : Math.max(0, Number(topic.max_attempts) - attemptsUsed);

  const questionsCount = db.prepare(
    'SELECT COUNT(*) AS c FROM quiz_questions WHERE quiz_id = ?'
  ).get(topic.quiz_id).c;

  const canStart = !topic.readonly && attemptsLeft > 0 && questionsCount > 0;
  const percent = best && best.max_score
    ? Math.round((best.score / best.max_score) * 100)
    : null;

  return res.render('student/quiz/quiz-info', {
    title: topic.quiz_title || topic.topic_title,
    me: req.me,
    topic,
    attempts, inProgress, best, percent,
    attemptsUsed, attemptsLeft, canStart, questionsCount,
    readonly: topic.readonly,
    pageTop: { title: topic.quiz_title || topic.topic_title },
  });
}));

/* ═══════════════ Старт / продолжение ═══════════════ */

router.post('/my-subjects/:subjectId/topics/:topicId/quiz/start', ...quizGuards, handler((req, res) => {
  const topic = req.quizTopic;
  const back = quizUrl(topic.subject_id, topic.id);

  const inProg = db.prepare(`
    SELECT id FROM quiz_attempts
    WHERE quiz_id = ? AND student_id = ? AND status = 'in_progress'
    ORDER BY started_at DESC LIMIT 1
  `).get(topic.quiz_id, req.me.id);

  if (inProg) return res.redirect(`${back}/attempt/${inProg.id}`);
  if (topic.readonly) return res.redirect(back);

  const used = db.prepare(`
    SELECT COUNT(*) AS c FROM quiz_attempts
    WHERE quiz_id = ? AND student_id = ? AND status != 'in_progress'
  `).get(topic.quiz_id, req.me.id).c;

  if (Number(topic.max_attempts) > 0 && used >= Number(topic.max_attempts)) {
    return res.redirect(back);
  }

  const questions = db.prepare(
    'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position ASC, id ASC'
  ).all(topic.quiz_id);
  if (questions.length === 0) return res.redirect(back);

  const qIds = questions.map((q) => q.id);
  const ph = qIds.map(() => '?').join(',');
  const options = db.prepare(
    `SELECT * FROM quiz_options WHERE question_id IN (${ph})`
  ).all(...qIds);

  const byQ = new Map();
  for (const o of options) {
    if (!byQ.has(o.question_id)) byQ.set(o.question_id, []);
    byQ.get(o.question_id).push(o);
  }
  const withOpts = questions.map((q) => ({ ...q, options: byQ.get(q.id) || [] }));
  const { order, optionOrders, maxScore } = buildAttempt(withOpts);

  // Защита от двойного клика: повторная проверка внутри транзакции.
  const attemptId = db.transaction(() => {
    const again = db.prepare(`
      SELECT id FROM quiz_attempts
      WHERE quiz_id = ? AND student_id = ? AND status = 'in_progress' LIMIT 1
    `).get(topic.quiz_id, req.me.id);
    if (again) return again.id;

    const r = db.prepare(`
      INSERT INTO quiz_attempts
        (quiz_id, student_id, question_order, option_orders, max_score)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      topic.quiz_id, req.me.id,
      JSON.stringify(order), JSON.stringify(optionOrders), maxScore
    );
    return Number(r.lastInsertRowid);
  })();

  return res.redirect(`${back}/attempt/${attemptId}`);
}));

/* ═══════════════ Прохождение ═══════════════ */

router.get('/my-subjects/:subjectId/topics/:topicId/quiz/attempt/:attemptId', ...quizGuards, handler((req, res) => {
  const topic = req.quizTopic;
  const attemptId = Number(req.params.attemptId);
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    return notFound(res, 'Попытка не найдена.');
  }

  const att = db.prepare(
    'SELECT * FROM quiz_attempts WHERE id = ? AND student_id = ? AND quiz_id = ?'
  ).get(attemptId, req.me.id, topic.quiz_id);
  if (!att) return notFound(res, 'Попытка не найдена.');

  const back = quizUrl(topic.subject_id, topic.id);
  if (att.status !== 'in_progress') return res.redirect(`${back}/attempt/${attemptId}/result`);

  return res.render('student/quiz/quiz-attempt', {
    title: 'Прохождение теста',
    me: req.me,
    topic,
    attempt: att,
    questions: buildAttemptView(att, { withAnswers: false }),
    timeLimitMinutes: Number(topic.time_limit_minutes) || 0,
    pageTop: { title: 'Прохождение теста' },
  });
}));

/* ═══════════════ Отправка ответов ═══════════════ */

router.post('/my-subjects/:subjectId/topics/:topicId/quiz/attempt/:attemptId/submit', ...quizGuards, handler((req, res) => {
  const topic = req.quizTopic;
  const attemptId = Number(req.params.attemptId);
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    return notFound(res, 'Попытка не найдена.');
  }
  const back = quizUrl(topic.subject_id, topic.id);

  // Завершить уже начатую попытку можно и в readonly — иначе ответы теряются.
  const result = submitAttempt({
    attemptId,
    studentId: req.me.id,
    answersJson: req.body.answers_json,
  });

  if (!result.ok) {
    return res.status(400).render('common/error', {
      title: 'Не удалось отправить ответы',
      message: result.error || 'Проверьте ответы и попробуйте ещё раз.',
      backUrl: `${back}/attempt/${attemptId}`,
      backLabel: '← Вернуться к тесту',
    });
  }
  return res.redirect(`${back}/attempt/${attemptId}/result`);
}));

/* ═══════════════ Результат ═══════════════ */

router.get('/my-subjects/:subjectId/topics/:topicId/quiz/attempt/:attemptId/result', ...quizGuards, handler((req, res) => {
  const topic = req.quizTopic;
  const attemptId = Number(req.params.attemptId);
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    return notFound(res, 'Попытка не найдена.');
  }

  const att = db.prepare(
    'SELECT * FROM quiz_attempts WHERE id = ? AND student_id = ? AND quiz_id = ?'
  ).get(attemptId, req.me.id, topic.quiz_id);
  if (!att) return notFound(res, 'Попытка не найдена.');

  const back = quizUrl(topic.subject_id, topic.id);
  if (att.status === 'in_progress') return res.redirect(`${back}/attempt/${attemptId}`);

  const review = topic.show_correct ? buildAttemptView(att, { withAnswers: true }) : null;
  const percent = att.max_score ? Math.round((att.score / att.max_score) * 100) : 0;

  const used = db.prepare(`
    SELECT COUNT(*) AS c FROM quiz_attempts
    WHERE quiz_id = ? AND student_id = ? AND status != 'in_progress'
  `).get(topic.quiz_id, req.me.id).c;

  const canRetry = !topic.readonly
    && (Number(topic.max_attempts) === 0 || used < Number(topic.max_attempts));

  return res.render('student/quiz/quiz-result', {
    title: 'Результат теста',
    me: req.me,
    topic,
    attempt: att,
    percent, review, canRetry,
    pageTop: { title: 'Результат теста' },
  });
}));

module.exports = router;