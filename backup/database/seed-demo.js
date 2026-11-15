// database/seed-demo.js
'use strict';
const { nowSql } = require('../utils/dates');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const {
  DEMO_GROUPS,
  DEMO_USERS,
  fullName,
} = require('../config/demo-users');

const DEMO_TEACHERS = DEMO_USERS
  .filter((u) => u.role === 'teacher')
  .map((u) => ({
    login: u.login,
    password: u.password,
    last_name: u.last_name,
    first_name: u.first_name,
    middle_name: u.middle_name,
    subject: u.subject,
    groups: u.teacher_groups,
    lectureFiles: u.lecture_files,
    assignmentFiles: u.assignment_files,
    submissionFiles: u.submission_files,
  }));

const DEMO_STUDENTS = DEMO_USERS
  .filter((u) => u.role === 'student')
  .map((u) => ({
    login: u.login,
    password: u.password,
    last_name: u.last_name,
    first_name: u.first_name,
    middle_name: u.middle_name,
    group: u.group,
  }));

const TEST_FILES = [
  'test.docx', 'test.pdf', 'test.pptx', 'test.txt', 'test.zip',
  'test.png', 'test.jpg', 'test.jpeg',
];

// Исходники demo-файлов лежат в <корень-проекта>/demo/ — часть кода,
// попадают в git, НИКОГДА не удаляются.
function demoSourceDir() {
  return path.resolve(__dirname, '..', 'demo');
}

// Копии demo-файлов лежат в data/storage/demo/ — рабочие данные,
// удаляются при deleteDemo() через cleanupStudentFiles/cleanupTeacherFiles.
function demoUploadDir() {
  return path.join(config.STORAGE_DIR, 'demo');
}

function copyTestFile(filename) {
  const src = path.join(demoSourceDir(), filename);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return null;
  const destDir = demoUploadDir();
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext);
  const uuid = crypto.randomUUID();
  const storedName = path.posix.join('demo', `${uuid}-${base}${ext}`);
  const dest = path.join(config.STORAGE_DIR, storedName);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  return {
    stored_name: storedName,
    filename,
    filesize: fs.statSync(dest).size,
  };
}

function addAttachmentDirect(db, kind, ownerId, { stored_name, filename, filesize }) {
  const pos = (db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM attachments WHERE owner_kind = ? AND owner_id = ?'
  ).get(kind, Number(ownerId)) || { p: 0 }).p;
  db.prepare(`
    INSERT INTO attachments
      (owner_kind, owner_id, stored_name, filename, filesize, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kind, Number(ownerId), stored_name, filename, filesize || 0, pos);
}

function attachFilesTo(db, kind, ownerId, filenames) {
  if (!filenames || filenames.length === 0) return 0;
  let added = 0;
  for (const fn of filenames) {
    const exists = db.prepare(
      'SELECT 1 FROM attachments WHERE owner_kind = ? AND owner_id = ? AND filename = ? LIMIT 1'
    ).get(kind, Number(ownerId), fn);
    if (exists) continue;
    const info = copyTestFile(fn);
    if (!info) continue;
    addAttachmentDirect(db, kind, ownerId, info);
    added++;
  }
  return added;
}

/* ═══════════════════════════════════════════════════════════
   Идемпотентные ensure*. Любой повторный запуск ничего не
   дублирует — это важно, потому что seedDemo() вызывается при
   каждом старте сервера, если demo.enabled = true.
   ═══════════════════════════════════════════════════════════ */

function ensureGroup(db, name) {
  const row = db.prepare('SELECT id FROM groups WHERE name = ?').get(name);
  if (row) return row.id;
  const r = db.prepare(
    "INSERT INTO groups (name, status) VALUES (?, 'active')"
  ).run(name);
  return Number(r.lastInsertRowid);
}

function ensureTeacher(db, t) {
  const row = db.prepare('SELECT id FROM teachers WHERE login = ?').get(t.login);
  if (row) return row.id;
  const hash = bcrypt.hashSync(t.password, 10);
  const r = db.prepare(`
    INSERT INTO teachers
      (name, last_name, first_name, middle_name, login, password_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(fullName(t), t.last_name, t.first_name, t.middle_name, t.login, hash);
  return Number(r.lastInsertRowid);
}

function ensureStudent(db, s, groupId) {
  const row = db.prepare('SELECT id FROM students WHERE login = ?').get(s.login);
  if (row) return row.id;
  const hash = bcrypt.hashSync(s.password, 10);
  // approved_at = CURRENT_TIMESTAMP + status='active' — демо-студенты
  // уже подтверждены, чтобы сразу можно было зайти и посмотреть.
  const r = db.prepare(`
    INSERT INTO students
      (name, last_name, first_name, middle_name, login, group_id,
       password_hash, approved_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'active')
  `).run(fullName(s), s.last_name, s.first_name, s.middle_name, s.login, groupId, hash);
  return Number(r.lastInsertRowid);
}

function ensureTeacherGroup(db, teacherId, groupId) {
  db.prepare(
    'INSERT OR IGNORE INTO teacher_groups (teacher_id, group_id) VALUES (?, ?)'
  ).run(teacherId, groupId);
}

function ensureSubject(db, teacherId, data) {
  const row = db.prepare(
    'SELECT id FROM subjects WHERE teacher_id = ? AND title = ?'
  ).get(teacherId, data.title);
  if (row) return row.id;
  const r = db.prepare(`
    INSERT INTO subjects (teacher_id, title, description, status)
    VALUES (?, ?, ?, 'active')
  `).run(teacherId, data.title, data.description);
  return Number(r.lastInsertRowid);
}

function ensureSubjectGroup(db, subjectId, groupId) {
  db.prepare(
    'INSERT OR IGNORE INTO subject_groups (subject_id, group_id) VALUES (?, ?)'
  ).run(subjectId, groupId);
}

function ensureAssignment(db, teacherId, subjectId, data) {
  const row = db.prepare(
    'SELECT id FROM assignments WHERE teacher_id = ? AND subject_id = ? AND title = ?'
  ).get(teacherId, subjectId, data.title);
  if (row) return row.id;
  const r = db.prepare(`
    INSERT INTO assignments
      (teacher_id, subject_id, title, description, deadline, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(teacherId, subjectId, data.title, data.description || null, data.deadline || null);
  return Number(r.lastInsertRowid);
}

function ensureLectureTopic(db, subjectId, data, position) {
  const row = db.prepare(
    'SELECT id FROM topics WHERE subject_id = ? AND title = ?'
  ).get(subjectId, data.title);
  if (row) return row.id;
  const nowSqlValue = nowSql();
  const r = db.prepare(`
    INSERT INTO topics
      (subject_id, title, description, assignment_id, homework_text,
       position, status, published_at)
    VALUES (?, ?, ?, NULL, ?, ?, 'published', ?)
  `).run(subjectId, data.title, data.description || null,
    data.homework_text || null, position, nowSqlValue);
  return Number(r.lastInsertRowid);
}
function ensureAssignmentTopic(db, subjectId, assignmentId, data, position) {
  const row = db.prepare(
    'SELECT id FROM topics WHERE subject_id = ? AND title = ?'
  ).get(subjectId, data.title);
  if (row) return row.id;
  const nowSqlValue = nowSql();
  const r = db.prepare(`
    INSERT INTO topics
      (subject_id, title, description, assignment_id, homework_text,
       position, status, published_at)
    VALUES (?, ?, ?, ?, NULL, ?, 'published', ?)
  `).run(subjectId, data.title, data.description || null, assignmentId, position, nowSqlValue);
  return Number(r.lastInsertRowid);
}

function ensureSubmission(db, data, filenames) {
  // deleted_at IS NULL — ищем только «живую» сдачу. Если у пары
  // student+assignment есть только сдача в корзине — создаём новую,
  // ровно как делает настоящий submit.
  const row = db.prepare(`
    SELECT id FROM submissions
    WHERE student_id = ? AND assignment_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(data.studentId, data.assignmentId);
  if (row) return row.id;
  const r = db.prepare(`
    INSERT INTO submissions
      (student_id, teacher_id, group_id, assignment_id, topic, comment,
       status, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(data.studentId, data.teacherId, data.groupId, data.assignmentId,
    data.topic, data.comment || null, data.status || 'pending');
  const submissionId = Number(r.lastInsertRowid);
  attachFilesTo(db, 'submission', submissionId, filenames);
  return submissionId;
}

function ensureGroupThread(db, groupId, teacherId) {
  const row = db.prepare(
    'SELECT id FROM group_threads WHERE group_id = ? AND teacher_id = ?'
  ).get(groupId, teacherId);
  if (row) return row.id;
  const r = db.prepare(`
    INSERT INTO group_threads (group_id, teacher_id, last_message_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(groupId, teacherId);
  return Number(r.lastInsertRowid);
}

function addGroupMessageIfAbsent(db, threadId, senderType, senderId, senderName, message) {
  const exist = db.prepare(
    'SELECT id FROM group_messages WHERE thread_id = ? AND sender_name = ? AND message = ? LIMIT 1'
  ).get(threadId, senderName, message);
  if (exist) return;
  db.prepare(`
    INSERT INTO group_messages (thread_id, sender_type, sender_id, sender_name, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(threadId, senderType, senderId, senderName, message);
}

function ensureAnnouncement(db, groupId, teacherId, title, content, pinned) {
  const row = db.prepare(
    'SELECT id FROM group_announcements WHERE group_id = ? AND teacher_id = ? AND title = ?'
  ).get(groupId, teacherId, title);
  if (row) return row.id;
  const r = db.prepare(`
    INSERT INTO group_announcements
      (group_id, teacher_id, title, content, pinned, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(groupId, teacherId, title, content || null, pinned ? 1 : 0);
  return Number(r.lastInsertRowid);
}

function ensureSupportThreadStudent(db, studentId) {
  const row = db.prepare('SELECT id FROM support_threads WHERE student_id = ?').get(studentId);
  if (row) return row.id;
  const r = db.prepare(
    'INSERT INTO support_threads (student_id, last_message_at) VALUES (?, CURRENT_TIMESTAMP)'
  ).run(studentId);
  return Number(r.lastInsertRowid);
}

function ensureSupportThreadTeacher(db, teacherId) {
  const row = db.prepare('SELECT id FROM support_threads WHERE teacher_id = ?').get(teacherId);
  if (row) return row.id;
  const r = db.prepare(
    'INSERT INTO support_threads (teacher_id, last_message_at) VALUES (?, CURRENT_TIMESTAMP)'
  ).run(teacherId);
  return Number(r.lastInsertRowid);
}

function addSupportMessageIfAbsent(db, threadId, senderType, senderId, senderName, message) {
  const exist = db.prepare(
    'SELECT id FROM support_messages WHERE thread_id = ? AND sender_name = ? AND message = ? LIMIT 1'
  ).get(threadId, senderName, message);
  if (exist) return;
  db.prepare(`
    INSERT INTO support_messages (thread_id, sender_type, sender_id, sender_name, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(threadId, senderType, senderId, senderName, message);
}

function seedDemo(db) {
  const log = (...args) => console.log('[demo-seed]', ...args);

  const srcDir = demoSourceDir();
  if (!fs.existsSync(srcDir)) {
    log(`папка ${srcDir} не найдена — демо-данные будут без вложений`);
  } else {
    const present = TEST_FILES.filter((fn) => fs.existsSync(path.join(srcDir, fn)));
    const missing = TEST_FILES.filter((fn) => !fs.existsSync(path.join(srcDir, fn)));
    log(`источник файлов: ${srcDir}`);
    log(`доступно файлов: ${present.length}/${TEST_FILES.length}`);
    if (missing.length > 0) {
      log(`отсутствуют: ${missing.join(', ')}`);
    }
  }

  const groupIds = {};
  for (const name of DEMO_GROUPS) {
    groupIds[name] = ensureGroup(db, name);
  }

  const teacherIds = {};
  const assignmentIds = {};
  for (const t of DEMO_TEACHERS) {
    const tid = ensureTeacher(db, t);
    teacherIds[t.login] = tid;

    for (const gn of t.groups) {
      ensureTeacherGroup(db, tid, groupIds[gn]);
    }

    const sid = ensureSubject(db, tid, t.subject);
    for (const gn of t.groups) {
      ensureSubjectGroup(db, sid, groupIds[gn]);
    }

    const lectureTitle = `[Демо] Лекция. ${t.subject.title.replace('[Демо] ', '')}`;
    const lectureId = ensureLectureTopic(db, sid, {
      title: lectureTitle,
      description: `<h2>Вводная лекция</h2>`
        + `<p>Демонстрационный материал по предмету «${t.subject.title.replace('[Демо] ', '')}».</p>`
        + `<p>К лекции приложены файлы разных форматов — можно проверить просмотр PDF, DOCX, PPTX, TXT, ZIP и изображений.</p>`,
      homework_text: 'Прочитать конспект и ответить на вопросы в конце.',
    }, 1);
    attachFilesTo(db, 'topic', lectureId, t.lectureFiles);

    const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const assignmentTitle = `[Демо] Практическая работа. ${t.subject.title.replace('[Демо] ', '')}`;
    const aid = ensureAssignment(db, tid, sid, {
      title: assignmentTitle,
      description: `Практическая работа по предмету «${t.subject.title.replace('[Демо] ', '')}». `
        + `Выполните задание и приложите файл или ссылку.`,
      deadline,
    });
    assignmentIds[t.login] = aid;

    const assignmentTopicId = ensureAssignmentTopic(db, sid, aid, {
      title: assignmentTitle,
      description: `<p>Сдайте работу через вкладку «Сдать работу».</p>`
        + `<p>После сдачи преподаватель увидит её в «Уведомлениях» и сможет принять или отклонить.</p>`,
    }, 2);
    attachFilesTo(db, 'topic', assignmentTopicId, t.assignmentFiles);
    attachFilesTo(db, 'assignment', aid, t.assignmentFiles);

    const firstGroupName = t.groups[0];
    const firstGroupId = groupIds[firstGroupName];
    if (firstGroupId) {
      ensureAnnouncement(db, firstGroupId, tid,
        `[Демо] Расписание консультаций по предмету «${t.subject.title.replace('[Демо] ', '')}»`,
        'Консультации по средам в 16:00, ауд. 210. Приходите с вопросами по лекциям и практическим работам.',
        true);
    }

    const thThread = ensureSupportThreadTeacher(db, tid);
    addSupportMessageIfAbsent(db, thThread, 'user', tid, fullName(t),
      `[Демо] Здравствуйте! Как привязать предмет к новой группе?`);
  }

  const studentIds = {};
  for (const s of DEMO_STUDENTS) {
    const gid = groupIds[s.group];
    if (!gid) {
      log(`пропуск студента ${s.login}: группа «${s.group}» не найдена`);
      continue;
    }
    studentIds[s.login] = { id: ensureStudent(db, s, gid), group: s.group, data: s };
  }

  for (const t of DEMO_TEACHERS) {
    const tid = teacherIds[t.login];
    const firstGroupName = t.groups[0];
    const firstGroupId = groupIds[firstGroupName];
    if (!firstGroupId) continue;

    const threadId = ensureGroupThread(db, firstGroupId, tid);
    addGroupMessageIfAbsent(db, threadId, 'teacher', tid, fullName(t),
      `Добро пожаловать в чат группы «${firstGroupName}»! Здесь можно задавать вопросы по предмету «${t.subject.title.replace('[Демо] ', '')}».`);

    const studentInGroup = DEMO_STUDENTS.find((s) => s.group === firstGroupName);
    if (studentInGroup) {
      const sInfo = studentIds[studentInGroup.login];
      if (sInfo) {
        addGroupMessageIfAbsent(db, threadId, 'student', sInfo.id, fullName(studentInGroup),
          'Здравствуйте! Подскажите, срок сдачи по практической работе ещё в силе?');
      }
    }
    addGroupMessageIfAbsent(db, threadId, 'teacher', tid, fullName(t),
      'Да, срок сдачи через две недели. Если будут проблемы — пишите.');
  }

  for (const t of DEMO_TEACHERS) {
    const tid = teacherIds[t.login];
    const aid = assignmentIds[t.login];
    const subjectGroups = t.groups.map((gn) => groupIds[gn]).filter(Boolean);
    const studentsInSubject = Object.values(studentIds)
      .filter((st) => subjectGroups.includes(groupIds[st.group]));
    if (studentsInSubject.length === 0) continue;

    const picked = studentsInSubject.slice(0, 2);
    const statuses = ['pending', 'accepted'];
    picked.forEach((st, i) => {
      const groupId = groupIds[st.group];
      ensureSubmission(db, {
        studentId: st.id,
        teacherId: tid,
        groupId,
        assignmentId: aid,
        topic: `[Демо] ${t.subject.title.replace('[Демо] ', '')} — работа ${i + 1}`,
        comment: i === 0
          ? 'Здравствуйте! Отправляю работу на проверку.'
          : 'Здравствуйте! Отправляю доработанную работу.',
        status: statuses[i] || 'pending',
      }, t.submissionFiles);

      const subId = db.prepare(`
        SELECT id FROM submissions
        WHERE student_id = ? AND assignment_id = ? AND deleted_at IS NULL
        ORDER BY uploaded_at DESC LIMIT 1
      `).get(st.id, aid)?.id;
      if (!subId) return;

      const msgExist = db.prepare(
        'SELECT id FROM messages WHERE submission_id = ? LIMIT 1'
      ).get(subId);
      if (msgExist) return;

      db.prepare(`
        INSERT INTO messages (submission_id, sender_type, sender_id, sender_name, message)
        VALUES (?, 'student', ?, ?, ?)
      `).run(subId, st.id, fullName(st.data),
        'Здравствуйте! Отправляю работу на проверку.');
      db.prepare(`
        INSERT INTO messages (submission_id, sender_type, sender_id, sender_name, message)
        VALUES (?, 'teacher', ?, ?, ?)
      `).run(subId, tid, fullName(t),
        'Добрый день! Работа получена. Проверю в ближайшее время.');
    });
  }

  for (const s of DEMO_STUDENTS) {
    const info = studentIds[s.login];
    if (!info) continue;
    const stThread = ensureSupportThreadStudent(db, info.id);
    addSupportMessageIfAbsent(db, stThread, 'user', info.id, fullName(s),
      `[Демо] Здравствуйте! Подскажите, как сменить пароль?`);
  }

  const fbExist = db.prepare(
    "SELECT id FROM feedback WHERE text LIKE '[Демо]%' LIMIT 1"
  ).get();
  if (!fbExist) {
    db.prepare(`
      INSERT INTO feedback (text, contact, page)
      VALUES (?, ?, ?)
    `).run(
      '[Демо] Отличная система, но хотелось бы видеть уведомления о новых работах в реальном времени.',
      'student@demo.local',
      '/my-assignments'
    );
  }

  // Итог по фактическим данным, а не «6/6/6/6».
  // deleted_at IS NULL — если пользователь «удалил» демо-строку в /admin/trash,
  // в логе честно не будет её считать.
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM groups   WHERE name  LIKE '[Демо]%' AND deleted_at IS NULL) AS groups,
      (SELECT COUNT(*) FROM teachers WHERE login LIKE '%@demo.local' AND deleted_at IS NULL) AS teachers,
      (SELECT COUNT(*) FROM students WHERE login LIKE '%@demo.local' AND deleted_at IS NULL) AS students,
      (SELECT COUNT(*) FROM subjects WHERE title LIKE '[Демо]%' AND deleted_at IS NULL) AS subjects
  `).get();
  log(`демо-данные созданы: ${counts.groups} групп, ${counts.teachers} преподавателей, `
    + `${counts.students} студентов, ${counts.subjects} предметов`);
  log(`рабочие копии файлов — в ${demoUploadDir()}`);
  log(`исходники — в ${srcDir} (не удаляются)`);
}

async function deleteDemo(db) {
  const log = (...args) => console.log('[demo-delete]', ...args);

  const teacherLogins = DEMO_TEACHERS.map((t) => t.login);
  const studentLogins = DEMO_STUDENTS.map((s) => s.login);
  const groupNames = DEMO_GROUPS;
  const ph = (n) => Array(n).fill('?').join(',');

  // Для hard-delete demo-данных фильтр deleted_at не нужен:
  // мы стираем всё, что помечено [Демо], — и живое, и корзину.
  const teacherIds = db.prepare(
    `SELECT id FROM teachers WHERE login IN (${ph(teacherLogins.length)})`
  ).all(...teacherLogins).map((r) => r.id);
  const studentIds = db.prepare(
    `SELECT id FROM students WHERE login IN (${ph(studentLogins.length)})`
  ).all(...studentLogins).map((r) => r.id);
  const groupIds = db.prepare(
    `SELECT id FROM groups WHERE name IN (${ph(groupNames.length)})`
  ).all(...groupNames).map((r) => r.id);

  if (teacherIds.length === 0 && studentIds.length === 0 && groupIds.length === 0) {
    log('нечего удалять — демо-данные не найдены');
    return;
  }

  try {
    const { cleanupStudentFiles, cleanupTeacherFiles } = require('../utils/storage/cleanup');
    for (const id of studentIds) {
      try { await cleanupStudentFiles(db, id); } catch { /* ignore */ }
    }
    for (const id of teacherIds) {
      try { await cleanupTeacherFiles(db, id); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('[demo-delete] cleanup files:', e.message);
  }

  db.transaction(() => {
    if (teacherIds.length > 0) {
      const phT = ph(teacherIds.length);
      db.prepare(`DELETE FROM subjects WHERE teacher_id IN (${phT})`).run(...teacherIds);
      db.prepare(`DELETE FROM teachers WHERE id IN (${phT})`).run(...teacherIds);
    }
    if (studentIds.length > 0) {
      db.prepare(`DELETE FROM students WHERE id IN (${ph(studentIds.length)})`).run(...studentIds);
    }
    if (groupIds.length > 0) {
      db.prepare(`DELETE FROM groups WHERE id IN (${ph(groupIds.length)})`).run(...groupIds);
    }
    db.prepare("DELETE FROM feedback WHERE text LIKE '[Демо]%'").run();
  })();

  log('демо-данные удалены (исходники в <корень>/demo/ сохранены)');
}

module.exports = { seedDemo, deleteDemo };