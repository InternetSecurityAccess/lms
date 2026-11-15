// routes/student/content.js
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkStudent } = require('../shared/authz');
const { handler, renderWith } = require('../shared/handlers');
const {
  loadStudentRow,
  loadSubjectAsStudent,
  loadTopicAsStudent,
} = require('../shared/loaders');
const attachments = require('../../utils/attachments');

const TOPIC_TYPE_FILTERS = Object.freeze(['all', 'lectures', 'assignments', 'quizzes']);

function sqlUtcMs(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi);
}

/* ═══════════════════════════════════════════════════════════
   Статистика попыток студента по одному тесту.
   max_score у всех попыток теста одинаковый (вопросы冻结 после
   первой попытки), поэтому MAX(max_score) корректен.
   ═══════════════════════════════════════════════════════════ */
const QUIZ_STATS_SQL = `
  SELECT
    COUNT(CASE WHEN status <> 'in_progress' THEN 1 END) AS used,
    MAX(CASE WHEN status <> 'in_progress' THEN score END) AS best_score,
    MAX(max_score) AS max_score,
    (SELECT id FROM quiz_attempts
      WHERE quiz_id = @qid AND student_id = @sid AND status = 'in_progress'
      ORDER BY started_at DESC, id DESC LIMIT 1) AS in_progress_id
  FROM quiz_attempts
  WHERE quiz_id = @qid AND student_id = @sid
`;

function buildQuizState(stats, { maxAttempts, passPercent }, me) {
  const used = Number(stats?.used || 0);
  const total = Number(maxAttempts) || 0;
  const unlimited = total === 0;
  const attemptsLeft = unlimited ? Infinity : Math.max(0, total - used);

  const bestScore = stats && stats.best_score != null ? Number(stats.best_score) : null;
  const bestMax = stats && stats.max_score != null ? Number(stats.max_score) : null;
  const percent = (bestScore != null && bestMax > 0)
    ? Math.round((bestScore / bestMax) * 100)
    : null;
  const passed = percent != null ? percent >= Number(passPercent) : null;

  const active = me.status === 'active' && me.group_status === 'active';

  return {
    used,
    total,
    unlimited,
    attemptsLeft,
    bestScore,
    bestMax,
    percent,
    passed,
    inProgressId: stats?.in_progress_id || null,
    canStart: active && attemptsLeft > 0,
    readonly: !active,
  };
}

function quizStatsFor(quizId, studentId) {
  return db.prepare(QUIZ_STATS_SQL).get({ qid: quizId, sid: studentId });
}

/* ═══════════════ МОИ ПРЕДМЕТЫ ═══════════════ */

router.get(
  '/my-subjects',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const q = String(req.query.q || '').trim().slice(0, 100);

    let where = `
      WHERE sg.group_id = @groupId
        AND s.status = 'active'
        AND s.deleted_at IS NULL
        AND t.status = 'active'
        AND t.deleted_at IS NULL
    `;
    const params = { groupId: me.group_id };
    if (q) {
      where += ' AND (s.title LIKE @q OR s.description LIKE @q OR t.name LIKE @q)';
      params.q = `%${q}%`;
    }

    const subjects = db.prepare(`
      SELECT s.*, t.name AS teacher_name, t.id AS teacher_id,
        (SELECT COUNT(*) FROM topics tp
          WHERE tp.subject_id = s.id
            AND tp.status = 'published' AND tp.deleted_at IS NULL
            AND (tp.available_from IS NULL OR tp.available_from <= CURRENT_TIMESTAMP)
        ) AS topics_count
      FROM subjects s
      JOIN subject_groups sg ON sg.subject_id = s.id
      JOIN teachers t ON t.id = s.teacher_id
      ${where}
      ORDER BY t.name, s.title
    `).all(params);

    const grouped = [];
    const byTeacher = new Map();
    for (const s of subjects) {
      if (!byTeacher.has(s.teacher_id)) {
        byTeacher.set(s.teacher_id, {
          teacher_id: s.teacher_id,
          teacher_name: s.teacher_name,
          subjects: [],
        });
        grouped.push(byTeacher.get(s.teacher_id));
      }
      byTeacher.get(s.teacher_id).subjects.push(s);
    }

    const finishedCount = db.prepare(`
      SELECT COUNT(DISTINCT s.id) AS c
      FROM subjects s
      JOIN teachers t ON t.id = s.teacher_id
      WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM subject_groups sg
          WHERE sg.subject_id = s.id AND sg.group_id = @gid
        )
        AND (
          EXISTS (SELECT 1 FROM subject_groups_history
                  WHERE subject_id = s.id AND group_id = @gid)
          OR EXISTS (SELECT 1 FROM submissions s2
                     JOIN assignments a2 ON a2.id = s2.assignment_id
                     WHERE a2.subject_id = s.id
                       AND s2.student_id = @sid AND s2.deleted_at IS NULL)
        )
    `).get({ sid: me.id, gid: me.group_id }).c;

    return renderWith(res, 'student/content/my-subjects', {
      title: 'Мои предметы',
      me, groups: grouped, total: subjects.length, q, finishedCount,
    });
  })
);

/* ═══════════════ ВСЯ УЧЁБА ═══════════════ */

router.get(
  '/my-study',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const groupActive = me.group_status === 'active';

    let whereS = `
      WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM subject_groups sg
                  WHERE sg.subject_id = s.id AND sg.group_id = @gid)
          OR EXISTS (SELECT 1 FROM subject_groups_history
                     WHERE subject_id = s.id AND group_id = @gid)
          OR EXISTS (SELECT 1 FROM submissions s2
                     JOIN assignments a2 ON a2.id = s2.assignment_id
                     WHERE a2.subject_id = s.id
                       AND s2.student_id = @sid AND s2.deleted_at IS NULL)
        )
    `;
    const paramsS = { sid: me.id, gid: me.group_id, groupStatus: me.group_status };
    if (q) {
      whereS += ' AND (s.title LIKE @q OR s.description LIKE @q OR t.name LIKE @q)';
      paramsS.q = `%${q}%`;
    }

    const allSubjects = db.prepare(`
      SELECT s.*,
        t.name AS teacher_name, t.id AS teacher_id,
        t.status AS teacher_status,
        (SELECT COUNT(*) FROM topics tp
          WHERE tp.subject_id = s.id
            AND tp.status IN ('published','finished') AND tp.deleted_at IS NULL
            AND (
              (
                EXISTS (SELECT 1 FROM subject_groups sg
                        WHERE sg.subject_id = tp.subject_id AND sg.group_id = @gid)
                AND (tp.available_from IS NULL OR tp.available_from <= CURRENT_TIMESTAMP)
              )
              OR (
                NOT EXISTS (SELECT 1 FROM subject_groups sg
                            WHERE sg.subject_id = tp.subject_id AND sg.group_id = @gid)
                AND EXISTS (
                  SELECT 1 FROM subject_groups_history sgh
                  WHERE sgh.subject_id = tp.subject_id AND sgh.group_id = @gid
                    AND tp.created_at <= sgh.finished_at
                    AND (tp.available_from IS NULL OR tp.available_from <= sgh.finished_at)
                )
              )
            )
        ) AS topics_count,
        (SELECT COUNT(*) FROM submissions s2
          JOIN assignments a2 ON a2.id = s2.assignment_id
          WHERE a2.subject_id = s.id
            AND s2.student_id = @sid AND s2.deleted_at IS NULL) AS my_works_count,
        CASE
          WHEN s.status <> 'active' THEN 1
          WHEN t.status <> 'active' THEN 1
          WHEN @groupStatus <> 'active' THEN 1
          WHEN NOT EXISTS (SELECT 1 FROM subject_groups sg
                           WHERE sg.subject_id = s.id AND sg.group_id = @gid) THEN 1
          ELSE 0
        END AS is_readonly
      FROM subjects s
      JOIN teachers t ON t.id = s.teacher_id
      ${whereS}
      ORDER BY s.title
    `).all(paramsS);

    const activeSubjects = allSubjects.filter((s) => !s.is_readonly);
    const finishedSubjects = allSubjects.filter((s) => s.is_readonly);
    const total = activeSubjects.length + finishedSubjects.length;

    return renderWith(res, 'student/content/my-study', {
      title: 'Вся учёба',
      me, q,
      activeSubjects,
      finishedSubjects,
      totalActive: activeSubjects.length,
      totalFinishedSubjects: finishedSubjects.length,
      total,
      groupActive,
    });
  })
);

/* ═══════════════ СТРАНИЦА ПРЕДМЕТА (список тем) ═══════════════ */

router.get(
  '/t/:teacherId/subjects/:subjectId',
  checkStudent, loadStudentRow, loadSubjectAsStudent,
  handler((req, res) => {
    const topicsQ = String(req.query.topics_q || '').trim().slice(0, 100);
    const typeFilter = TOPIC_TYPE_FILTERS.includes(req.query.type) ? req.query.type : 'all';
    const isHistory = !!req.subject.isHistory;
    const finishedAt = req.subject.historyFinishedAt;

    const availSql = isHistory && finishedAt
      ? `AND created_at <= @finishedAt
         AND (available_from IS NULL OR available_from <= @finishedAt)`
      : `AND (available_from IS NULL OR available_from <= CURRENT_TIMESTAMP)`;
    const availParams = isHistory && finishedAt ? { finishedAt } : {};

    const countsRaw = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN assignment_id IS NULL AND quiz_id IS NULL THEN 1 ELSE 0 END) AS lectures,
        SUM(CASE WHEN assignment_id IS NOT NULL THEN 1 ELSE 0 END) AS assignments,
        SUM(CASE WHEN quiz_id IS NOT NULL THEN 1 ELSE 0 END) AS quizzes
      FROM topics
      WHERE subject_id = @sid AND status IN ('published','finished')
        AND deleted_at IS NULL
        ${availSql}
    `).get({ sid: req.subject.id, ...availParams });

    const topicCounts = {
      all: Number(countsRaw.total || 0),
      lectures: Number(countsRaw.lectures || 0),
      assignments: Number(countsRaw.assignments || 0),
      quizzes: Number(countsRaw.quizzes || 0),
    };

    let where = `
      WHERE t.subject_id = @sid
        AND t.status IN ('published','finished')
        AND t.deleted_at IS NULL
        ${availSql.replace(/\b(created_at|available_from)\b/g, 't.$1')}
    `;
    const params = { sid: req.subject.id, ...availParams };

    if (typeFilter === 'lectures') {
      where += ' AND t.assignment_id IS NULL AND t.quiz_id IS NULL';
    } else if (typeFilter === 'assignments') {
      where += ' AND t.assignment_id IS NOT NULL';
    } else if (typeFilter === 'quizzes') {
      where += ' AND t.quiz_id IS NOT NULL';
    }

    if (topicsQ) {
      where += ' AND (t.title LIKE @tq OR t.description LIKE @tq)';
      params.tq = `%${topicsQ}%`;
    }

    const topics = db.prepare(`
      SELECT t.*,
        a.title AS assignment_title, a.status AS assignment_status,
        qz.title AS quiz_title, qz.pass_percent AS quiz_pass_percent,
        qz.max_attempts AS quiz_max_attempts,
        qz.time_limit_minutes AS quiz_time_limit_minutes,
        (SELECT COUNT(*) FROM submissions s
          WHERE s.assignment_id = t.assignment_id AND s.student_id = @studentId
            AND s.deleted_at IS NULL) AS my_works_count,
        (SELECT s.status FROM submissions s
          WHERE s.assignment_id = t.assignment_id AND s.student_id = @studentId
            AND s.deleted_at IS NULL
          ORDER BY s.uploaded_at DESC LIMIT 1) AS my_last_status
      FROM topics t
      LEFT JOIN assignments a ON a.id = t.assignment_id
      LEFT JOIN quizzes qz ON qz.id = t.quiz_id
      ${where}
      ORDER BY t.position ASC, t.id ASC
    `).all({ ...params, studentId: req.session.studentId });

    for (const t of topics) {
      t.attachments = attachments.listAttachments('topic', t.id);
      if (t.quiz_id) {
        const stats = quizStatsFor(t.quiz_id, req.session.studentId);
        t.quiz = buildQuizState(stats, {
          maxAttempts: t.quiz_max_attempts,
          passPercent: t.quiz_pass_percent,
        }, req.me);
        // Тест завершённой темы / отвязанной группы — только просмотр.
        if (t.status !== 'published' || req.subject.readonly) {
          t.quiz.canStart = false;
          t.quiz.readonly = true;
        }
        t.quiz.url = `/my-subjects/${req.subject.id}/topics/${t.id}/quiz`;
      } else {
        t.quiz = null;
      }
    }

    return renderWith(res, 'student/content/subject', {
      title: req.subject.title,
      me: req.me,
      subject: req.subject,
      topics, topicCounts, typeFilter,
      totalAll: topicCounts.all, topicsQ,
    });
  })
);

/* ═══════════════ ОДНА ТЕМА ═══════════════ */

router.get(
  '/t/:teacherId/subjects/:subjectId/topics/:topicId',
  checkStudent, loadStudentRow, loadSubjectAsStudent, loadTopicAsStudent,
  handler((req, res) => {
    // Страховка: обычно тему-тест перехватывает routes/student/quiz.js.
    if (req.topic.quiz_id) {
      return res.redirect(
        `/my-subjects/${req.subject.id}/topics/${req.topic.id}/quiz`
      );
    }
    return renderWith(res, 'student/content/topic', {
      title: req.topic.title,
      me: req.me,
      subject: req.subject,
      topic: req.topic,
      assignment: req.assignment || null,
      works: req.topicWorks || [],
    });
  })
);

/* ═══════════════ МОИ ЗАДАНИЯ + ТЕСТЫ ═══════════════ */

router.get(
  '/my-assignments',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const teacherFilter = req.query.teacher ? Number(req.query.teacher) || null : null;
    const filter = ['all', 'todo', 'pending', 'accepted', 'rejected', 'overdue']
      .includes(req.query.filter) ? req.query.filter : 'all';
    const sort = ['deadline', 'teacher', 'subject', 'created'].includes(req.query.sort)
      ? req.query.sort : 'deadline';

    let where = `
      WHERE a.status = 'active'
        AND a.deleted_at IS NULL
        AND s.status = 'active'
        AND s.deleted_at IS NULL
        AND t.status = 'active'
        AND t.deleted_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM subject_groups sg
                  WHERE sg.subject_id = s.id AND sg.group_id = @groupId)
          OR EXISTS (SELECT 1 FROM submissions sub0
                     WHERE sub0.assignment_id = a.id AND sub0.student_id = @studentId
                       AND sub0.deleted_at IS NULL)
        )
        AND (
          NOT EXISTS (SELECT 1 FROM topics tp
                      WHERE tp.assignment_id = a.id AND tp.deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM topics tp
                     WHERE tp.assignment_id = a.id AND tp.deleted_at IS NULL
                       AND (tp.available_from IS NULL OR tp.available_from <= CURRENT_TIMESTAMP))
        )
    `;
    const params = { groupId: me.group_id, studentId: me.id };
    if (teacherFilter) { where += ' AND t.id = @teacherId'; params.teacherId = teacherFilter; }
    if (q) {
      where += ' AND (a.title LIKE @q OR s.title LIKE @q OR t.name LIKE @q)';
      params.q = `%${q}%`;
    }

    const assignments = db.prepare(`
      SELECT a.*,
        s.title AS subject_title, s.id AS subject_id,
        t.id AS teacher_id, t.name AS teacher_name,
        (SELECT COUNT(*) FROM submissions sub
          WHERE sub.assignment_id = a.id AND sub.student_id = @studentId
            AND sub.deleted_at IS NULL) AS works_count,
        (SELECT sub.status FROM submissions sub
          WHERE sub.assignment_id = a.id AND sub.student_id = @studentId
            AND sub.deleted_at IS NULL
          ORDER BY sub.uploaded_at DESC LIMIT 1) AS last_status
      FROM assignments a
      JOIN subjects s ON s.id = a.subject_id
      JOIN teachers t ON t.id = s.teacher_id
      ${where}
      ORDER BY a.deadline IS NULL, a.deadline ASC, a.created_at DESC
    `).all(params);

    const now = Date.now();
    for (const a of assignments) {
      let computed;
      if (a.last_status === 'accepted') computed = 'accepted';
      else if (a.last_status === 'rejected') computed = 'rejected';
      else if (a.last_status === 'pending') computed = 'pending';
      else if (a.deadline) {
        const dl = sqlUtcMs(a.deadline);
        computed = (dl != null && dl < now) ? 'overdue' : 'todo';
      } else computed = 'todo';
      a.computed_status = computed;
    }

    const filtered = filter === 'all'
      ? assignments
      : assignments.filter((a) => a.computed_status === filter);

    const sorted = [...filtered];
    if (sort === 'deadline') {
      sorted.sort((a, b) => {
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline.localeCompare(b.deadline);
      });
    } else if (sort === 'teacher') {
      sorted.sort((a, b) => a.teacher_name.localeCompare(b.teacher_name));
    } else if (sort === 'subject') {
      sorted.sort((a, b) => a.subject_title.localeCompare(b.subject_title));
    } else if (sort === 'created') {
      sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    const counts = {
      all: assignments.length,
      todo: assignments.filter((a) => a.computed_status === 'todo').length,
      pending: assignments.filter((a) => a.computed_status === 'pending').length,
      accepted: assignments.filter((a) => a.computed_status === 'accepted').length,
      rejected: assignments.filter((a) => a.computed_status === 'rejected').length,
      overdue: assignments.filter((a) => a.computed_status === 'overdue').length,
    };

    /* ── Блок «Тесты» ──
       Только активные пары и опубликованные темы. Чипы фильтрации
       относятся к заданиям, поэтому при выбранном фильтре блок скрыт.
       Readonly-история тестов — через «Всю учёбу» → предмет → тема. */
    let quizzes = [];
    if (filter === 'all') {
      const qp = [me.group_id];
      let qw = `
        WHERE t.quiz_id IS NOT NULL
          AND t.deleted_at IS NULL
          AND t.status = 'published'
          AND s.status = 'active' AND s.deleted_at IS NULL
          AND te.status = 'active' AND te.deleted_at IS NULL
          AND sg.group_id = ?
          AND (t.available_from IS NULL OR t.available_from <= CURRENT_TIMESTAMP)
      `;
      if (teacherFilter) { qw += ' AND te.id = ?'; qp.push(teacherFilter); }
      if (q) {
        qw += ' AND (qz.title LIKE ? OR t.title LIKE ? OR s.title LIKE ? OR te.name LIKE ?)';
        const like = `%${q}%`;
        qp.push(like, like, like, like);
      }

      quizzes = db.prepare(`
        SELECT
          t.id AS topic_id, t.title AS topic_title,
          s.id AS subject_id, s.title AS subject_title,
          te.id AS teacher_id, te.name AS teacher_name,
          qz.id AS quiz_id, qz.title AS quiz_title,
          qz.pass_percent, qz.max_attempts, qz.time_limit_minutes
        FROM topics t
        JOIN subjects s       ON s.id = t.subject_id
        JOIN teachers te      ON te.id = s.teacher_id
        JOIN quizzes qz       ON qz.id = t.quiz_id
        JOIN subject_groups sg ON sg.subject_id = s.id
        ${qw}
        ORDER BY s.title, t.position, t.id
      `).all(...qp);

      for (const item of quizzes) {
        const stats = quizStatsFor(item.quiz_id, me.id);
        item.state = buildQuizState(stats, {
          maxAttempts: item.max_attempts,
          passPercent: item.pass_percent,
        }, me);
        item.url = `/my-subjects/${item.subject_id}/topics/${item.topic_id}/quiz`;
      }
    }

    const teacher = teacherFilter
      ? db.prepare('SELECT id, name FROM teachers WHERE id = ? AND deleted_at IS NULL')
        .get(teacherFilter)
      : null;

    return renderWith(res, 'student/content/my-assignments', {
      title: 'Мои задания',
      me, assignments: sorted, counts, q, filter, sort,
      teacherFilter, teacher,
      quizzes,
    });
  })
);

module.exports = router;