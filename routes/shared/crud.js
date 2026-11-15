'use strict';

const { handler, redirectWith, notFound, audit } = require('./handlers');

function makeArchiveToggle(opts) {
  return handler((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return notFound(res);
    const row = opts.getRow(id);
    if (!row) return notFound(res);

    const target = opts.targetOf
      ? opts.targetOf(row)
      : (row[opts.column] ? null : 'archived');
    if (target === null) return redirectWith(res, opts.redirect(req), { done: 1 });

    opts.apply(id, target);
    if (opts.cascadeAfter) opts.cascadeAfter(id, target);
    audit(req, opts.auditAction(target), opts.kind, id, {});
    return redirectWith(res, opts.redirect(req), { done: 1 });
  });
}

function makeDelete(opts) {
  return handler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return notFound(res);
    const row = opts.getRow(id);
    if (!row) return notFound(res);

    if (opts.cleanupFiles) await opts.cleanupFiles(row, id);
    opts.remove(id);
    audit(req, opts.auditAction, opts.kind, id,
      opts.auditDetails ? opts.auditDetails(row) : {});
    return redirectWith(res, opts.redirect(req), { done: 1 });
  });
}

module.exports = { makeArchiveToggle, makeDelete };