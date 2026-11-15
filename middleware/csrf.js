'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function reject(req, res, reason) {
  console.warn('[CSRF] Request blocked:', {
    method: req.method,
    path: req.originalUrl,
    origin: req.get('origin') || null,
    referer: req.get('referer') || null,
    secFetchSite: req.get('sec-fetch-site') || null,
    reason,
  });
  res.set('Cache-Control', 'no-store');
  if (req.accepts(['json', 'html']) === 'json') {
    return res.status(403).json({
      error: 'csrf_rejected',
      message: 'Запрос отклонён проверкой безопасности.',
    });
  }
  return res.status(403).render('common/error', {
    title: 'Доступ запрещён',
    message: 'Запрос отклонён проверкой безопасности. Обновите страницу и повторите действие.',
  });
}

function getExpectedOrigin(req) {
  const host = req.get('host');
  if (!host) return null;
  try {
    const url = new URL(`${req.protocol}://${host}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function parseSource(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  const referer = req.get('referer');
  const fetchSite = req.get('sec-fetch-site');
  const expectedOrigin = getExpectedOrigin(req);

  if (!expectedOrigin) {
    return reject(req, res, 'expected_origin_unavailable');
  }

  if (origin === 'null') {
    if (IS_PRODUCTION) {
      return reject(req, res, 'null_origin_in_production');
    }
    if (fetchSite !== 'same-origin') {
      return reject(req, res, 'null_origin_not_same_origin');
    }
    if (referer) {
      const parsedReferer = parseSource(referer);
      if (!parsedReferer || parsedReferer !== expectedOrigin) {
        return reject(req, res, 'referer_mismatch');
      }
    }
    return next();
  }

  if (!origin && !referer) {
    return reject(req, res, 'source_headers_missing');
  }

  if (origin) {
    const parsedOrigin = parseSource(origin);
    if (!parsedOrigin || parsedOrigin !== expectedOrigin) {
      return reject(req, res, 'origin_mismatch');
    }
  }

  if (referer) {
    const parsedReferer = parseSource(referer);
    if (!parsedReferer || parsedReferer !== expectedOrigin) {
      return reject(req, res, 'referer_mismatch');
    }
  }

  return next();
}

module.exports = csrfProtection;