// database/quiz-constraints.js
'use strict';
const db = require('./index');

/* ═══════════════════════════════════════════════════════════
   Ограничения подсистемы тестирования на уровне БД.

   1) Одна незавершённая попытка на пару (тест, студент).
      Частичный UNIQUE-индекс. Транзакция в роуте защищает
      от двойного клика, индекс — от параллельных процессов.

   2) У темы не может быть одновременно assignment_id и quiz_id.
      SQLite не умеет ALTER TABLE ADD CHECK, поэтому два
      BEFORE-триггера (INSERT и UPDATE).

   3) Индекс topics(quiz_id) — поиск темы по тесту.

   Модуль идемпотентен: подключается из routes/index.js один раз
   при старте, повторный запуск ничего не ломает.
   ═══════════════════════════════════════════════════════════ */

function run(label, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`[quiz-constraints] ${label}:`, e.message);
  }
}

// ─── 1. Чистка дублей in_progress (могли появиться до индекса) ───
run('dedupe in_progress', () => {
  const dupes = db.prepare(`
    SELECT quiz_id, student_id, MAX(id) AS keep_id, COUNT(*) AS c
    FROM quiz_attempts
    WHERE status = 'in_progress'
    GROUP BY quiz_id, student_id
    HAVING c > 1
  `).all();

  if (dupes.length === 0) return;

  let removed = 0;
  const tx = db.transaction(() => {
    for (const d of dupes) {
      // У незавершённой попытки ответов нет по определению —
      // удаляем более старые пустые дубли, оставляем последнюю.
      const r = db.prepare(`
        DELETE FROM quiz_attempts
        WHERE quiz_id = ? AND student_id = ? AND status = 'in_progress' AND id <> ?
          AND NOT EXISTS (SELECT 1 FROM quiz_answers WHERE attempt_id = quiz_attempts.id)
      `).run(d.quiz_id, d.student_id, d.keep_id);
      removed += r.changes;
    }
  });
  tx();
  if (removed > 0) {
    console.log(`[quiz-constraints] удалено дублей незавершённых попыток: ${removed}`);
  }
});

run('index one_in_progress', () => {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_attempts_one_in_progress
    ON quiz_attempts(quiz_id, student_id)
    WHERE status = 'in_progress'
  `);
});

// ─── 2. Взаимоисключение assignment_id / quiz_id ───
run('trigger topics_exclusive_insert', () => {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_topics_quiz_assignment_ins
    BEFORE INSERT ON topics
    WHEN NEW.assignment_id IS NOT NULL AND NEW.quiz_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'topics: assignment_id и quiz_id не могут быть заданы одновременно');
    END
  `);
});

run('trigger topics_exclusive_update', () => {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_topics_quiz_assignment_upd
    BEFORE UPDATE OF assignment_id, quiz_id ON topics
    WHEN NEW.assignment_id IS NOT NULL AND NEW.quiz_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'topics: assignment_id и quiz_id не могут быть заданы одновременно');
    END
  `);
});

// ─── 3. Индекс для поиска темы по тесту ───
run('index topics_quiz', () => {
  db.exec('CREATE INDEX IF NOT EXISTS idx_topics_quiz ON topics(quiz_id)');
});

module.exports = {};