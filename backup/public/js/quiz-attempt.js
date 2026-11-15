// public/js/quiz-attempt.js
'use strict';

/* ═══════════════════════════════════════════════════════════
   Прохождение теста (сторона студента).

   • аккордеон: все вопросы свёрнуты на старте;
   • счётчик «Отвечено N из M» обновляется на лету;
   • индикатор «отвечено / не отвечен» в шапке каждого вопроса;
   • ordering: ↑↓ переставляют строку, номера пересчитываются;
     вопрос считается отвеченным, если пользователь хоть раз
     нажал ↑↓ (флаг data-changed);
   • таймер: если задан лимит — счётчик от attempt.started_at;
     по истечении — auto-submit без модалки;
   • «Завершить» — модалка с числом отвеченных и номерами
     неотвеченных, затем POST;
   • сбор answers_json: обход DOM, формат { "<qid>": [<oid>,...] }.
   ═══════════════════════════════════════════════════════════ */

(function () {
  const form = document.getElementById('quiz-attempt-form');
  if (!form) return;

  const questionsRoot = form.querySelector('#quiz-questions');
  const counterNEl = form.querySelector('.quiz-counter-n');
  const finishBtn = form.querySelector('[data-action="finish"]');
  const answersInput = form.querySelector('input[name="answers_json"]');
  const dialog = document.getElementById('quiz-confirm-dialog');
  const dialogText = document.getElementById('quiz-confirm-text');

  let submitted = false;

  // ─── Сбор ответов из DOM ───
  function collectAnswers() {
    const out = {};
    const all = questionsRoot.querySelectorAll('.quiz-q');
    all.forEach((qEl) => {
      const qid = qEl.dataset.qid;
      const qtype = qEl.dataset.qtype;
      const ids = [];
      if (qtype === 'single' || qtype === 'multiple') {
        qEl.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')
          .forEach((inp) => {
            const id = Number(inp.dataset.oid);
            if (Number.isInteger(id) && id > 0) ids.push(id);
          });
      } else if (qtype === 'ordering') {
        qEl.querySelectorAll('.quiz-ordering-item').forEach((it) => {
          const id = Number(it.dataset.oid);
          if (Number.isInteger(id) && id > 0) ids.push(id);
        });
      }
      out[qid] = ids;
    });
    return out;
  }

  // ─── «Отвечен ли вопрос» — для индикатора и счётчика ───
  function isAnswered(qEl) {
    const qtype = qEl.dataset.qtype;
    if (qtype === 'single' || qtype === 'multiple') {
      return !!qEl.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
    }
    if (qtype === 'ordering') {
      return qEl.dataset.changed === '1';
    }
    return false;
  }

  // ─── Счётчик и статусы ───
  function updateCounter() {
    const all = questionsRoot.querySelectorAll('.quiz-q');
    let answered = 0;
    const unansweredNums = [];
    all.forEach((qEl, i) => {
      const ok = isAnswered(qEl);
      if (ok) answered++;
      else unansweredNums.push(i + 1);
      const status = qEl.querySelector('.quiz-q-status');
      if (status) {
        status.textContent = ok ? 'отвечено' : 'не отвечен';
        status.classList.toggle('answered', ok);
      }
    });
    if (counterNEl) counterNEl.textContent = String(answered);
    return { total: all.length, answered, unansweredNums };
  }

  // ─── Аккордеон ───
  questionsRoot.addEventListener('click', (e) => {
    // ↑↓ в ordering
    const actionBtn = e.target.closest('[data-action="up"], [data-action="down"]');
    if (actionBtn) {
      e.preventDefault();
      const qEl = actionBtn.closest('.quiz-q');
      moveOrderingItem(actionBtn);
      if (qEl) qEl.dataset.changed = '1';
      updateCounter();
      return;
    }

    // toggle по шапке
    const head = e.target.closest('.quiz-q-head');
    if (!head) return;
    if (e.target.closest('button')) return;
    const qEl = head.closest('.quiz-q');
    const body = qEl.querySelector('.quiz-q-body');
    const isOpen = qEl.dataset.open === '1';
    qEl.dataset.open = isOpen ? '0' : '1';
    body.hidden = isOpen;
  });

  // ─── Изменение ответа ───
  questionsRoot.addEventListener('change', () => {
    updateCounter();
  });

  // ─── Перестановка элементов ordering ───
  function moveOrderingItem(btn) {
    const item = btn.closest('.quiz-ordering-item');
    if (!item) return;
    const parent = item.parentNode;
    const dir = btn.dataset.action === 'up' ? -1 : 1;
    const sibling = dir < 0 ? item.previousElementSibling : item.nextElementSibling;
    if (!sibling) return;
    if (dir < 0) parent.insertBefore(item, sibling);
    else parent.insertBefore(sibling, item);
    renumberOrdering(parent);
  }

  function renumberOrdering(parent) {
    const items = parent.querySelectorAll('.quiz-ordering-item');
    const last = items.length - 1;
    items.forEach((it, i) => {
      const num = it.querySelector('.quiz-ordering-num');
      if (num) num.textContent = String(i + 1);
      const up = it.querySelector('[data-action="up"]');
      const down = it.querySelector('[data-action="down"]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === last;
    });
  }

  // ─── Модалка «Завершить» ───
  function openConfirm() {
    if (!dialog || !dialogText) {
      // fallback — если модалки нет, отправляем сразу
      doSubmit();
      return;
    }
    const { total, answered, unansweredNums } = updateCounter();
    let msg;
    if (answered === total) {
      msg = `Вы ответили на все ${total} ${plural(total, 'вопрос', 'вопроса', 'вопросов')}.`;
    } else if (answered === 0) {
      msg = 'Вы не ответили ни на один вопрос.';
    } else {
      const preview = unansweredNums.length <= 10
        ? unansweredNums.join(', ')
        : unansweredNums.slice(0, 10).join(', ') + ' и ещё ' + (unansweredNums.length - 10);
      msg = `Вы ответили на ${answered} из ${total}. Без ответа: ${preview}.`;
    }
    dialogText.textContent = msg + ' После завершения изменить ответы нельзя.';
    dialog.hidden = false;
  }

  function closeConfirm() {
    if (dialog) dialog.hidden = true;
  }

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // ─── Отправка ───
  function doSubmit() {
    if (submitted) return;
    submitted = true;
    const answers = collectAnswers();
    if (answersInput) answersInput.value = JSON.stringify(answers);
    // Снимаем disabled — на случай, если таймер их выставил
    form.querySelectorAll('input,button,select,textarea').forEach((el) => {
      el.disabled = false;
    });
    form.submit();
  }

  // ─── Кнопки модалки ───
  if (finishBtn) {
    finishBtn.addEventListener('click', openConfirm);
  }

  if (dialog) {
    dialog.addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]');
      if (act) {
        const a = act.dataset.action;
        if (a === 'cancel') { closeConfirm(); return; }
        if (a === 'confirm') { closeConfirm(); doSubmit(); return; }
      }
      // клик по фону = закрыть
      if (e.target === dialog) closeConfirm();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dialog.hidden) closeConfirm();
    });
  }

  // ─── Таймер ───
  function setupTimer() {
    const timerEl = form.querySelector('.quiz-timer');
    if (!timerEl) return;
    const limitMin = Number(timerEl.dataset.limit) || 0;
    if (limitMin <= 0) return;
    const startedRaw = timerEl.dataset.started || '';
    const startMs = Date.parse(String(startedRaw).replace(' ', 'T') + 'Z');
    if (!Number.isFinite(startMs)) return;

    timerEl.hidden = false;

    function tick() {
      if (submitted) return;
      const now = Date.now();
      const elapsedSec = Math.floor((now - startMs) / 1000);
      const remainingSec = limitMin * 60 - elapsedSec;

      if (remainingSec <= 0) {
        timerEl.textContent = '00:00';
        timerEl.classList.add('danger');
        // Авто-отправка без модалки
        doSubmit();
        return;
      }

      const m = Math.floor(remainingSec / 60);
      const s = remainingSec % 60;
      timerEl.textContent =
        String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      timerEl.classList.toggle('warning', remainingSec <= 60);
      timerEl.classList.toggle('danger', remainingSec <= 30);
      setTimeout(tick, 1000);
    }
    tick();
  }

  // ─── Инициализация ───
  function init() {
    // Все вопросы — свёрнуты
    questionsRoot.querySelectorAll('.quiz-q').forEach((qEl) => {
      qEl.dataset.open = '0';
      const body = qEl.querySelector('.quiz-q-body');
      if (body) body.hidden = true;
    });
    // Начальная установка чётных номеров ordering (не критично, но для чистоты)
    questionsRoot.querySelectorAll('.quiz-ordering').forEach(renumberOrdering);
    updateCounter();
    setupTimer();
  }

  init();
})();