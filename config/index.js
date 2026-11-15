// config/index.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const settings = require('./settings');
const {
  DEMO_GROUPS,
  DEMO_USERS,
  demoUsersByRole,
} = require('./demo-users');

const isProduction = process.env.NODE_ENV === 'production';

function envString(name, fallback = '') {
  const v = process.env[name];
  return v != null && v !== '' ? v : fallback;
}
function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return v === 'true' || v === '1';
}
function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

function loadSessionSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    if (isProduction && fromEnv.length < 32) {
      throw new Error('SESSION_SECRET must be >= 32 chars in production.');
    }
    return fromEnv;
  }
  if (isProduction) {
    throw new Error('SESSION_SECRET is required in production.');
  }
  const secretPath = path.join(DATA_DIR, '.session-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const saved = fs.readFileSync(secretPath, 'utf8').trim();
      if (saved.length >= 32) return saved;
    }
  } catch { /* ignore */ }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    console.warn(`[config] SESSION_SECRET сгенерирован и сохранён в ${secretPath}`);
  } catch (e) {
    console.warn('[config] Не удалось сохранить SESSION_SECRET:', e.message);
  }
  return generated;
}

const sessionSecret = loadSessionSecret();

const DEMO_GROUP_NAME = DEMO_GROUPS[0];
const DEMO_TEACHER = Object.freeze(demoUsersByRole('teacher')[0]);
const DEMO_STUDENT = Object.freeze(demoUsersByRole('student')[0]);

const STORAGE_DIR = path.join(DATA_DIR, 'storage');

const config = {
  // ─── Инфраструктура (env) ───
  PORT: envInt('PORT', 3000),
  HOST: envString('HOST', '0.0.0.0'),
  IS_PRODUCTION: isProduction,
  TRUST_PROXY: envBool('TRUST_PROXY', false) ? 1 : false,
  SESSION_SECRET: sessionSecret,
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'app.db'),
  // ─── Файлы ───
  STORAGE_DIR,
  UPLOAD_DIR: STORAGE_DIR,
  CHAT_UPLOAD_DIR: path.join(STORAGE_DIR, 'chats'),
  SUPPORT_FILES_DIR: path.join(STORAGE_DIR, 'support'),
  PUBLIC_DIR: path.resolve(__dirname, '..', 'public'),
  VIEWS_DIR: path.resolve(__dirname, '..', 'views'),
  DEMO_MODE: !isProduction && envBool('DEMO_MODE', false),
  // ─── Демо-данные (создаются всегда) ───
  DEMO_GROUP_NAME,
  DEMO_TEACHER,
  DEMO_STUDENT,
  DEMO_GROUPS,
  DEMO_USERS,
  // ─── Только для первого seed первого админа (env) ───
  ADMIN_NAME: envString('ADMIN_NAME', 'admin'),
  ADMIN_PASSWORD: envString('ADMIN_PASSWORD', isProduction ? '' : 'admin123'),
};

if (isProduction && !config.ADMIN_PASSWORD) {
  console.warn('[config] ADMIN_PASSWORD не задан. Первый админ не будет создан.');
}

Object.defineProperties(config, {
  SESSION_MAX_AGE: {
    enumerable: true,
    get() {
      const h = Number(settings.get('security.sessionMaxAgeHours'));
      return (Number.isFinite(h) && h > 0 ? h : 8) * 60 * 60 * 1000;
    },
  },
  COOKIE_SECURE: {
    enumerable: true,
    get() {
      const v = settings.get('security.cookieSecure');
      if (v === null || v === undefined) return isProduction;
      return !!v;
    },
  },
  PASSWORD_LEVEL: {
    enumerable: true,
    get() { return settings.get('security.passwordLevel') || 'medium'; },
  },
  ADMIN_PASSWORD_LEVEL: {
    enumerable: true,
    get() { return settings.get('security.adminPasswordLevel') || 'strong'; },
  },
  PASSWORD_MIN_LENGTH_OVERRIDE: {
    enumerable: true,
    get() { return Number(settings.get('security.passwordMinLength')) || 0; },
  },
  STUDENT_LOGIN_TYPE: {
    enumerable: true,
    get() { return settings.get('auth.studentLoginType') || 'student_id'; },
  },
  REGISTRATION_ENABLED: {
    enumerable: true,
    get() { return !!settings.get('auth.registrationEnabled'); },
  },
  REGISTRATION_NEEDS_APPROVAL: {
    enumerable: true,
    get() { return !!settings.get('auth.registrationNeedsApproval'); },
  },
  COLLEGE: {
    enumerable: true,
    get() {
      const full = String(settings.get('college.systemFull') || '');
      return Object.freeze({
        SHORT: String(settings.get('college.short') || ''),
        SHORT_NAME: String(settings.get('college.shortName') || ''),
        NAME: String(settings.get('college.name') || ''),
        SYSTEM_NAME: String(settings.get('college.systemName') || ''),
        SYSTEM_FULL: full,
        SYSTEM_FULL_RU: full.toLowerCase(),
        ADDRESS: String(settings.get('college.address') || ''),
        PHONE: String(settings.get('college.phone') || ''),
        EMAIL: String(settings.get('college.email') || ''),
        SITE: String(settings.get('college.site') || ''),
        TZ: String(settings.get('college.timezone') || 'Asia/Irkutsk'),
      });
    },
  },
});

Object.freeze(config);
module.exports = config;