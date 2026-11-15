// utils/timezone.js
'use strict';

/**
 * Работа с часовыми поясами без зависимостей.
 * Использует Intl.DateTimeFormat — встроен в Node.js, работает
 * детерминированно, TZ сервера не влияет.
 */

function getTzOffsetHours(timeZone, date) {
  const d = date instanceof Date ? date : new Date();
  if (Number.isNaN(d.getTime())) return 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = dtf.formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const asUTC = Date.UTC(
      +get('year'), +get('month') - 1, +get('day'),
      +get('hour'), +get('minute'), +get('second')
    );
    return (asUTC - d.getTime()) / 3600000;
  } catch {
    return 0;
  }
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return true;
  } catch {
    return false;
  }
}

/**
 * 'YYYY-MM-DD HH:MM:SS' (UTC-строка из БД) → части локального времени в TZ.
 * @returns {{y:number,mo:number,d:number,h:number,mi:number}|null}
 */
function utcToLocalParts(value, timeZone) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const utcDate = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  if (Number.isNaN(utcDate.getTime())) return null;
  const offset = getTzOffsetHours(timeZone, utcDate);
  const local = new Date(utcDate.getTime() + offset * 3600000);
  return {
    y: local.getUTCFullYear(),
    mo: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    h: local.getUTCHours(),
    mi: local.getUTCMinutes(),
  };
}

/**
 * Части локального времени в TZ → 'YYYY-MM-DD HH:MM:SS' (UTC-строка в БД).
 */
function localPartsToUtc(y, mo, d, h, mi, timeZone) {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = getTzOffsetHours(timeZone, new Date(utcGuess));
  const utc = new Date(utcGuess - offset * 3600000);
  if (Number.isNaN(utc.getTime())) return null;
  return utc.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  getTzOffsetHours,
  isValidTimeZone,
  utcToLocalParts,
  localPartsToUtc,
};