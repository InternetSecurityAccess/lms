'use strict';

function where(initial = null, params = {}) {
  const conditions = [];
  const acc = { ...params };

  const api = {
    and(clause, extra = {}, skip = false) {
      if (skip || !clause) return api;
      conditions.push(`(${clause})`);
      Object.assign(acc, extra);
      return api;
    },
    or(clauses, extra = {}) {
      if (!Array.isArray(clauses) || clauses.length === 0) return api;
      conditions.push('(' + clauses.map((c) => `(${c})`).join(' OR ') + ')');
      Object.assign(acc, extra);
      return api;
    },
    sql() { return conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''; },
    params() { return acc; },
  };

  if (initial) api.and(initial);
  return api;
}

module.exports = { where };