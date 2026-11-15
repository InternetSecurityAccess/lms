// routes/student/works.js
'use strict';
const express = require('express');
const router = express.Router();

// Рефакторинг: маршруты разнесены по модулям в works/.
// Порядок подключения = исходный порядок объявления (важно для совпадений путей).
router.use(require('./works/inbox'));
router.use(require('./works/submission'));
router.use(require('./works/assignment-view'));
router.use(require('./works/archive'));
router.use(require('./works/submit'));

module.exports = router;
