'use strict';
const express = require('express');
const router = express.Router();

const modules = [
  './public',
  './auth',
  './api',
  // Quiz-картинки: /quiz/upload-image, /file/quiz-image/...
  // Ставим ДО ./files, чтобы /file/:kind/:id не перехватывал префикс.
  './quiz-image',
  './files',
  './shared/profile',
  './support',
  './student',
  './teacher',
  './admin',
];

const isProduction = process.env.NODE_ENV === 'production';

for (const mod of modules) {
  try {
    router.use(require(mod));
    console.log(`[routes] Подключён ${mod}`);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(mod)) {
      console.warn(`[routes] Пропущен ${mod} — модуль ещё не создан`);
      continue;
    }
    console.error(`[routes] Ошибка загрузки ${mod}:`, e);
    if (isProduction) throw e;
    throw e;
  }
}

module.exports = router;