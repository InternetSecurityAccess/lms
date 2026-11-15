'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const LEVEL_RULES = {
  basic: { minLength: 8, requireLetter: true, requireDigit: true, requireUpper: false, requireSpecial: false },
  medium: { minLength: 8, requireLetter: true, requireDigit: true, requireUpper: true, requireSpecial: false },
  strong: { minLength: 10, requireLetter: true, requireDigit: true, requireUpper: true, requireSpecial: true },
};
const LETTER_RE = /[A-Za-zА-Яа-яЁё]/;
const DIGIT_RE = /\d/;
const UPPER_RE = /[A-ZА-ЯЁ]/;
const SPECIAL_RE = /[^A-Za-zА-Яа-яЁё0-9]/;
function resolveRules(opts = {}) {
  const level = opts.level || config.PASSWORD_LEVEL || 'medium';
  const base = LEVEL_RULES[level] || LEVEL_RULES.medium;
  const overrideLen = Number(opts.minLength || config.PASSWORD_MIN_LENGTH_OVERRIDE || 0);
  return {
    level,
    rules: { ...base, minLength: overrideLen > 0 ? overrideLen : base.minLength },
  };
}
function validatePassword(password, opts = {}) {
  const { rules } = resolveRules(opts);
  const errors = [];
  if (typeof password !== 'string' || password.length === 0) return ['Пароль не может быть пустым.'];
  if (password.length > 200) errors.push('Пароль не должен превышать 200 символов.');
  if (password.length < rules.minLength) errors.push(`Минимум ${rules.minLength} символов.`);
  if (rules.requireLetter && !LETTER_RE.test(password)) errors.push('Должна быть хотя бы одна буква.');
  if (rules.requireDigit && !DIGIT_RE.test(password)) errors.push('Должна быть хотя бы одна цифра.');
  if (rules.requireUpper && !UPPER_RE.test(password)) errors.push('Должна быть хотя бы одна заглавная буква.');
  if (rules.requireSpecial && !SPECIAL_RE.test(password)) errors.push('Должен быть хотя бы один спецсимвол (!@#$…).');
  if (opts.login && typeof opts.login === 'string') {
    if (password.toLowerCase() === opts.login.toLowerCase()) errors.push('Пароль не должен совпадать с логином.');
  }
  return errors;
}
function isStrongEnough(password, opts = {}) { return validatePassword(password, opts).length === 0; }
function getPasswordRequirements(opts = {}) {
  const { rules } = resolveRules(opts);
  const items = [{ key: 'length', text: `Минимум ${rules.minLength} символов` }];
  if (rules.requireLetter) items.push({ key: 'letter', text: 'Хотя бы одна буква' });
  if (rules.requireDigit) items.push({ key: 'digit', text: 'Хотя бы одна цифра' });
  if (rules.requireUpper) items.push({ key: 'upper', text: 'Хотя бы одна заглавная буква' });
  if (rules.requireSpecial) items.push({ key: 'special', text: 'Хотя бы один спецсимвол (!@#$…)' });
  return items;
}
const MIN_LENGTH = resolveRules().rules.minLength;
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '!@#$%&*?-_';
function pickRandom(chars, length) {
  const out = [];
  const buf = crypto.randomBytes(length * 4);
  let i = 0;
  while (out.length < length && i < buf.length) {
    const b = buf[i++];
    if (b < 250) out.push(chars[b % chars.length]);
  }
  while (out.length < length) out.push(chars[crypto.randomInt(0, chars.length)]);
  return out.join('');
}
// Полноценный пароль с буквами/цифрами/спецсимволами по текущей политике.
// НЕ используется для временных паролей — там см. randomNumericPassword ниже.
function randomPassword(length = 0, opts = {}) {
  const { rules } = resolveRules(opts);
  const desiredLen = Math.max(length || 0, rules.minLength, 12);
  const chars = [LOWER];
  if (rules.requireUpper) chars.push(UPPER);
  if (rules.requireDigit) chars.push(DIGITS);
  if (rules.requireSpecial) chars.push(SPECIAL);
  const allChars = chars.join('');
  const parts = [];
  for (const group of chars) parts.push(pickRandom(group, 1));
  parts.push(pickRandom(allChars, desiredLen - parts.length));
  const merged = parts.join('').split('');
  for (let i = merged.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [merged[i], merged[j]] = [merged[j], merged[i]];
  }
  return merged.join('');
}
// ВРЕМЕННЫЙ пароль — только цифры. Используется ровно в двух сценариях:
//   1) админ создаёт преподавателя/студента (admin/people.js);
//   2) админ/преподаватель сбрасывает пароль (admin/people.js, teacher/people.js).
// Во всех этих местах после генерации выставляется must_change_password=1,
// и пользователь обязан сменить пароль при первом входе. На этом шаге уже
// применяется validatePassword() по политике (LEVEL_RULES выше).
//
// Почему цифры, а не randomPassword():
//   • временный пароль диктуют по телефону / показывают один раз на экране —
//     «l» vs «I» vs «1» тут хуже, чем 8–12 цифр;
//   • 8 цифр = 10^8 комбинаций; для временного пароля с принудительной сменой
//     и rate-limit на входе (5 попыток / 60 с) этого достаточно.
// Если когда-нибудь понадобится 12+ цифр — параметр length это позволяет,
// менять сигнатуру не нужно.
function randomNumericPassword(length = 8) {
  const digits = [];
  while (digits.length < length) {
    const buf = crypto.randomBytes(Math.max(16, length));
    for (const b of buf) {
      if (b < 250) {
        digits.push(b % 10);
        if (digits.length === length) break;
      }
    }
  }
  return digits.join('');
}
module.exports = {
  randomPassword, randomNumericPassword, MIN_LENGTH,
  validatePassword, isStrongEnough, getPasswordRequirements,
  resolveRules, LEVEL_RULES,
};