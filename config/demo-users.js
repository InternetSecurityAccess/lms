'use strict';

// Единый источник демо-пользователей. Используется:
//   • database/seed-demo.js         — что создавать при старте;
//   • config/index.js               — DEMO_TEACHER / DEMO_STUDENT / DEMO_USERS;
//   • views/auth/login.txt          — список кнопок «Демо-вход»;
//   • routes/auth.js                — проверка, что логин входит в справочник.
//
// «Основные» демо-пользователи (config.DEMO_TEACHER / config.DEMO_STUDENT) —
// это первые в списке соответствующей роли:
//   преподаватель ivanov@demo.local
//   студент       smirnov@demo.local
// Пароль у всех — Demo2026!.

const DEMO_GROUPS = [
  '[Демо] ИС-21',
  '[Демо] ИС-22',
  '[Демо] ПИ-21',
  '[Демо] ПИ-22',
  '[Демо] ВЕБ-21',
];

const DEMO_USERS = [
  // ─── Преподаватели ───
  {
    role: 'teacher',
    login: 'ivanov@demo.local',
    password: 'Demo2026!',
    last_name: 'Иванов',
    first_name: 'Иван',
    middle_name: 'Иванович',
    teacher_groups: ['[Демо] ИС-21', '[Демо] ИС-22', '[Демо] ПИ-21'],
    subject: { title: '[Демо] Математика', description: 'Алгебра, геометрия, начала математического анализа.' },
    lecture_files: ['test.pdf', 'test.docx'],
    assignment_files: ['test.docx'],
    submission_files: ['test.pdf', 'test.zip'],
  },
  {
    role: 'teacher',
    login: 'petrova@demo.local',
    password: 'Demo2026!',
    last_name: 'Петрова',
    first_name: 'Мария',
    middle_name: 'Сергеевна',
    teacher_groups: ['[Демо] ПИ-21', '[Демо] ПИ-22', '[Демо] ВЕБ-21'],
    subject: { title: '[Демо] Русский язык', description: 'Орфография, пунктуация, культура речи.' },
    lecture_files: ['test.pptx', 'test.txt'],
    assignment_files: ['test.pdf'],
    submission_files: ['test.txt', 'test.docx'],
  },
  {
    role: 'teacher',
    login: 'sidorov@demo.local',
    password: 'Demo2026!',
    last_name: 'Сидоров',
    first_name: 'Алексей',
    middle_name: 'Владимирович',
    teacher_groups: ['[Демо] ИС-22', '[Демо] ПИ-22', '[Демо] ВЕБ-21'],
    subject: { title: '[Демо] История', description: 'История России и всеобщая история.' },
    lecture_files: ['test.docx', 'test.zip'],
    assignment_files: ['test.docx', 'test.pdf'],
    submission_files: ['test.pdf', 'test.png'],
  },
  {
    role: 'teacher',
    login: 'kuznetsova@demo.local',
    password: 'Demo2026!',
    last_name: 'Кузнецова',
    first_name: 'Анна',
    middle_name: 'Петровна',
    teacher_groups: ['[Демо] ИС-21', '[Демо] ПИ-21', '[Демо] ВЕБ-21'],
    subject: { title: '[Демо] Физика', description: 'Механика, термодинамика, электричество.' },
    lecture_files: ['test.pdf', 'test.pptx'],
    assignment_files: ['test.pdf'],
    submission_files: ['test.jpg', 'test.jpeg'],
  },
  {
    role: 'teacher',
    login: 'morozov@demo.local',
    password: 'Demo2026!',
    last_name: 'Морозов',
    first_name: 'Никита',
    middle_name: 'Олегович',
    teacher_groups: ['[Демо] ИС-22', '[Демо] ПИ-22', '[Демо] ВЕБ-21'],
    subject: { title: '[Демо] Веб-разработка', description: 'HTML, CSS, JavaScript, основы backend.' },
    lecture_files: ['test.pptx', 'test.zip', 'test.txt'],
    assignment_files: ['test.pdf', 'test.docx'],
    submission_files: ['test.zip', 'test.txt'],
  },

  // ─── Студенты ───
  {
    role: 'student',
    login: 'smirnov@demo.local',
    password: 'Demo2026!',
    last_name: 'Смирнов',
    first_name: 'Дмитрий',
    middle_name: 'Андреевич',
    group: '[Демо] ИС-21',
  },
  {
    role: 'student',
    login: 'volkova@demo.local',
    password: 'Demo2026!',
    last_name: 'Волкова',
    first_name: 'Екатерина',
    middle_name: 'Игоревна',
    group: '[Демо] ИС-22',
  },
  {
    role: 'student',
    login: 'morozova@demo.local',
    password: 'Demo2026!',
    last_name: 'Морозова',
    first_name: 'Алина',
    middle_name: 'Сергеевна',
    group: '[Демо] ПИ-21',
  },
  {
    role: 'student',
    login: 'novikova@demo.local',
    password: 'Demo2026!',
    last_name: 'Новикова',
    first_name: 'Ольга',
    middle_name: 'Дмитриевна',
    group: '[Демо] ПИ-22',
  },
  {
    role: 'student',
    login: 'sokolov@demo.local',
    password: 'Demo2026!',
    last_name: 'Соколов',
    first_name: 'Артём',
    middle_name: 'Максимович',
    group: '[Демо] ВЕБ-21',
  },
];

function demoUsersByRole(role) {
  return DEMO_USERS.filter((u) => u.role === role);
}

function findDemoUser(role, login) {
  const l = String(login || '').trim();
  if (!l) return null;
  return DEMO_USERS.find((u) => u.role === role && u.login === l) || null;
}

function fullName(u) {
  if (!u) return '';
  return [u.last_name, u.first_name, u.middle_name].filter(Boolean).join(' ');
}

module.exports = {
  DEMO_GROUPS,
  DEMO_USERS,
  demoUsersByRole,
  findDemoUser,
  fullName,
};