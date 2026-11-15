// routes/teacher/index.js
'use strict';
const express = require('express');
const router = express.Router();

router.use(require('./home'));
router.use(require('./people'));
// ВАЖНО: quiz идёт ДО content. Он перехватывает:
//   GET  /subjects/:sid/topics/new?assignment_mode=quiz
//   GET  /subjects/:sid/topics/:tid/edit   (если у темы есть quiz_id)
//   GET  /subjects/:sid/topics/:tid        (редирект на результаты)
//   POST /subjects/:sid/topics[/:tid]?quiz=1
// Всё остальное уходит в content.js через next().
router.use(require('./quiz'));
router.use(require('./content'));
router.use(require('./works'));
router.use(require('./messages'));
router.use(require('./trash'));

module.exports = router;