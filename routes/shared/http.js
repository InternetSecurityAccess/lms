'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fixFilename, encodeFilename } = require('../../utils/helpers');
const { getMimeType, getPreviewCategory, getExt } = require('../../utils/mime');

function sendFile(req, res, next, absPath, displayName) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).send('Файл не найден.');

    const originalName = fixFilename(displayName || 'file');
    const safeName = path.basename(originalName);
    const ext = getExt(safeName);
    const previewCategory = getPreviewCategory(safeName);
    const inline = req.query.inline === '1';
    const canInline = !!previewCategory;

    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (inline && canInline) {
      res.setHeader('Content-Type', getMimeType(safeName));
      res.setHeader(
        'Content-Disposition',
        `inline; filename="file${ext}"; filename*=UTF-8''${encodeFilename(safeName)}`
      );
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(absPath);
      stream.on('error', next);
      return stream.pipe(res);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="download"; filename*=UTF-8''${encodeFilename(safeName)}`
    );
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(absPath);
    stream.on('error', next);
    return stream.pipe(res);
  });
}

module.exports = { sendFile };