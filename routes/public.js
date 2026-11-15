'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database');
const settings = require('../config/settings');
const { handler } = require('./shared/handlers');
const { currentRole } = require('./shared/authz');
const { rateLimitAction } = require('../middleware/rateLimit');

router.get('/', (req, res) => {
  if (req.session?.adminId) return res.redirect('/admin');
  if (req.session?.teacherId) return res.redirect('/my-groups');
  if (req.session?.studentId) return res.redirect('/my-teachers');
  return res.redirect('/login');
});

router.get('/help', (req, res) => {
  const role = currentRole(req);
  return res.render('common/help', { title: 'Помощь', role });
});

router.get('/search', handler((req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const role = currentRole(req);
  const result = { subjects: [], topics: [], assignments: [], works: [], announcements: [] };
  if (q && role !== 'guest') {
    const like = `%${q}%`;
    if (role === 'student') {
      const me = db.prepare('SELECT group_id, status FROM students WHERE id = ?')
        .get(req.session.studentId);
      // rejected/deleted — loadCurrentUser уже отсекает, но страхуемся.
      if (me && me.status !== 'rejected') {
        result.subjects = db.prepare(`
          SELECT s.id, s.title, s.description, t.id AS teacher_id, t.name AS teacher_name
          FROM subjects s
          JOIN teachers t ON t.id = s.teacher_id
          JOIN subject_groups sg ON sg.subject_id = s.id AND sg.group_id = ?
          WHERE s.status = 'active' AND s.deleted_at IS NULL
            AND t.status = 'active' AND t.deleted_at IS NULL
            AND (s.title LIKE ? OR s.description LIKE ?)
          LIMIT 20
        `).all(me.group_id, like, like);
        result.topics = db.prepare(`
          SELECT tp.id, tp.title, tp.subject_id, s.title AS subject_title, s.teacher_id
          FROM topics tp
          JOIN subjects s ON s.id = tp.subject_id
          JOIN subject_groups sg ON sg.subject_id = s.id AND sg.group_id = ?
          WHERE tp.status IN ('published','finished') AND tp.deleted_at IS NULL
            AND s.status = 'active' AND s.deleted_at IS NULL
            AND (tp.title LIKE ? OR tp.description LIKE ?)
          LIMIT 20
        `).all(me.group_id, like, like);
        result.assignments = db.prepare(`
          SELECT a.id, a.title, a.description, a.teacher_id, a.subject_id, s.title AS subject_title
          FROM assignments a
          JOIN subjects s ON s.id = a.subject_id
          JOIN subject_groups sg ON sg.subject_id = s.id AND sg.group_id = ?
          WHERE a.status IN ('active','finished') AND a.deleted_at IS NULL
            AND s.deleted_at IS NULL
            AND (a.title LIKE ? OR a.description LIKE ?)
          LIMIT 20
        `).all(me.group_id, like, like);
        result.works = db.prepare(`
          SELECT s.id, s.topic, s.status, s.uploaded_at,
                 s.teacher_id, t.name AS teacher_name
          FROM submissions s
          JOIN teachers t ON t.id = s.teacher_id
          JOIN assignments a ON a.id = s.assignment_id
          JOIN subjects sj ON sj.id = a.subject_id
          WHERE s.student_id = ? AND s.deleted_at IS NULL
            AND sj.deleted_at IS NULL
            AND s.topic LIKE ?
          ORDER BY s.uploaded_at DESC LIMIT 20
        `).all(req.session.studentId, like);
        result.announcements = db.prepare(`
          SELECT a.id, a.title, a.content, a.created_at, t.name AS teacher_name
          FROM group_announcements a
          JOIN teachers t ON t.id = a.teacher_id
          WHERE a.group_id = ? AND a.deleted_at IS NULL
            AND (a.title LIKE ? OR a.content LIKE ?)
          ORDER BY a.created_at DESC LIMIT 20
        `).all(me.group_id, like, like);
      }
    } else if (role === 'teacher') {
      const tid = req.session.teacherId;
      result.subjects = db.prepare(`
        SELECT id, title, description FROM subjects
        WHERE teacher_id = ? AND status = 'active' AND deleted_at IS NULL
          AND (title LIKE ? OR description LIKE ?)
        LIMIT 20
      `).all(tid, like, like);
      result.topics = db.prepare(`
        SELECT tp.id, tp.title, tp.subject_id, s.title AS subject_title
        FROM topics tp JOIN subjects s ON s.id = tp.subject_id
        WHERE s.teacher_id = ? AND s.deleted_at IS NULL
          AND tp.deleted_at IS NULL
          AND (tp.title LIKE ? OR tp.description LIKE ?)
        LIMIT 20
      `).all(tid, like, like);
      result.works = db.prepare(`
        SELECT s.id, s.topic, s.status, s.uploaded_at,
               s.group_id, s.student_id, st.name AS student_name, g.name AS group_name
        FROM submissions s
        JOIN students st ON st.id = s.student_id
        JOIN groups g ON g.id = s.group_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN subjects sj ON sj.id = a.subject_id
        WHERE s.teacher_id = ? AND s.deleted_at IS NULL
          AND sj.deleted_at IS NULL
          AND (s.topic LIKE ? OR st.name LIKE ?)
        ORDER BY s.uploaded_at DESC LIMIT 20
      `).all(tid, like, like);
      result.announcements = db.prepare(`
        SELECT a.id, a.title, a.content, a.created_at, g.name AS group_name, g.id AS group_id
        FROM group_announcements a
        JOIN groups g ON g.id = a.group_id
        JOIN teacher_groups tg ON tg.group_id = g.id AND tg.teacher_id = ?
        WHERE a.deleted_at IS NULL
          AND (a.title LIKE ? OR a.content LIKE ?)
        ORDER BY a.created_at DESC LIMIT 20
      `).all(tid, like, like);
    } else if (role === 'admin') {
      result.subjects = db.prepare(`
        SELECT s.id, s.title, t.id AS teacher_id, t.name AS teacher_name
        FROM subjects s JOIN teachers t ON t.id = s.teacher_id
        WHERE s.title LIKE ? AND s.deleted_at IS NULL
        LIMIT 20
      `).all(like);
      result.works = db.prepare(`
        SELECT s.id, s.topic, s.status, s.uploaded_at,
               s.group_id, s.teacher_id, st.name AS student_name, g.name AS group_name
        FROM submissions s
        JOIN students st ON st.id = s.student_id
        JOIN groups g ON g.id = s.group_id
        WHERE (s.topic LIKE ? OR st.name LIKE ?)
          AND s.deleted_at IS NULL
        ORDER BY s.uploaded_at DESC LIMIT 20
      `).all(like, like);
    }
  }
  const total = Object.values(result).reduce((sum, arr) => sum + arr.length, 0);
  return res.render('common/search', { title: 'Поиск', q, role, result, total });
}));

router.get('/feedback', (req, res) => {
  return res.render('common/feedback', {
    title: 'Обратная связь',
    referer: req.query.from || '',
    sent: req.query.sent === '1',
  });
});

// rate limit читает настройки из БД на каждом запросе
function feedbackRateLimit(req, res, next) {
  const max = Math.max(1, Number(settings.get('feedback.rateLimitMax')) || 5);
  const windowMs = Math.max(1, Number(settings.get('feedback.rateLimitWindowMin')) || 60) * 60_000;
  return rateLimitAction('feedback', {
    max, windowMs, blockMs: windowMs,
  })(req, res, next);
}

router.post('/feedback', feedbackRateLimit, handler((req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 5000);
  const contact = String(req.body.contact || '').trim().slice(0, 200);
  const page = String(req.body.page || '').trim().slice(0, 500);
  if (!text) return res.redirect('/feedback?from=' + encodeURIComponent(page));
  db.prepare(`
    INSERT INTO feedback (text, contact, page, ip, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    text,
    contact || null,
    page || null,
    req.clientIp || null,
    String(req.get('user-agent') || '').slice(0, 500)
  );
  return res.redirect('/feedback?sent=1');
}));

router.get('/profile', (req, res) => {
  if (req.session?.adminId) return res.redirect('/admin/profile');
  if (req.session?.studentId) return res.redirect('/my-profile');
  if (req.session?.teacherId) return res.redirect('/my-profile');
  return res.redirect('/login');
});

module.exports = router;