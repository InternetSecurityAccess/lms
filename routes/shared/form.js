'use strict';

// pickStr: обрезает строку, null/undefined → ''. Дефолтный лимит 200.
const pickStr = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// pickStrOrNull: пустая строка → null. Для FK: пустая форма должна стать
// NULL в БД, а не 0.
const pickStrOrNull = (v, max = 200) => {
  const s = pickStr(v, max);
  return s || null;
};

// pickInt: положительное целое или null.
const pickInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// pickIntOr: pickInt с fallback.
const pickIntOr = (v, fallback) => pickInt(v) ?? fallback;

// pickIntRange: целое, ограниченное [min, max]. Для счётчиков, лимитов,
// страниц. 0 разрешён, если min=0.
const pickIntRange = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.trunc(n);
};

// pickIds: массив положительных id из одиночного значения или массива.
const pickIds = (v) => {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0);
};

const pickBool = (v) => v === '1' || v === 'true' || v === true;

const requireFields = (obj, keys) => {
  for (const k of keys) {
    if (obj[k] == null || String(obj[k]).trim() === '') return k;
  }
  return null;
};

module.exports = {
  pickStr, pickStrOrNull,
  pickInt, pickIntOr, pickIntRange,
  pickIds, pickBool, requireFields,
};