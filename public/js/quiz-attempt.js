// public/js/quiz-attempt.js
// Логика страницы прохождения теста (views/student/quiz/quiz-attempt.ejs).
// Контракт DOM:
//   form#quiz-attempt-form  — форма с action .../quiz/attempt/:id/submit
//                             и скрытым полем input[name="answers_json"]
//   .quiz-q[data-qid][data-qtype] — блок вопроса
//   input[name="q_<qid>"][value=<oid>] — варианты single/multiple
//   .quiz-ordering-item[data-oid] — элементы порядка (полный набор всегда)
//   button[data-action="finish"] — кнопка завершения
//   #quiz-confirm-dialog + #quiz-confirm-text + [data-action="confirm"|"cancel"]
//   .quiz-timer[data-limit][data-started] — таймер (hidden до рассчёта)
(() => {
  'use strict';

  const form = document.getElementById('quiz-attempt-form');
  if (!form) return; // страница не прохождения теста — молча выходим

  const attemptSubmitUrl = form.getAttribute('action');
  const answersInput = form.querySelector('input[name="answers_json"]');
  const finishBtn = form.querySelector('button[data-action="finish"]');
  const timerEl = document.querySelector('.quiz-timer');

  let submitting = false;
  let submitted = false; // попытка ещё не завершена — кнопка «Завершить тест» должна работать

  function questionBlocks() {
    return Array.from(form.querySelectorAll('.quiz-q'));
  }

  // ─── Сборка ответов в канонический формат сервера ───
  // { "<questionId>": [<optionId>, ...], ... }
  // ordering всегда содержит полный набор id в текущем порядке.
  function collectAnswers() {
    const answers = {};
    for (const q of questionBlocks()) {
      const qid = q.dataset.qid;
      const type = q.dataset.qtype;
      if (type === 'single') {
        const checked = q.querySelector('input:checked');
        answers[qid] = checked ? [checked.value] : [];
      } else if (type === 'multiple') {
        answers[qid] = Array.from(q.querySelectorAll('input:checked')).map((i) => i.value);
      } else if (type === 'ordering') {
        answers[qid] = Array.from(q.querySelectorAll('.quiz-ordering-item')).map((i) => i.dataset.oid);
      }
    }
    return answers;
  }

  function isAnswered(q) {
    const type = q.dataset.qtype;
    if (type === 'single' || type === 'multiple') return !!q.querySelector('input:checked');
    if (type === 'ordering') return q.querySelectorAll('.quiz-ordering-item').length > 0;
    return false;
  }

  // ─── Счётчик «Отвечено N из M» и статусы вопросов ───
  const counterEl = document.querySelector('.quiz-counter-n');
  function refreshProgress() {
    const qs = questionBlocks();
    let answeredCount = 0;
    qs.forEach((q) => {
      const answered = isAnswered(q);
      if (answered) answeredCount++;
      const status = q.querySelector('.quiz-q-status');
      if (status) status.textContent = answered ? 'отвечен' : 'не отвечен';
      q.classList.toggle('is-answered', answered);
    });
    if (counterEl) counterEl.textContent = String(answeredCount);
  }

  form.addEventListener('change', refreshProgress);

  // ─── Аккордеон: клик по шапке вопроса раскрывает тело ───
  form.addEventListener('click', (e) => {
    const head = e.target.closest('.quiz-q-head');
    if (!head) return;
    const q = head.closest('.quiz-q');
    const body = q && q.querySelector('.quiz-q-body');
    if (!q || !body) return;
    const open = q.dataset.open === '1';
    q.dataset.open = open ? '0' : '1';
    body.hidden = open;
  });

  // ─── Up/down для вопросов с упорядочиванием ───
  form.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="up"], button[data-action="down"]');
    if (!btn) return;
    const item = btn.closest('.quiz-ordering-item');
    const list = item && item.parentElement;
    if (!item || !list) return;
    if (btn.dataset.action === 'up' && item.previousElementSibling) {
      list.insertBefore(item, item.previousElementSibling);
    } else if (btn.dataset.action === 'down' && item.nextElementSibling) {
      list.insertBefore(item.nextElementSibling, item);
    }
    // обновить нумерацию и disabled-состояния кнопок
    Array.from(list.children).forEach((el, idx) => {
      const num = el.querySelector('.quiz-ordering-num');
      if (num) num.textContent = String(idx + 1);
      const up = el.querySelector('button[data-action="up"]');
      const down = el.querySelector('button[data-action="down"]');
      if (up) up.disabled = idx === 0;
      if (down) down.disabled = idx === list.children.length - 1;
    });
    refreshProgress();
  });

  // ─── Собственное модальное подтверждение завершения ───
  const dialog = document.getElementById('quiz-confirm-dialog');
  const dialogText = document.getElementById('quiz-confirm-text');

  function confirmFinish(message) {
    return new Promise((resolve) => {
      if (!dialog || !dialogText) return resolve(window.confirm(message));
      dialogText.textContent = message;
      dialog.hidden = false;
      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKey = (ev) => { if (ev.key === 'Escape') cleanup(false); };
      function cleanup(result) {
        dialog.hidden = true;
        okBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      const okBtn = dialog.querySelector('button[data-action="confirm"]');
      const cancelBtn = dialog.querySelector('button[data-action="cancel"]');
      okBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  // ─── Отправка попыток (fetch + JSON, как ждёт сервер) ───
  async function postSubmit(answers) {
    const res = await fetch(attemptSubmitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ answers_json: JSON.stringify(answers) }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* html-ответ (redirect/error) */ }
    if (res.ok && data && data.redirectUrl) return data.redirectUrl;
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      return res.headers.get('location');
    }
    if (res.ok) return attemptSubmitUrl.replace(/\/submit$/, '/result');
    const msg = (data && (data.message || data.error)) || 'Не удалось отправить ответы.';
    throw new Error(msg);
  }

  async function finishAttempt() {
    if (submitting || submitted) return;
    const qs = questionBlocks();
    const unanswered = qs
      .filter((q) => !isAnswered(q))
      .map((q) => String(qs.indexOf(q) + 1));
    const message = unanswered.length > 0
      ? `Вы ответили на ${qs.length - unanswered.length} из ${qs.length} вопросов. Без ответа: ${unanswered.join(', ')}. После завершения изменить ответы нельзя.`
      : 'Вы ответили на все вопросы. После завершения изменить ответы нельзя.';

    const ok = await confirmFinish(message);
    if (!ok) return;

    submitting = true;
    if (finishBtn) { finishBtn.disabled = true; finishBtn.textContent = 'Отправка...'; }
    try {
      const redirectUrl = await postSubmit(collectAnswers());
      submitted = true;
      window.location.href = redirectUrl;
    } catch (err) {
      alert(err.message || 'Ошибка отправки.');
      submitting = false;
      if (finishBtn) { finishBtn.disabled = false; finishBtn.textContent = 'Завершить тест'; }
    }
  }

  if (finishBtn) {
    finishBtn.addEventListener('click', (e) => {
      e.preventDefault();
      finishAttempt();
    });
  }

  // ─── Таймер ───
  // started_at хранится в БД как UTC без маркера ('YYYY-MM-DD HH:MM:SS'),
  // поэтому парсим вручную через Date.UTC.
  function parseSqlUtc(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  let deadlineMs = null;
  if (timerEl) {
    const limitMin = Number(timerEl.dataset.limit) || 0;
    const startedMs = parseSqlUtc(timerEl.dataset.started);
    if (limitMin > 0 && startedMs) {
      deadlineMs = startedMs + limitMin * 60000;
      timerEl.hidden = false;
    }
  }

  let timerInterval = null;
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  async function autoSubmitOnExpire() {
    stopTimer();
    if (submitted || submitting) return;
    submitting = true;
    form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    try {
      const redirectUrl = await postSubmit(collectAnswers());
      submitted = true;
      window.location.href = redirectUrl;
    } catch {
      // сервер сам закроет просроченную попытку при следующем открытии
      submitting = false;
    }
  }

  if (timerEl && deadlineMs) {
    const updateTimer = () => {
      const diff = deadlineMs - Date.now();
      if (diff <= 0) {
        timerEl.textContent = '00:00';
        timerEl.classList.add('danger');
        autoSubmitOnExpire();
        return;
      }
      const mins = Math.floor(diff / 60000).toString().padStart(2, '0');
      const secs = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
      timerEl.textContent = `${mins}:${secs}`;
      if (diff < 300000) timerEl.classList.add('warning');
      if (diff < 60000) timerEl.classList.add('danger');
    };
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  }

  // ─── Предупреждение при уходе с несохранёнными ответами ───
  window.addEventListener('beforeunload', (e) => {
    if (submitted) return;
    const hasAnswers = Object.values(collectAnswers()).some((a) => a.length > 0);
    if (!hasAnswers) return;
    e.preventDefault();
    e.returnValue = '';
  });

  refreshProgress();
})();
