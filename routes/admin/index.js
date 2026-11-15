'use strict';
const express = require('express');
const router = express.Router();

router.use(require('./home'));
router.use(require('./account'));
router.use(require('./people'));
router.use(require('./groups'));
router.use(require('./content'));
router.use(require('./works'));
router.use(require('./messages'));
router.use(require('./settings'));
router.use(require('./system'));
router.use(require('./import-export'));
router.use(require('./trash'));   // ← новый
router.use(require('./bulk'));

module.exports = router;