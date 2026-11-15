'use strict';

module.exports = function clientInfoMiddleware(req, res, next) {
  const rawIp = req.ip || req.socket?.remoteAddress || 'unknown';
  req.clientIp = String(rawIp).replace(/^::ffff:/, '');
  req.clientPcName = req.clientIp;
  req.clientUserAgent = String(req.get('user-agent') || 'unknown').slice(0, 500);
  next();
};