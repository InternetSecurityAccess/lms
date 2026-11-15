// utils/quiz-repo.js
'use strict';
const db = require('../database');
const { validateQuizPayload } = require('./quiz');
const {
  collectStoredNamesFromPayload,
  cleanupRemovedQuizImages,
  deleteQuizImage,
} = require('./quiz-storage');

/* ═══════════════════════════════════════════════════════════
   Слой БД подсистемы тестирования.

   Правила:
   • после первой попытки вопросы/варианты/картинки не меняются —
     обновляются только настройки теста;
   • валидация зависит от статуса темы: draft — мягкая,
     published — с проверкой правильных ответов;
   • у темы не может быть одновременно assignment_id и quiz_id;
   • смена типа темы при наличии попыток запрещена.
   ═══════════════════════════════════════════════════════════ */

// ─── Картинки теста, лежащие в БД ───
function collectStoredNamesFromDb(quizId) {
  const set = new Set();
  const qRows = db.prepare(
    'SELECT image_stored_name FROM quiz_questions WHERE quiz_id = ?'
  ).all(quizId);
  for (const r of qRows) if (r.image_stored_name) set.add(r.image_stored_name);

  const oRows = db.prepare(`
    SELECT qo.image_stored_name
    FROM quiz_options qo
    JOIN quiz_questions qq ON qq.id = qo.question_id
    WHERE qq.quiz_id = ?
  `).all(quizId);
  for (const r of oRows) if (r.image_stored_name) set.add(r.image_stored_name);

  return set;
}

function countAttempts(quizId) {
  if (!quizId) return 0;
  return db.prepare(
    'SELECT COUNT(*) AS c FROM quiz_attempts WHERE quiz_id = ?'
  ).get(quizId).c;
}

// ─── Вопросы теста в формате payload конструктора ───
function questionsPayloadFromDb(quizId) {
  const questions = db.prepare(
    'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position ASC, id ASC'
  ).all(quizId);
  if (questions.length === 0) return [];

  const ids = questions.map((q) => q.id);
  const ph = ids.map(() => '?').join(',');
  const options = db.prepare(
    `SELECT * FROM quiz_options WHERE question_id IN (${ph}) ORDER BY position ASC, id ASC`
  ).all(...ids);

  const byQ = new Map();
  for (const o of options) {
    if (!byQ.has(o.question_id)) byQ.set(o.question_id, []);
    byQ.get(o.question_id).push({
      id: o.id,
      text: o.text,
      is_correct: !!o.is_correct,
      position: o.position,
      image_stored_name: o.image_stored_name,
      image_filename: o.image_filename,
      image_filesize: o.image_filesize,
    });
  }

  return questions.map((q) => ({
    id: q.id,
    text: q.text,
    type: q.type,
    points: q.points,
    position: q.position,
    image_stored_name: q.image_stored_name,
    image_filename: q.image_filename,
    image_filesize: q.image_filesize,
    options: byQ.get(q.id) || [],
  }));
}

function buildPayloadFromDb(quizId) {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
  if (!quiz) return null;
  return {
    title: quiz.title,
    description: quiz.description,
    pass_percent: quiz.pass_percent,
    max_attempts: quiz.max_attempts,
    time_limit_minutes: quiz.time_limit_minutes,
    show_correct: !!quiz.show_correct,
    questions: questionsPayloadFromDb(quizId),
  };
}

// ─── Данные для конструктора ───
function getQuizForEditor(topicId) {
  const topic = db.prepare('SELECT id, quiz_id FROM topics WHERE id = ?').get(topicId);
  if (!topic || !topic.quiz_id) return null;
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(topic.quiz_id);
  if (!quiz) return null;

  return {
    quiz: { ...quiz, show_correct: !!quiz.show_correct, questions: questionsPayloadFromDb(quiz.id) },
    attemptsCount: countAttempts(quiz.id),
  };
}

// ─── Сохранение теста ───
// forPublish = true → строгая валидация (правильные ответы отмечены).
function saveQuizForTopic({ topicId, teacherId, payload, forPublish = false }) {
  const topic = db.prepare(`
    SELECT t.id, t.subject_id, t.quiz_id, s.teacher_id
    FROM topics t
    JOIN subjects s ON s.id = t.subject_id
    WHERE t.id = ? AND t.deleted_at IS NULL
  `).get(topicId);

  if (!topic) return { ok: false, error: 'Тема не найдена', errors: ['Тема не найдена'] };
  if (Number(topic.teacher_id) !== Number(teacherId)) {
    return { ok: false, error: 'Нет доступа', errors: ['Нет доступа'] };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Некорректные данные теста', errors: ['Некорректные данные теста'] };
  }

  const existingQuizId = topic.quiz_id || null;
  const hasAttempts = existingQuizId ? countAttempts(existingQuizId) > 0 : false;

  // После первой попытки структура берётся из БД — клиент её прислать не может.
  const effective = hasAttempts
    ? { ...payload, questions: questionsPayloadFromDb(existingQuizId) }
    : payload;

  const validation = validateQuizPayload(effective, { forPublish });
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.errors.join('; '),
      errors: validation.errors,
    };
  }

  const settings = {
    title: String(payload.title || '').trim(),
    description: payload.description ? String(payload.description).slice(0, 5000) : null,
    pass_percent: Math.min(100, Math.max(0, Math.round(Number(payload.pass_percent) || 0))),
    max_attempts: Number.isInteger(Number(payload.max_attempts)) && Number(payload.max_attempts) >= 0
      ? Number(payload.max_attempts)
      : 1,
    time_limit_minutes: payload.time_limit_minutes
      ? Math.max(1, Math.round(Number(payload.time_limit_minutes)))
      : null,
    show_correct: payload.show_correct ? 1 : 0,
  };

  const oldStoredNames = existingQuizId ? collectStoredNamesFromDb(existingQuizId) : new Set();

  const tx = db.transaction(() => {
    let quizId = existingQuizId;

    if (!quizId) {
      const r = db.prepare(`
        INSERT INTO quizzes
          (title, description, pass_percent, max_attempts, time_limit_minutes, show_correct)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        settings.title, settings.description, settings.pass_percent,
        settings.max_attempts, settings.time_limit_minutes, settings.show_correct
      );
      quizId = Number(r.lastInsertRowid);
    } else {
      db.prepare(`
        UPDATE quizzes SET
          title = ?, description = ?, pass_percent = ?, max_attempts = ?,
          time_limit_minutes = ?, show_correct = ?
        WHERE id = ?
      `).run(
        settings.title, settings.description, settings.pass_percent,
        settings.max_attempts, settings.time_limit_minutes, settings.show_correct,
        quizId
      );
    }

    if (!hasAttempts) {
      db.prepare('DELETE FROM quiz_questions WHERE quiz_id = ?').run(quizId);

      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      questions.forEach((q, qi) => {
        const qr = db.prepare(`
          INSERT INTO quiz_questions
            (quiz_id, text, type, points, position,
             image_stored_name, image_filename, image_filesize)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          quizId,
          String(q.text || '').trim(),
          q.type,
          Number(q.points) > 0 ? Math.round(Number(q.points)) : 1,
          qi,
          q.image_stored_name || null,
          q.image_filename || null,
          q.image_filesize || null
        );
        const questionId = Number(qr.lastInsertRowid);

        const options = Array.isArray(q.options) ? q.options : [];
        options.forEach((o, oi) => {
          db.prepare(`
            INSERT INTO quiz_options
              (question_id, text, is_correct, position,
               image_stored_name, image_filename, image_filesize)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            questionId,
            String(o.text || '').trim(),
            o.is_correct ? 1 : 0,
            oi,
            o.image_stored_name || null,
            o.image_filename || null,
            o.image_filesize || null
          );
        });
      });
    }

    // Одновременно assignment_id и quiz_id быть не могут.
    db.prepare('UPDATE topics SET quiz_id = ?, assignment_id = NULL WHERE id = ?')
      .run(quizId, topicId);

    return quizId;
  });

  const quizId = tx();

  if (!hasAttempts) {
    const newStoredNames = collectStoredNamesFromPayload(payload);
    cleanupRemovedQuizImages(oldStoredNames, newStoredNames);
  }

  return { ok: true, quizId, hasAttempts, locked: hasAttempts };
}

// ─── Полное удаление теста (каскад + файлы) ───
function deleteQuizWithFiles(quizId) {
  if (!quizId) return false;
  const names = collectStoredNamesFromDb(quizId);
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId);
  for (const n of names) deleteQuizImage(n);
  return true;
}

// ─── Смена типа темы с теста на другой ───
function detachQuizFromTopic(topicId) {
  const row = db.prepare('SELECT quiz_id FROM topics WHERE id = ?').get(topicId);
  if (!row || !row.quiz_id) return { ok: true, detached: false };

  if (countAttempts(row.quiz_id) > 0) {
    return {
      ok: false,
      error: 'Нельзя изменить тип темы: у теста уже есть попытки студентов',
      errors: ['Нельзя изменить тип темы: у теста уже есть попытки студентов'],
    };
  }

  const quizId = row.quiz_id;
  db.prepare('UPDATE topics SET quiz_id = NULL WHERE id = ?').run(topicId);
  deleteQuizWithFiles(quizId);
  return { ok: true, detached: true };
}

function applyQuizModeOnTopicSave({ topicId, teacherId, mode, quizJson, forPublish = false }) {
  if (mode === 'quiz') {
    let payload;
    try { payload = JSON.parse(quizJson || '{}'); }
    catch { return { ok: false, error: 'Некорректный JSON теста', errors: ['Некорректный JSON теста'] }; }
    return saveQuizForTopic({ topicId, teacherId, payload, forPublish });
  }
  return detachQuizFromTopic(topicId);
}

// ─── Результаты для преподавателя ───
function getAttemptsForQuiz(quizId, teacherId) {
  const owner = db.prepare(`
    SELECT s.teacher_id
    FROM topics t JOIN subjects s ON s.id = t.subject_id
    WHERE t.quiz_id = ? LIMIT 1
  `).get(quizId);
  if (!owner || Number(owner.teacher_id) !== Number(teacherId)) return null;

  const attempts = db.prepare(`
    SELECT qa.*,
           st.id AS sid, st.last_name, st.first_name, st.middle_name,
           g.name AS group_name
    FROM quiz_attempts qa
    JOIN students st ON st.id = qa.student_id
    JOIN groups g    ON g.id = st.group_id
    WHERE qa.quiz_id = ?
    ORDER BY qa.started_at DESC, qa.id DESC
  `).all(quizId);

  const byStudent = new Map();
  for (const a of attempts) {
    if (!byStudent.has(a.sid)) {
      byStudent.set(a.sid, {
        student: {
          id: a.sid,
          last_name: a.last_name,
          first_name: a.first_name,
          middle_name: a.middle_name,
          group_name: a.group_name,
        },
        attempts: [],
        best: null,
      });
    }
    const entry = byStudent.get(a.sid);
    a.percent = a.max_score > 0 ? Math.round((a.score / a.max_score) * 100) : 0;
    entry.attempts.push(a);
    if (a.status !== 'in_progress') {
      if (!entry.best || (a.score || 0) > (entry.best.score || 0)) entry.best = a;
    }
  }

  return Array.from(byStudent.values());
}

// ─── Разбор одной попытки ───
// Возвращает вопросы в порядке снимка попытки, варианты — в порядке
// снимка option_orders. Поля topic_id и got_score нужны шаблонам.
function getAttemptForReview(attemptId, teacherId) {
  const att = db.prepare(`
    SELECT qa.*,
           qz.title AS quiz_title, qz.show_correct, qz.pass_percent,
           st.last_name, st.first_name, st.middle_name, st.id AS sid,
           g.name AS group_name,
           t.id AS topic_id, t.title AS topic_title,
           s.id AS subject_id, s.title AS subject_title, s.teacher_id
    FROM quiz_attempts qa
    JOIN quizzes qz  ON qz.id = qa.quiz_id
    JOIN students st ON st.id = qa.student_id
    JOIN groups g    ON g.id = st.group_id
    JOIN topics t    ON t.quiz_id = qz.id AND t.deleted_at IS NULL
    JOIN subjects s  ON s.id = t.subject_id
    WHERE qa.id = ?
    LIMIT 1
  `).get(attemptId);

  if (!att || Number(att.teacher_id) !== Number(teacherId)) return null;

  const answers = db.prepare('SELECT * FROM quiz_answers WHERE attempt_id = ?').all(attemptId);
  const answersByQ = new Map(answers.map((a) => [a.question_id, a]));

  let questions = questionsPayloadFromDb(att.quiz_id).map((q) => {
    const ans = answersByQ.get(q.id);
    let selected = [];
    if (ans && ans.option_ids) {
      try {
        const parsed = JSON.parse(ans.option_ids);
        if (Array.isArray(parsed)) selected = parsed;
      } catch { /* ignore */ }
    }
    const got = ans ? ans.score : 0;
    return { ...q, selected_ids: selected, got_score: got, score: got };
  });

  // Порядок вопросов — как видел студент.
  let order = [];
  try {
    const parsed = JSON.parse(att.question_order || '[]');
    if (Array.isArray(parsed)) order = parsed;
  } catch { /* ignore */ }
  if (order.length > 0) {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const ordered = [];
    for (const id of order) {
      if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); }
    }
    for (const q of byId.values()) ordered.push(q);
    questions = ordered;
  }

  // Порядок вариантов — как видел студент.
  let optionOrders = {};
  try {
    const parsed = JSON.parse(att.option_orders || '{}');
    if (parsed && typeof parsed === 'object') optionOrders = parsed;
  } catch { /* ignore */ }

  for (const q of questions) {
    const snap = optionOrders[q.id];
    if (!Array.isArray(snap) || snap.length !== q.options.length) continue;
    const byId = new Map(q.options.map((o) => [o.id, o]));
    const ordered = [];
    for (const oid of snap) if (byId.has(oid)) ordered.push(byId.get(oid));
    if (ordered.length === q.options.length) q.options = ordered;
  }

  att.percent = att.max_score > 0 ? Math.round((att.score / att.max_score) * 100) : 0;

  return { attempt: att, questions };
}

module.exports = {
  getQuizForEditor,
  saveQuizForTopic,
  detachQuizFromTopic,
  applyQuizModeOnTopicSave,
  getAttemptsForQuiz,
  getAttemptForReview,
  collectStoredNamesFromDb,
  questionsPayloadFromDb,
  buildPayloadFromDb,
  countAttempts,
  deleteQuizWithFiles,
};