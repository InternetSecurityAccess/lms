'use strict';
const express = require('express');
const router = express.Router();

router.use(require('./home'));
router.use(require('./people'));
// quiz ДО content: перехватывает клик «Открыть» по теме-тесту
// (/t/:tid/subjects/:sid/topics/:topicId) и редиректит на страницу теста.
router.use(require('./quiz'));
router.use(require('./content'));
router.use(require('./works'));
router.use(require('./messages'));
router.use(require('./account'));

module.exports = router;