'use strict';
const filesPolicy = require('../config/files');

function getExt(fileName) {
  return filesPolicy.extOf(fileName);
}
function getMimeType(fileName) {
  return filesPolicy.getMimeType(fileName);
}
function getPreviewCategory(fileName) {
  return filesPolicy.getPreviewCategory(fileName);
}
function canPreview(fileName) {
  return filesPolicy.canPreview(fileName);
}

module.exports = {
  getExt, getMimeType, getPreviewCategory, canPreview,
  PREVIEWABLE_EXTENSIONS: filesPolicy.PREVIEWABLE_EXTENSIONS,
};