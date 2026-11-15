// utils/quiz-submit.js
'use strict';
const db = require('../database');
const { scoreQuestion } = require('./quiz');

/* ═══════════════════════════════════════════════════════════
   Серверный подсчёт попытки.

   Принимает JSON ответов, валидирует, считает баллы через
   scoreQuestion(), проверяет таймер, пишет quiz_answers и
   закрывает попытку (finished / expired).

   Формат answers_json:
     { "<questionId>": [<optionId>, ...], ... }
   Для single/multiple — массив выбранных (0 или 1 для single).
   Для ordering — перестановка ВСЕХ вариантов вопроса (порядок
   важен; клиент при инициализации заполняет стартовым порядком,
   поэтому сюда всегда приходит полный набор).
   ═══════════════════════════════════════════════════════════ */

function parseAnswersJson(raw) {
  try {
    const obj = JSON.parse(String(raw || '{}'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const qid = Number(k);
      if (!Number.isInteger(qid) || qid <= 0) return null;
      if (!Array.isArray(v)) return null;
      out[qid] = v.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    }
    return out;
  } catch {
    return null;
  }
}

function validateAnswers(questionsWithOptions, answers) {
  const errors = [];
  for (const q of questionsWithOptions) {
    const sel = Array.isArray(answers[q.id]) ? answers[q.id] : [];
    const optIds = new Set(q.options.map((o) => o.id));

    for (const id of sel) {
      if (!optIds.has(id)) {
        errors.push(`Вопрос ${q.id}: выбран несуществующий вариант`);
      }
    }

    if (q.type === 'single' && sel.length > 1) {
      errors.push(`Вопрос ${q.id}: для типа «один вариант» выберите ровно один`);
    }

    if (q.type === 'ordering') {
      const uniq = new Set(sel);
      if (sel.length !== q.options.length) {
        errors.push(`Вопрос ${q.id}: расставьте все элементы`);
      }
      if (uniq.size !== sel.length) {
        errors.push(`Вопрос ${q.id}: дубликаты в порядке`);
      }
      for (const id of optIds) {
        if (!uniq.has(id)) {
          errors.push(`Вопрос ${q.id}: пропущен элемент в порядке`);
          break;
        }
      }
    }
  }
  return errors;
}

function loadQuestionsWithOptions(quizId) {
  const questions = db.prepare(
    'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position ASC, id ASC'
  ).all(quizId);
  if (questions.length === 0) return [];

  const qIds = questions.map((q) => q.id);
  const ph = qIds.map(() => '?').join(',');
  const options = db.prepare(
    `SELECT * FROM quiz_options WHERE question_id IN (${ph}) ORDER BY position ASC, id ASC`
  ).all(...qIds);

  const byQ = new Map();
  for (const o of options) {
    if (!byQ.has(o.question_id)) byQ.set(o.question_id, []);
    byQ.get(o.question_id).push(o);
  }
  return questions.map((q) => ({ ...q, options: byQ.get(q.id) || [] }));
}

function submitAttempt({ attemptId, studentId, answersJson }) {
  const att = db.prepare(`
    SELECT qa.*, qz.pass_percent, qz.time_limit_minutes
    FROM quiz_attempts qa
    JOIN quizzes qz ON qz.id = qa.quiz_id
    WHERE qa.id = ? AND qa.student_id = ?
  `).get(attemptId, studentId);

  if (!att) return { ok: false, error: 'Попытка не найдена' };
  if (att.status !== 'in_progress') {
    return { ok: false, error: 'Попытка уже завершена' };
  }

  const answers = parseAnswersJson(answersJson);
  if (!answers) return { ok: false, error: 'Некорректный формат ответов' };

  const questionsWithOptions = loadQuestionsWithOptions(att.quiz_id);
  if (questionsWithOptions.length === 0) {
    return { ok: false, error: 'В тесте нет вопросов' };
  }

  const errors = validateAnswers(questionsWithOptions, answers);
  if (errors.length > 0) {
    return { ok: false, error: errors.join('; '), errors };
  }

  // Проверка таймера — через SQLite (started_at хранится в UTC,
  // datetime('now') тоже UTC; TZ не вмешивается).
  let status = 'finished';
  if (Number(att.time_limit_minutes) > 0) {
    const t = db.prepare(`
      SELECT (julianday('now') - julianday(started_at)) * 86400 AS elapsed_sec
      FROM quiz_attempts WHERE id = ?
    `).get(attemptId);
    const limitSec = Number(att.time_limit_minutes) * 60 + 30;
    if (t && t.elapsed_sec > limitSec) status = 'expired';
  }

  // Подсчёт
  let score = 0;
  let maxScore = 0;
  const rows = [];
  for (const q of questionsWithOptions) {
    const sel = answers[q.id] || [];
    const qScore = scoreQuestion(q, sel);
    const qPoints = Number(q.points) > 0 ? Number(q.points) : 1;
    score += qScore;
    maxScore += qPoints;
    rows.push({
      question_id: q.id,
      option_ids: JSON.stringify(sel),
      score: qScore,
    });
  }

  const percent = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const passed = percent >= Number(att.pass_percent) ? 1 : 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      db.prepare(`
        INSERT INTO quiz_answers (attempt_id, question_id, option_ids, score)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id) DO UPDATE SET
          option_ids = excluded.option_ids,
          score = excluded.score
      `).run(attemptId, row.question_id, row.option_ids, row.score);
    }
    db.prepare(`
      UPDATE quiz_attempts
      SET finished_at = CURRENT_TIMESTAMP,
          score = ?, max_score = ?, passed = ?, status = ?
      WHERE id = ?
    `).run(score, maxScore, passed, status, attemptId);
  });
  tx();

  return { ok: true, attemptId, status, score, maxScore, passed };
}

// ─── Автозакрытие просроченных незавершённых попыток ───
// Без этого «зависшая» in_progress-попытка блокирует студенту
// страницу теста (кнопка «Начать» не появляется), а в списке тем
// она показывается как «тест продолжается». Вызывается при открытии
// теста и при старте попытки. Баллы считаются по уже сделанным
// ответам (в этой реализации ответы пишутся только при отправке,
// поэтому просроченная попытка закрывается с нулевым результатом).
function expireOverdueAttempts(quizId, studentId) {
  const rows = db.prepare(`
    SELECT qa.id, qz.time_limit_minutes
    FROM quiz_attempts qa
    JOIN quizzes qz ON qz.id = qa.quiz_id
    WHERE qa.quiz_id = ? AND qa.student_id = ? AND qa.status = 'in_progress'
      AND qz.time_limit_minutes > 0
      AND (julianday('now') - julianday(qa.started_at)) * 86400
          > qz.time_limit_minutes * 60 + 30
  `).all(quizId, studentId);

  if (rows.length === 0) return 0;

  const maxScore = Number(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 1 END), 0) AS s
    FROM quiz_questions WHERE quiz_id = ?
  `).get(quizId).s) || null;

  const close = db.transaction(() => {
    for (const r of rows) {
      db.prepare(`
        UPDATE quiz_attempts
        SET finished_at = CURRENT_TIMESTAMP,
            score = 0, max_score = ?, passed = 0, status = 'expired'
        WHERE id = ? AND status = 'in_progress'
      `).run(maxScore, r.id);
    }
  });
  close();
  return rows.length;
}

module.exports = {
  parseAnswersJson,
  validateAnswers,
  submitAttempt,
  loadQuestionsWithOptions,
  expireOverdueAttempts,
};