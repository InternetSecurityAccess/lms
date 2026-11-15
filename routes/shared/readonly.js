'use strict';
const db = require('../../database');

/* ═══════════════════════════════════════════════════════════
   isSubmissionReadonly — можно ли студенту писать в чат по
   сдаче и прикладывать файлы.
   Readonly = любой из родителей неактивен ИЛИ нет активной
   связи «предмет ↔ группа»:
     • группа, предмет, преподаватель, задание в finished / корзине;
     • subject_groups_history есть, но subject_groups нет
       (группа закрыта для этого предмета — readonly-снимок);
     • нет ни пары, ни истории — legacy-случай (работы остались,
       но группа отвязана до введения history).
   Не путать с submission.status='accepted' — там своя логика.
   ═══════════════════════════════════════════════════════════ */
function isSubmissionReadonly(submissionId) {
  const row = db.prepare(`
    SELECT a.status   AS a_status,  a.deleted_at AS a_deleted,
           a.subject_id AS subject_id,
           sj.status  AS sj_status, sj.deleted_at AS sj_deleted,
           t.status   AS t_status,  t.deleted_at  AS t_deleted,
           g.status   AS g_status,  g.deleted_at  AS g_deleted,
           s.group_id AS group_id
    FROM submissions s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN subjects sj ON sj.id = a.subject_id
    JOIN teachers t ON t.id = s.teacher_id
    JOIN groups g ON g.id = s.group_id
    WHERE s.id = ?
  `).get(Number(submissionId));
  if (!row) return true;

  // Если связь «предмет ↔ группа» неактивна (в истории или вообще нет) — readonly.
  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(row.subject_id, row.group_id);
  if (!activePair) return true;

  return row.a_status !== 'active' || !!row.a_deleted
      || row.sj_status !== 'active' || !!row.sj_deleted
      || row.t_status  !== 'active' || !!row.t_deleted
      || row.g_status  !== 'active' || !!row.g_deleted;
}

module.exports = { isSubmissionReadonly };