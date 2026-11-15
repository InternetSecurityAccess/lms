// routes/student/works/helpers.js
'use strict';

const db = require('../../../database');

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [v];
}
function markStatusRead(submissionId, studentId, status) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO submission_status_reads
        (submission_id, reader_type, reader_id, read_status)
      VALUES (?, 'student', ?, ?)
    `).run(submissionId, studentId, status);
  } catch (e) {
    console.error('[markStatusRead:student]', e.message);
  }
}

function rejectReadonlySubmission(req, res, next) {
  if (!req.submission || !req.submission.readonly) return next();
  if (!req.submission.assignment_id) {
    return res.status(404).render('common/error', {
      title: 'Работа недоступна',
      message: 'Работа в архиве, задание не найдено.',
    });
  }
  return res.redirect(
    `/t/${req.submission.teacher_id}/assignments/${req.submission.assignment_id}/archive`
  );
}

// ─── Уведомления по тестам (quiz_attempts) ───
function ensureQuizAttemptReadsTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quiz_attempt_reads (
        attempt_id   INTEGER NOT NULL,
        reader_type  TEXT    NOT NULL DEFAULT 'student',
        reader_id    INTEGER NOT NULL,
        read_passed  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (attempt_id, reader_type, reader_id, read_passed)
      )
    `);
  } catch (e) {
    console.error('[ensureQuizAttemptReadsTable]', e.message);
  }
}

function markQuizAttemptRead(attemptId, studentId, passed) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO quiz_attempt_reads
        (attempt_id, reader_type, reader_id, read_passed)
      VALUES (?, 'student', ?, ?)
    `).run(attemptId, studentId, passed ? 1 : 0);
  } catch (e) {
    console.error('[markQuizAttemptRead]', e.message);
  }
}

// Список завершённых попыток студента с флагом «непрочитанная».
// Если к тесту привязано несколько тем/преподавателей — берётся первая тема
// (для ссылки на результат) и DISTINCT по преподавателям исключает дубли.
function getStudentQuizNotifications(studentId) {
  ensureQuizAttemptReadsTable();
  return db.prepare(`
    SELECT qa.id AS attempt_id, qa.quiz_id, qa.student_id,
           qa.score, qa.max_score, qa.passed, qa.finished_at,
           q.title AS quiz_title,
           t.id AS topic_id, t.subject_id,
           sj.title AS subject_title,
           te.id AS teacher_id, te.name AS teacher_name,
           g.name AS group_name,
           (NOT EXISTS (
             SELECT 1 FROM quiz_attempt_reads r
             WHERE r.attempt_id = qa.id
               AND r.reader_type = 'student' AND r.reader_id = ?
               AND r.read_passed = qa.passed
           )) AS unread
    FROM quiz_attempts qa
    JOIN quizzes q ON q.id = qa.quiz_id
    JOIN students st ON st.id = qa.student_id
    LEFT JOIN groups g ON g.id = st.group_id AND g.deleted_at IS NULL
    JOIN teacher_groups tg ON tg.group_id = st.group_id
    JOIN teachers te ON te.id = tg.teacher_id
      AND te.status = 'active' AND te.deleted_at IS NULL
    JOIN topics t ON t.id = (
      SELECT tt.id FROM topics tt
      WHERE tt.quiz_id = qa.quiz_id AND tt.deleted_at IS NULL
      ORDER BY tt.position, tt.id LIMIT 1
    )
    JOIN subjects sj ON sj.id = t.subject_id
      AND sj.status = 'active' AND sj.deleted_at IS NULL
    WHERE qa.student_id = ?
      AND qa.status != 'in_progress'
      AND qa.finished_at IS NOT NULL
    GROUP BY qa.id
    ORDER BY qa.finished_at DESC
  `).all(studentId, studentId, studentId)
    .map((r) => ({ ...r, unread: !!r.unread }));
}

const STUDENT_UNREAD_SQL = `
  (
    EXISTS (SELECT 1 FROM messages m
      WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
        AND m.is_read = 0 AND m.deleted_at IS NULL)
    OR (
      s.status IN ('accepted','rejected')
      AND NOT EXISTS (
        SELECT 1 FROM submission_status_reads r
        WHERE r.submission_id = s.id
          AND r.reader_type = 'student' AND r.reader_id = @studentId
          AND r.read_status = s.status
      )
    )
    OR (s.ai_flag = 1 AND s.ai_flag_read_by_student = 0)
  )
`;

module.exports = {
  toArray,
  markStatusRead,
  rejectReadonlySubmission,
  STUDENT_UNREAD_SQL,
  ensureQuizAttemptReadsTable,
  markQuizAttemptRead,
  getStudentQuizNotifications,
};
