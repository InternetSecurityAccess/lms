// database/index.js
'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('../config');
const settings = require('../config/settings');
const { seedDemo } = require('./seed-demo');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    last_name TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    middle_name TEXT NOT NULL DEFAULT '',
    login TEXT,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','finished')),
    deleted_at DATETIME,
    session_version INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    max_url TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_login_unique
    ON teachers(login) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_teachers_status_deleted
    ON teachers(status, deleted_at);
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','finished')),
    deleted_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_unique
    ON groups(name) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_groups_status_deleted
    ON groups(status, deleted_at);
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    last_name TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    middle_name TEXT NOT NULL DEFAULT '',
    login TEXT,
    group_id INTEGER NOT NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','finished','rejected')),
    approved_at DATETIME,
    approved_by_teacher_id INTEGER,
    rejection_reason TEXT,
    deleted_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    CHECK (
      (status = 'finished' AND approved_at IS NOT NULL AND rejection_reason IS NULL)
      OR (status = 'rejected' AND approved_at IS NULL AND rejection_reason IS NOT NULL)
      OR (status = 'active' AND rejection_reason IS NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_students_login_unique
    ON students(login) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_students_group ON students(group_id);
  CREATE INDEX IF NOT EXISTS idx_students_approval ON students(approved_at, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_students_status_deleted ON students(status, deleted_at);
  CREATE TABLE IF NOT EXISTS teacher_groups (
    teacher_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (teacher_id, group_id),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_teacher_groups_group ON teacher_groups(group_id);
  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','finished')),
    deleted_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_subjects_teacher ON subjects(teacher_id, status);
  CREATE INDEX IF NOT EXISTS idx_subjects_status_deleted ON subjects(status, deleted_at);
  CREATE TABLE IF NOT EXISTS subject_groups (
    subject_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (subject_id, group_id),
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_subject_groups_group ON subject_groups(group_id);
  /* ─── subject_groups_history ──────────────────────────────────
     История «предмет был привязан к группе, потом отвязан».
     Создаётся при «Завершить для группы». Показывается в карточке
     предмета → «Группы» → блок «Ранее отвязанные группы» с кнопкой
     «Вернуть в предмет».
     Пока предмет для группы в истории (нет активной записи в
     subject_groups), всё содержимое — readonly по снимку на момент
     finished_at. При возврате группы история игнорируется: работаем
     с текущим состоянием (работы сохраняют статусы, темы — как есть).
     ──────────────────────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS subject_groups_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    finished_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_by_teacher_id INTEGER,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sgh_subject_group
    ON subject_groups_history(subject_id, group_id, finished_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sgh_group
    ON subject_groups_history(group_id);
  CREATE INDEX IF NOT EXISTS idx_sgh_subject
    ON subject_groups_history(subject_id, finished_at DESC);
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL,
    subject_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    deadline DATETIME,
    allow_custom_topic INTEGER NOT NULL DEFAULT 1,
    external_url TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('draft','active','finished')),
    deleted_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assignments_teacher ON assignments(teacher_id, status);
  CREATE INDEX IF NOT EXISTS idx_assignments_subject ON assignments(subject_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_status_deleted ON assignments(status, deleted_at);
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    assignment_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    external_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','accepted','rejected')),
    comment TEXT,
    pc_name TEXT,
    ip_address TEXT,
    user_agent TEXT,
    deleted_at DATETIME,
    uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ai_flag INTEGER NOT NULL DEFAULT 0,
    ai_flag_read_by_student INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_teacher
    ON submissions(teacher_id, status, uploaded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_submissions_student
    ON submissions(student_id, teacher_id, uploaded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_submissions_group
    ON submissions(group_id, teacher_id, uploaded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
  CREATE TABLE IF NOT EXISTS submission_status_reads (
    submission_id INTEGER NOT NULL,
    reader_type TEXT NOT NULL CHECK (reader_type IN ('student','teacher')),
    reader_id INTEGER NOT NULL,
    read_status TEXT NOT NULL,
    read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (submission_id, reader_type, reader_id, read_status),
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_submission_status_reads_reader
    ON submission_status_reads(reader_type, reader_id);
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('submission','topic','assignment')),
    owner_id INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    filesize INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_owner
    ON attachments(owner_kind, owner_id, position, id);
  CREATE TABLE IF NOT EXISTS group_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    last_message_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
    UNIQUE (group_id, teacher_id)
  );
  CREATE INDEX IF NOT EXISTS idx_group_threads_group ON group_threads(group_id);
  CREATE INDEX IF NOT EXISTS idx_group_threads_teacher ON group_threads(teacher_id);
  CREATE INDEX IF NOT EXISTS idx_group_threads_last ON group_threads(last_message_at DESC);
  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('student','teacher')),
    sender_id INTEGER NOT NULL,
    reply_to_id INTEGER,
    sender_name TEXT NOT NULL,
    message TEXT,
    file_path TEXT,
    file_name TEXT,
    deleted_at DATETIME,
    deleted_by_type TEXT CHECK (deleted_by_type IN ('student','teacher') OR deleted_by_type IS NULL),
    deleted_by_id INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES group_threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_group_messages_thread ON group_messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_group_messages_sender
    ON group_messages(thread_id, sender_type, sender_id);
  CREATE INDEX IF NOT EXISTS idx_group_messages_deleted
    ON group_messages(thread_id, deleted_at);
  CREATE TABLE IF NOT EXISTS group_thread_reads (
    thread_id INTEGER NOT NULL,
    reader_type TEXT NOT NULL CHECK (reader_type IN ('student','teacher')),
    reader_id INTEGER NOT NULL,
    last_read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (thread_id, reader_type, reader_id),
    FOREIGN KEY (thread_id) REFERENCES group_threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_group_thread_reads_reader
    ON group_thread_reads(reader_type, reader_id);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('student','teacher')),
    sender_id INTEGER,
    reply_to_id INTEGER,
    sender_name TEXT NOT NULL,
    message TEXT,
    file_path TEXT,
    file_name TEXT,
    deleted_at DATETIME,
    deleted_by_type TEXT CHECK (deleted_by_type IN ('student','teacher') OR deleted_by_type IS NULL),
    deleted_by_id INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_submission ON messages(submission_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(submission_id, sender_type, is_read);
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    content_url TEXT,
    assignment_url TEXT,
    assignment_id INTEGER,
    homework_text TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published'
      CHECK (status IN ('draft','published','finished')),
    published_at DATETIME,
    available_from DATETIME,
    deleted_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_topics_subject ON topics(subject_id, position, status);
  CREATE INDEX IF NOT EXISTS idx_topics_status_deleted ON topics(status, deleted_at);
  CREATE TABLE IF NOT EXISTS support_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    teacher_id INTEGER,
    last_message_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
    CHECK (
      (student_id IS NOT NULL AND teacher_id IS NULL) OR
      (student_id IS NULL AND teacher_id IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_support_threads_student
    ON support_threads(student_id) WHERE student_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_support_threads_teacher
    ON support_threads(teacher_id) WHERE teacher_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_support_threads_last ON support_threads(last_message_at DESC);
  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user','admin')),
    sender_id INTEGER,
    sender_name TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    file_path TEXT,
    file_name TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    deleted_at DATETIME,
    deleted_by_type TEXT,
    deleted_by_id INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES support_threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_support_messages_unread
    ON support_messages(thread_id, sender_type, is_read);
  CREATE TABLE IF NOT EXISTS group_announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','finished')),
    deleted_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_group_announcements_group
    ON group_announcements(group_id, pinned DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_group_announcements_status_deleted
    ON group_announcements(status, deleted_at);
  CREATE TABLE IF NOT EXISTS group_announcement_reads (
    announcement_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (announcement_id, student_id),
    FOREIGN KEY (announcement_id) REFERENCES group_announcements(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    until_ms INTEGER NOT NULL DEFAULT 0,
    last_attempt_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limits_until ON rate_limits(until_ms);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    details TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_type, actor_id);
  CREATE TABLE IF NOT EXISTS slow_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'guest',
    user_id INTEGER,
    ip TEXT,
    user_agent TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_slow_log_created ON slow_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_slow_log_path ON slow_log(path, created_at DESC);
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    contact TEXT,
    page TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

  /* ═══════════════════════════════════════════════════════════
     ПОДСИСТЕМА ТЕСТИРОВАНИЯ (Quiz)
     Тест привязан к теме через topics.quiz_id (добавляется
     ALTER-ом ниже, т.к. topics создаётся здесь же и нужен
     порядок «quizzes → topics.quiz_id»).
     ═══════════════════════════════════════════════════════════ */

  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT,
    pass_percent INTEGER NOT NULL DEFAULT 60
      CHECK (pass_percent BETWEEN 0 AND 100),
    max_attempts INTEGER NOT NULL DEFAULT 1,
    time_limit_minutes INTEGER,
    show_correct INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('single','multiple','ordering')),
    points INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    image_stored_name TEXT,
    image_filename TEXT,
    image_filesize INTEGER,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz
    ON quiz_questions(quiz_id, position);

  CREATE TABLE IF NOT EXISTS quiz_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    is_correct INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    image_stored_name TEXT,
    image_filename TEXT,
    image_filesize INTEGER,
    FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_options_question
    ON quiz_options(question_id, position);

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    score REAL,
    max_score REAL,
    passed INTEGER,
    status TEXT NOT NULL DEFAULT 'in_progress'
      CHECK (status IN ('in_progress','finished','expired')),
    question_order TEXT,
    option_orders TEXT,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz_student
    ON quiz_attempts(quiz_id, student_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_quiz_attempts_student
    ON quiz_attempts(student_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS quiz_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    option_ids TEXT,
    score REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (attempt_id) REFERENCES quiz_attempts(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE,
    UNIQUE (attempt_id, question_id)
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_answers_attempt
    ON quiz_answers(attempt_id);
`);

function assertColumns(table, required) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const names = new Set(cols.map((c) => c.name));
  return required.filter((c) => !names.has(c));
}

const REQUIRED = [
  ['teachers', ['status', 'deleted_at']],
  ['students', ['status', 'deleted_at']],
  ['groups', ['status', 'deleted_at']],
  ['subjects', ['status', 'deleted_at']],
  ['assignments', ['status', 'deleted_at']],
  ['topics', ['status', 'deleted_at']],
  ['group_announcements', ['status', 'deleted_at']],
  ['submissions', ['ai_flag', 'ai_flag_read_by_student', 'deleted_at']],
];

let schemaBroken = false;
for (const [table, cols] of REQUIRED) {
  const missing = assertColumns(table, cols);
  if (missing.length > 0) {
    console.error(`[db] схема ${table}: нет колонок ${missing.join(', ')}`);
    schemaBroken = true;
  }
}
if (schemaBroken) {
  console.error('');
  console.error('[db] СХЕМА УСТАРЕЛА.');
  console.error('     Этот код не выполняет миграций — он создаёт схему с нуля.');
  console.error('     Удалите файл БД и перезапустите:');
  console.error(`     ${config.DB_PATH}`);
  console.error('     (или: rm data/app.db data/app.db-wal data/app.db-shm)');
  console.error('');
  process.exit(1);
}

/* ═══════════════════════════════════════════════════════════
   НОРМАЛИЗАЦИЯ ДАТ
   ═══════════════════════════════════════════════════════════ */
(function normalizeDateFormats() {
  const columnsToNormalize = [
    ['teachers', ['created_at']],
    ['students', ['created_at', 'approved_at']],
    ['groups', ['created_at']],
    ['subjects', ['created_at']],
    ['assignments', ['created_at', 'deadline']],
    ['topics', ['created_at', 'published_at']],
    ['submissions', ['uploaded_at']],
    ['attachments', ['uploaded_at']],
    ['group_threads', ['created_at', 'last_message_at']],
    ['group_thread_reads', ['last_read_at']],
    ['group_messages', ['created_at']],
    ['group_announcements', ['created_at']],
    ['group_announcement_reads', ['read_at']],
    ['support_threads', ['created_at', 'last_message_at']],
    ['support_messages', ['created_at']],
    ['submission_status_reads', ['read_at']],
    ['audit_log', ['created_at']],
    ['slow_log', ['created_at']],
    ['feedback', ['created_at']],
    ['subject_groups_history', ['finished_at']],
    ['quiz_attempts', ['started_at', 'finished_at']],
  ];
  let total = 0;
  for (const [table, cols] of columnsToNormalize) {
    for (const col of cols) {
      try {
        const r = db.prepare(`
          UPDATE ${table}
          SET ${col} = substr(replace(${col}, 'T', ' '), 1, 19)
          WHERE ${col} IS NOT NULL
            AND instr(${col}, 'T') > 0
        `).run();
        total += r.changes;
      } catch (e) {
        if (!/no such (table|column)/i.test(e.message)) {
          console.error(`[db] normalize ${table}.${col}:`, e.message);
        }
      }
    }
  }
  if (total > 0) {
    console.log(`[db] Нормализовано дат (ISO → SQL): ${total}`);
  }
})();

/* ═══════════════════════════════════════════════════════════
   ЛЁГКИЕ МИГРАЦИИ
   ═══════════════════════════════════════════════════════════ */
(function applyAdditiveMigrations() {
  function ensureColumn(table, column, definition) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (cols.includes(column)) return false;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    } catch (e) {
      console.error(`[db] не удалось добавить колонку ${table}.${column}:`, e.message);
      return false;
    }
  }
  if (ensureColumn('topics', 'available_from', 'DATETIME NULL')) {
    console.log('[db] Добавлена колонка topics.available_from (отложенная публикация)');
  }
  // Quiz: topics.quiz_id. DEFAULT NULL обязателен — при foreign_keys = ON
  // SQLite не даёт ALTER TABLE ADD COLUMN с REFERENCES без DEFAULT NULL.
  if (ensureColumn(
    'topics',
    'quiz_id',
    'INTEGER REFERENCES quizzes(id) ON DELETE SET NULL DEFAULT NULL'
  )) {
    console.log('[db] Добавлена колонка topics.quiz_id (связь с тестом)');
  }
})();

/* ═══════════════════════════════════════════════════════════
   НАСТРОЙКИ
   ═══════════════════════════════════════════════════════════ */
settings.init(db);
{
  const seedSettings = db.prepare(
    'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)'
  );
  for (const [key, value] of Object.entries(settings.getAllDefaults())) {
    seedSettings.run(key, JSON.stringify(value));
  }
}
settings.resetCache();

/* ═══════════════════════════════════════════════════════════
   МИГРАЦИЯ TZ v1
   ═══════════════════════════════════════════════════════════ */
(function migrateTimezoneV1() {
  const marker = 'timezone_migrated_v1';
  try {
    if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(marker)) return;
    const tz = settings.get('college.timezone') || 'Asia/Irkutsk';
    const offset = require('../utils/timezone').getTzOffsetHours(tz);
    if (offset === 0) {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
        .run(marker, JSON.stringify(true));
      return;
    }
    const modifier = `-${Math.round(offset)} hours`;
    const tx = db.transaction(() => {
      const r1 = db.prepare(
        'UPDATE assignments SET deadline = datetime(deadline, ?) WHERE deadline IS NOT NULL'
      ).run(modifier);
      const r2 = db.prepare(
        'UPDATE topics SET available_from = datetime(available_from, ?) WHERE available_from IS NOT NULL'
      ).run(modifier);
      if (r1.changes + r2.changes > 0) {
        console.log(
          `[db] Миграция TZ v1: ${r1.changes} deadline, `
          + `${r2.changes} available_from сдвинуто на ${modifier} (${tz})`
        );
      }
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
        .run(marker, JSON.stringify(true));
    });
    tx();
  } catch (e) {
    console.error('[db] Миграция TZ v1 не удалась:', e.message);
  }
})();

/* ═══════════════════════════════════════════════════════════
   ПЕРВЫЙ АДМИН
   ═══════════════════════════════════════════════════════════ */
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
if (adminCount === 0) {
  if (config.ADMIN_PASSWORD) {
    const hash = bcrypt.hashSync(config.ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO admins (name, password_hash) VALUES (?, ?)')
      .run(config.ADMIN_NAME, hash);
    console.log(`[db] Создан администратор "${config.ADMIN_NAME}".`);
  } else {
    console.warn('[db] admins пуст, ADMIN_PASSWORD не задан — админ не создан.');
  }
}

/* ═══════════════════════════════════════════════════════════
   ДЕМО-ДАННЫЕ
   ═══════════════════════════════════════════════════════════ */
if (settings.get('demo.enabled')) {
  try {
    seedDemo(db);
  } catch (e) {
    console.error('[demo-seed] Ошибка:', e);
  }
}

/* ═══════════════════════════════════════════════════════════
   РОТАЦИИ
   ═══════════════════════════════════════════════════════════ */
function rotateAudit() {
  try {
    const days = Math.max(1, Number(settings.get('audit.retentionDays')) || 1500);
    const r = db.prepare(
      "DELETE FROM audit_log WHERE created_at < datetime('now', ?)"
    ).run(`-${days} days`);
    if (r.changes > 0) {
      console.log(`[audit] ротация: удалено ${r.changes} записей (>${days} дней)`);
    }
  } catch (e) {
    console.error('[audit] rotation:', e.message);
  }
}
rotateAudit();
setInterval(rotateAudit, 24 * 60 * 60 * 1000).unref();

function rotateSlowLog() {
  try {
    const r = db.prepare(
      "DELETE FROM slow_log WHERE created_at < datetime('now', '-30 days')"
    ).run();
    if (r.changes > 0) {
      console.log(`[slow-log] ротация: удалено ${r.changes} записей (>30 дней)`);
    }
  } catch (e) {
    console.error('[slow-log] rotation:', e.message);
  }
}
rotateSlowLog();
setInterval(rotateSlowLog, 24 * 60 * 60 * 1000).unref();

/* ═══════════════════════════════════════════════════════════
   АВТОВЫКЛЮЧЕНИЕ РАСШИРЕННОГО АУДИТА
   ═══════════════════════════════════════════════════════════ */
setInterval(() => {
  try {
    if (!settings.get('audit.extended')) return;
    const until = settings.get('audit.extendedUntil');
    if (until == null) return;
    if (Date.now() >= Number(until)) {
      settings.set('audit.extended', false);
      settings.set('audit.extendedUntil', null);
      console.log('[audit] extended-аудит автоматически выключен (истёк срок)');
    }
  } catch (e) {
    console.error('[audit] auto-disable:', e.message);
  }
}, 60 * 1000).unref();

module.exports = db;