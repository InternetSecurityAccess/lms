// utils/quiz.js
'use strict';

/* ═══════════════════════════════════════════════════════════
   Логика подсистемы тестирования (Quiz).

   Здесь только чистые функции без БД и express:
     • shuffle              — перемешивание (Фишер-Йетс);
     • scoreQuestion        — баллы за один вопрос;
     • buildAttempt         — сборка попытки (всегда мешает);
     • validateQuizPayload  — валидация перед сохранением/публикацией;
     • parseImportText      — парсер импорта из текста;
     • stripMd              — срезание markdown-разметки.
   ═══════════════════════════════════════════════════════════ */

// ─── Перемешивание ───
function shuffle(arr) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Подсчёт баллов за вопрос ───
// question: { type, points, options: [{ id, is_correct, position }] }
// selectedIds: массив option.id. Для ordering — порядок важен.
function scoreQuestion(question, selectedIds) {
  const opts = Array.isArray(question.options) ? question.options : [];
  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  const points = Number(question.points) > 0 ? Number(question.points) : 1;

  if (question.type === 'single') {
    const correct = opts.find((o) => o.is_correct);
    if (!correct) return 0;
    return (selected.length === 1 && selected[0] === correct.id) ? points : 0;
  }

  if (question.type === 'multiple') {
    const correctIds = new Set(opts.filter((o) => o.is_correct).map((o) => o.id));
    if (correctIds.size === 0) return 0;
    const sel = new Set(selected);
    let good = 0;
    let bad = 0;
    for (const id of sel) {
      if (correctIds.has(id)) good++;
      else bad++;
    }
    const ratio = Math.max(0, (good - bad) / correctIds.size);
    return ratio * points;
  }

  if (question.type === 'ordering') {
    const correctOrder = opts
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((o) => o.id);
    if (correctOrder.length === 0) return 0;
    let hits = 0;
    for (let i = 0; i < correctOrder.length; i++) {
      if (selected[i] === correctOrder[i]) hits++;
    }
    return (hits / correctOrder.length) * points;
  }

  return 0;
}

// ─── Сборка попытки ───
// Всё перемешивается всегда: вопросы, варианты, элементы ordering.
// Снимок сохраняется в попытке, чтобы перезагрузка не меняла порядок.
function buildAttempt(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const order = shuffle(list.map((q) => q.id));
  const optionOrders = {};
  for (const q of list) {
    optionOrders[q.id] = shuffle((q.options || []).map((o) => o.id));
  }
  const maxScore = list.reduce(
    (s, q) => s + (Number(q.points) > 0 ? Number(q.points) : 1),
    0
  );
  return { order, optionOrders, maxScore };
}

// ─── Валидация ───
// payload: {
//   title, description, pass_percent, max_attempts, time_limit_minutes,
//   show_correct, questions: [{ text, type, points, image_stored_name,
//     options: [{ text, is_correct, position, image_stored_name }] }]
// }
// forPublish = true — дополнительно проверяем, что тест можно открыть.
function validateQuizPayload(payload, { forPublish = false } = {}) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['Некорректные данные теста'] };
  }

  const title = String(payload.title || '').trim();
  if (!title) errors.push('Название теста не может быть пустым');

  const passPercent = Number(payload.pass_percent);
  if (!Number.isFinite(passPercent) || passPercent < 0 || passPercent > 100) {
    errors.push('Проходной балл должен быть числом от 0 до 100');
  }

  const maxAttempts = Number(payload.max_attempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
    errors.push('Лимит попыток должен быть целым неотрицательным числом (0 = без ограничений)');
  }

  const timeLimit = payload.time_limit_minutes;
  if (timeLimit != null && timeLimit !== '') {
    const n = Number(timeLimit);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push('Лимит времени должен быть положительным числом или пустым');
    }
  }

  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (questions.length === 0) {
    errors.push('Тест должен содержать хотя бы один вопрос');
  }

  questions.forEach((q, qi) => {
    const qnum = qi + 1;
    const text = String(q.text || '').trim();
    const hasImage = !!(q.image_stored_name && String(q.image_stored_name).length);
    if (!text && !hasImage) {
      errors.push(`Вопрос ${qnum}: заполните текст или добавьте картинку`);
    }
    if (!['single', 'multiple', 'ordering'].includes(q.type)) {
      errors.push(`Вопрос ${qnum}: недопустимый тип`);
    }
    const points = Number(q.points);
    if (!Number.isInteger(points) || points < 1) {
      errors.push(`Вопрос ${qnum}: баллы должны быть целым положительным числом`);
    }

    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length < 2) {
      errors.push(`Вопрос ${qnum}: нужно минимум 2 варианта ответа`);
    }

    opts.forEach((o, oi) => {
      const onum = oi + 1;
      const otext = String(o.text || '').trim();
      const oimage = !!(o.image_stored_name && String(o.image_stored_name).length);
      if (!otext && !oimage) {
        errors.push(`Вопрос ${qnum}, вариант ${onum}: заполните текст или добавьте картинку`);
      }
    });

    if (forPublish) {
      if (q.type === 'single' || q.type === 'multiple') {
        const correctCount = opts.filter((o) => o.is_correct).length;
        if (correctCount === 0) {
          errors.push(`Вопрос ${qnum}: не отмечен правильный вариант`);
        }
        if (q.type === 'single' && correctCount > 1) {
          errors.push(`Вопрос ${qnum}: для типа «один вариант» должен быть ровно один правильный`);
        }
      }
      if (q.type === 'ordering') {
        const positions = opts
          .map((o) => Number(o.position))
          .filter((n) => Number.isFinite(n));
        const unique = new Set(positions);
        if (unique.size !== positions.length) {
          errors.push(`Вопрос ${qnum}: позиции вариантов не должны повторяться`);
        }
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

// ─── Импорт из текста ───
// Формат:
//   Вопрос 1: <текст>
//   1. <вариант>
//   2. <вариант>
//   ...
//   (пустая строка)
//   Вопрос 2: ...
function stripMd(line) {
  return String(line)
    .replace(/^\s*[*_`]+\s*/, '')
    .replace(/\s*[*_`]+\s*$/, '');
}

function parseImportText(text) {
  const errors = [];
  const questions = [];

  const rawLines = String(text || '').split(/\r?\n/);
  const lines = rawLines.map(stripMd);

  const questionRe = /^(?:вопрос|question)\b\s*(\d*)\s*[.:)-]?\s*(.*)$/i;
  const optionRe = /^\s*(\d+)\s*[.):\-]\s*(.+)$/;

  let current = null;
  let lastLineNo = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    lastLineNo = i + 1;
    const line = raw.trim();
    if (!line) continue;

    const qm = line.match(questionRe);
    if (qm) {
      if (current) questions.push(current);
      current = { text: String(qm[2] || '').trim(), options: [], line: lastLineNo };
      continue;
    }

    const om = line.match(optionRe);
    if (om) {
      if (!current) {
        errors.push(`Строка ${lastLineNo}: вариант ответа вне вопроса`);
        continue;
      }
      current.options.push(String(om[2] || '').trim());
      continue;
    }

    if (current) {
      if (current.options.length === 0) {
        current.text += (current.text ? ' ' : '') + line;
      } else {
        const lastIdx = current.options.length - 1;
        current.options[lastIdx] += ' ' + line;
      }
    } else {
      errors.push(`Строка ${lastLineNo}: не удалось разобрать`);
    }
  }

  if (current) questions.push(current);

  if (questions.length === 0) {
    errors.push('Не найдено ни одного вопроса');
  }

  questions.forEach((q, i) => {
    const qnum = i + 1;
    if (!q.text) {
      errors.push(`Вопрос ${qnum}: пустой текст`);
    }
    if (q.options.length < 2) {
      errors.push(`Вопрос ${qnum}: нужно минимум 2 варианта`);
    }
    q.options.forEach((o, j) => {
      if (!o) {
        errors.push(`Вопрос ${qnum}, вариант ${j + 1}: пустой текст`);
      }
    });
  });

  return { ok: errors.length === 0, errors, questions };
}

module.exports = {
  shuffle,
  scoreQuestion,
  buildAttempt,
  validateQuizPayload,
  parseImportText,
  stripMd,
};