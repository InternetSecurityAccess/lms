// routes/shared/lists.js
'use strict';

/* ═══════════════════════════════════════════════════════════
   API этой фазы:
     • normalizeStatus — ввод пользователя → 'active'|'finished'|'all'
     • statusWhere     — SQL-фрагмент по колонке status
     • deletedWhere    — SQL-фрагмент по колонке deleted_at
     • normalizeSort / paginate / normalizePeriod — без изменений

   Удалено:
     • normalizeArchived, archivedWhere  — оперировали archived_at,
       которого в новой схеме нет. Роуты, использующие их
       (routes/admin/*, routes/teacher/*, routes/student/*),
       переписываются в фазах 4-6.
   ═══════════════════════════════════════════════════════════ */

const normalizeStatus = (v) =>
  ['active', 'finished', 'all'].includes(v) ? v : 'active';

// statusWhere('s.status', 'active')   → " AND s.status = 'active'"
// statusWhere('s.status', 'finished') → " AND s.status = 'finished'"
// statusWhere('s.status', 'all')      → ""
const statusWhere = (column, mode) => {
  if (mode === 'finished') return ` AND ${column} = 'finished'`;
  if (mode === 'all') return '';
  return ` AND ${column} = 'active'`;
};

// deletedWhere('s.deleted_at', 'no')   → " AND s.deleted_at IS NULL"
// deletedWhere('s.deleted_at', 'yes')  → " AND s.deleted_at IS NOT NULL"
// deletedWhere('s.deleted_at', 'all')  → ""
const deletedWhere = (column, mode) => {
  if (mode === 'yes') return ` AND ${column} IS NOT NULL`;
  if (mode === 'all') return '';
  return ` AND ${column} IS NULL`;
};

const normalizeSort = (
  v,
  allowed = ['date_desc', 'date_asc', 'name_asc', 'name_desc', 'status'],
  def
) => allowed.includes(v) ? v : (def || allowed[0]);

const normalizePeriod = (v) =>
  ['all', 'week', 'month', 'today'].includes(v) ? v : 'all';

const periodWhere = (column, period) => {
  if (period === 'today') return ` AND ${column} >= datetime('now', 'start of day')`;
  if (period === 'week') return ` AND ${column} >= datetime('now', '-7 days')`;
  if (period === 'month') return ` AND ${column} >= datetime('now', '-30 days')`;
  return '';
};

function paginate(rawPage, total, pageSize = 50) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(Number(rawPage) || 1, pages));
  return { page, pages, offset: (page - 1) * pageSize, limit: pageSize };
}

module.exports = {
  normalizeStatus, statusWhere, deletedWhere,
  normalizeSort, normalizePeriod, periodWhere,
  paginate,
};