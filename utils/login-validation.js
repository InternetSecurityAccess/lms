'use strict';

const config = require('../config');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STUDENT_ID_CHARS_RE = /^[A-Za-zА-Яа-яЁё0-9._/-]+$/;

function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

function validateStudentId(login) {
  const s = String(login || '').trim();
  if (s.length === 0) return 'Укажите логин.';
  if (s.length < 3) return 'Логин слишком короткий (минимум 3 символа).';
  if (s.length > 50) return 'Логин слишком длинный (максимум 50 символов).';
  if (/\s/.test(s)) return 'Логин не должен содержать пробелы.';
  if (s.includes('@')) return 'Логин не должен содержать @.';
  if (!STUDENT_ID_CHARS_RE.test(s)) {
    return 'Логин может содержать только буквы, цифры, точку, дефис, подчёркивание и слэш.';
  }
  if (s.startsWith('.') || s.endsWith('.')) {
    return 'Логин не должен начинаться или заканчиваться точкой.';
  }
  if (s.includes('..')) return 'Логин не должен содержать две точки подряд.';
  return null;
}

function validateStudentEmail(login) {
  const s = String(login || '').trim();
  if (!s) return 'Укажите email.';
  if (!isValidEmail(s)) return 'Введите корректный email.';
  if (s.length > 200) return 'Email слишком длинный (максимум 200 символов).';
  return null;
}

function validateStudentLoginAuto(login) {
  if (typeof login !== 'string') return 'Укажите логин.';
  const s = login.trim();
  if (!s) return 'Укажите логин.';
  return s.includes('@') ? validateStudentEmail(s) : validateStudentId(s);
}

function validateStudentLoginByType(login, type) {
  if (type === 'email') return validateStudentEmail(login);
  if (type === 'student_id') return validateStudentId(login);
  return validateStudentLoginAuto(login);
}

function validateStudentLogin(login) {
  if (typeof login !== 'string') return 'Укажите логин.';
  const s = login.trim();
  const mode = config.STUDENT_LOGIN_TYPE;
  if (mode === 'email') return validateStudentEmail(s);
  if (mode === 'both') {
    return s.includes('@') ? validateStudentEmail(s) : validateStudentId(s);
  }
  if (s.includes('@')) {
    return 'Похоже на email. В этом режиме вход по номеру студенческого билета (без @).';
  }
  return validateStudentId(s);
}

function validateTeacherLogin(login) {
  if (typeof login !== 'string') return 'Укажите email.';
  const s = login.trim();
  if (!isValidEmail(s)) return 'Введите корректный email.';
  return null;
}

function normalizeStudentLogin(login) {
  const s = String(login || '').trim();
  const mode = config.STUDENT_LOGIN_TYPE;
  if (mode === 'email') return s.toLowerCase();
  if (mode === 'both') return s.includes('@') ? s.toLowerCase() : s;
  if (s.includes('@')) return s.toLowerCase();
  return s;
}

function normalizeStudentLoginByType(login, type) {
  const s = String(login || '').trim();
  if (type === 'email') return s.toLowerCase();
  if (type === 'student_id') return s;
  return s.includes('@') ? s.toLowerCase() : s;
}

function normalizeStudentLoginAuto(login) {
  return normalizeStudentLoginByType(login, 'auto');
}

function normalizeTeacherLogin(login) {
  return String(login || '').trim().toLowerCase();
}

module.exports = {
  isValidEmail,
  validateStudentId, validateStudentEmail,
  validateStudentLoginAuto, validateStudentLoginByType,
  validateStudentLogin, validateTeacherLogin,
  normalizeStudentLogin, normalizeStudentLoginByType,
  normalizeStudentLoginAuto, normalizeTeacherLogin,
};