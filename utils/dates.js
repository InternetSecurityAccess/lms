// utils/dates.js
'use strict';

/**
 * Утилиты для работы с датами в SQLite.
 *
 * SQLite хранит даты как TEXT и сравнивает лексикографически.
 * Поэтому критично, чтобы ВСЕ даты в БД имели одинаковый формат:
 *   YYYY-MM-DD HH:MM:SS   (UTC, без миллисекунд, без 'T', без 'Z')
 *
 * CURRENT_TIMESTAMP в SQLite выдаёт именно такой формат.
 * new Date().toISOString() выдаёт 'YYYY-MM-DDTHH:mm:ss.sssZ' — ДРУГОЙ формат,
 * который при сравнении с CURRENT_TIMESTAMP даёт неверный порядок
 * ('T' = 0x54 > ' ' = 0x20, поэтому в пределах одного дня ISO-строка
 * сортируется ПОСЛЕ всех SQL-строк с той же датой).
 *
 * Правило проекта: любая запись даты в БД должна использовать
 * либо CURRENT_TIMESTAMP в SQL, либо nowSql() из этого модуля.
 * new Date().toISOString() для записи в БД — запрещён.
 */

/**
 * @param {Date} [date] — если не указано, берётся текущее
 * @returns {string} 'YYYY-MM-DD HH:MM:SS' (UTC)
 */
function toSqlDate(date) {
  const d = date instanceof Date ? date : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function nowSql() {
  return toSqlDate(new Date());
}

/**
 * Парсит дату из БД как UTC. Для 'YYYY-MM-DD HH:MM:SS' (и с .SSS)
 * добавляет 'T' и 'Z', чтобы JS не трактовал её как local.
 * Для ISO-строк работает стандартный new Date().
 */
function parseSqlDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { toSqlDate, nowSql, parseSqlDate };