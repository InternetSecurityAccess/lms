// utils/quiz-view.js
'use strict';

/* ═══════════════════════════════════════════════════════════
   Подготовка данных теста для шаблонов.

   Здесь только чистые функции без БД и express:
     • safeJsonArray / safeJsonObject — безопасный разбор снимков;
     • applyOptionSnapshot            — порядок вариантов как видел студент;
     • buildResultLocals              — локалы страницы результата
       (единый контракт с views/student/quiz/quiz-result.ejs).
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

// Порядок вариантов — как в снимке попытки. Если снимок не бьётся
// с набором вариантов — оставляем исходный порядок.
function applyOptionSnapshot(options, snapshotIds) {
  const all = Array.isArray(options) ? options : [];
  const snap = Array.isArray(snapshotIds) ? snapshotIds : null;
  if (!snap || snap.length !== all.length) return all;
  const idx = new Map(all.map((o) => [o.id, o]));
  const ordered = [];
  for (const oid of snap) if (idx.has(oid)) ordered.push(idx.get(oid));
  return ordered.length === all.length ? ordered : all;
}

// ─── Локалы страницы результата ───
// attempt — строка quiz_attempts; questions — массив из buildAttemptView
// ({ ...вопрос, options, selected_ids, got_score }).
// Возвращает объект для res.render('student/quiz/quiz-result', …):
//   scorePercent, verdict, results[{ question_id, score, answer:
//   { option_id | option_ids|order } }], questionList (с q_text), quiz.
function buildResultLocals({ attempt, questions, percent, canRetry }) {
  const list = Array.isArray(questions) ? questions : [];

  const results = list.map((q) => {
    const sel = Array.isArray(q.selected_ids) ? q.selected_ids : [];
    const answer = q.type === 'single'
      ? { option_id: sel[0] != null ? String(sel[0]) : '' }
      : q.type === 'multiple'
        ? { option_ids: sel.map(String).join(',') }
        : { order: sel.map(String).join(',') };
    return { question_id: q.id, score: Number(q.got_score) || 0, answer };
  });

  const questionList = list.map((q) => ({
    ...q,
    q_text: q.text || '',
    // позиции выбранных вариантов — для отображения порядка в ordering
    selected_positions: (Array.isArray(q.selected_ids) ? q.selected_ids : [])
      .map((id) => String(id)),
  }));

  const passed = !!attempt.passed;

  return {
    attempt,
    percent,
    scorePercent: percent,
    verdict: passed ? 'Сдал' : 'Не сдал',
    canRetry,
    quiz: {
      show_correct: !!attempt.show_correct,
      pass_percent: attempt.pass_percent,
    },
    results,
    questionList,
  };
}

module.exports = {
  safeJsonArray,
  safeJsonObject,
  applyOptionSnapshot,
  buildResultLocals,
};
