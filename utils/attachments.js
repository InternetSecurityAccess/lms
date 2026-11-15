// utils/attachments.js
'use strict';

const db = require('../database');

const VALID_KINDS = new Set(['submission', 'topic', 'assignment']);

function listAttachments(kind, ownerId) {
  if (!VALID_KINDS.has(kind)) throw new Error(`Invalid attachment kind: ${kind}`);
  return db.prepare(`
    SELECT id, filename, stored_name, filesize, position, uploaded_at
    FROM attachments
    WHERE owner_kind = ? AND owner_id = ?
    ORDER BY position ASC, id ASC
  `).all(kind, Number(ownerId));
}

function getAttachment(id) {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
}

function addAttachment(kind, ownerId, { stored_name, filename, filesize }) {
  if (!VALID_KINDS.has(kind)) throw new Error(`Invalid attachment kind: ${kind}`);
  const pos = (db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM attachments WHERE owner_kind = ? AND owner_id = ?'
  ).get(kind, Number(ownerId)) || { p: 0 }).p;

  const r = db.prepare(`
    INSERT INTO attachments
      (owner_kind, owner_id, stored_name, filename, filesize, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kind, Number(ownerId), stored_name, filename, filesize || 0, pos);

  return Number(r.lastInsertRowid);
}

function removeAttachment(id) {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
  if (!a) return null;
  db.prepare('DELETE FROM attachments WHERE id = ?').run(Number(id));
  return a;
}

function deleteAllAttachments(kind, ownerId) {
  return db.prepare(
    'DELETE FROM attachments WHERE owner_kind = ? AND owner_id = ?'
  ).run(kind, Number(ownerId));
}

function attachmentsTotalSize(kind, ownerId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(filesize), 0) AS total
    FROM attachments
    WHERE owner_kind = ? AND owner_id = ?
  `).get(kind, Number(ownerId));
  return Number(row?.total || 0);
}

module.exports = {
  VALID_KINDS,
  listAttachments,
  getAttachment,
  addAttachment,
  removeAttachment,
  deleteAllAttachments,
  attachmentsTotalSize,
};