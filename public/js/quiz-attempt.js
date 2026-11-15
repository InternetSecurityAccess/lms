// public/js/quiz-attempt.js
(() => {
  'use strict';
  const fmtSize = (bytes) => {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  };

  // СТАРТ
  const startForm = document.getElementById('quizStartForm');
  if (startForm) {
    startForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = startForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Запуск...';
      try {
        const res = await fetch(startForm.action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({}) });
        const data = await res.json();
        if (data.ok === false) { alert(data.error); btn.disabled = false; btn.textContent = 'Начать тест'; return; }
        sessionStorage.setItem('quizAttemptId', data.attemptId);
        window.location.href = data.redirectUrl;
      } catch (err) {
        console.error('Quiz start error:', err);
        alert('Ошибка связи.');
        btn.disabled = false;
        btn.textContent = 'Начать тест';
      }
    });
  }

  // ПРОХОЖДЕНИЕ
  const attemptId = sessionStorage.getItem('quizAttemptId');
  const finishBtn = document.getElementById('quizFinishBtn');
  const timerEl = document.getElementById('quizTimer');
  const serverDeadline = timerEl ? Number(timerEl.dataset.deadline) : null;

  if (finishBtn && attemptId) {
    finishBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const unanswered = [];
      document.querySelectorAll('.quiz-q').forEach((q) => {
        const id = q.dataset.qid;
        const type = q.dataset.qtype;
        let answered = false;
        if (type === 'single' || type === 'multiple') answered = !!q.querySelector('input:checked');
        if (type === 'ordering') answered = q.querySelectorAll('.quiz-ordering-item').length > 0;
        if (!answered) unanswered.push(q.dataset.qnum);
      });
      const confirmMsg = unanswered.length > 0 ? `Вы ответили на ${document.querySelectorAll('.quiz-q').length - unanswered.length} из ${document.querySelectorAll('.quiz-q').length} вопросов. Без ответа: ${unanswered.join(', ')}. После завершения изменить ответы нельзя.` : `Вы ответили на все вопросы. После завершения изменить ответы нельзя.`;
      const ok = await window.confirmAsync(confirmMsg, { okText: 'Завершить', okClass: 'primary' });
      if (!ok) return;

      finishBtn.disabled = true;
      finishBtn.textContent = 'Отправка...';
      try {
        const payload = collectAnswers();
        const res = await fetch(finishBtn.form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.ok) window.location.href = data.redirectUrl;
        else { alert(data.error); finishBtn.disabled = false; finishBtn.textContent = 'Завершить тест'; }
      } catch (err) {
        console.error('Quiz submit error:', err);
        alert('Ошибка связи.');
        finishBtn.disabled = false;
        finishBtn.textContent = 'Завершить тест';
      }
    });
  }

  function collectAnswers() {
    const answers = [];
    document.querySelectorAll('.quiz-q').forEach((q) => {
      const id = q.dataset.qid;
      const type = q.dataset.qtype;
      if (type === 'single') {
        const checked = q.querySelector('input[name="q_' + id + '"]:checked');
        if (checked) answers.push({ question_id: id, option_id: checked.value });
      }
      if (type === 'multiple') {
        const checked = Array.from(q.querySelectorAll('input[name="q_' + id + '"]:checked'));
        if (checked.length > 0) answers.push({ question_id: id, option_ids: checked.map(c => c.value).join(',') });
      }
      if (type === 'ordering') {
        const items = q.querySelectorAll('.quiz-ordering-item');
        if (items.length > 0) answers.push({ question_id: id, order: Array.from(items).map(i => i.dataset.optid).join(',') });
      }
    });
    return { answers };
  }

  // ТАЙМЕР
  if (timerEl && serverDeadline) {
    const updateTimer = () => {
      const now = Date.now();
      const diff = serverDeadline - now;
      if (diff <= 0) {
        timerEl.textContent = '00:00';
        timerEl.classList.add('danger');
        autoSubmit();
        return;
      }
      const mins = Math.floor(diff / 60000).toString().padStart(2, '0');
      const secs = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
      timerEl.textContent = `${mins}:${secs}`;
      if (diff < 300000) timerEl.classList.add('warning');
      if (diff < 60000) timerEl.classList.add('danger');
    };

    const autoSubmit = () => {
      document.querySelectorAll('input, button').forEach(el => el.disabled = true);
      if (finishBtn) {
        finishBtn.disabled = true;
        const payload = collectAnswers();
        fetch(finishBtn.form.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) }).catch(() => {/* тихо */});
      }
    };

    updateTimer();
    const t = setInterval(updateTimer, 1000);
    setInterval(async () => {
      try {
        const res = await fetch(`/student/quiz/attempt/${attemptId}/status`, { credentials: 'same-origin' });
        const data = await res.json();
        if (data.status === 'expired') { clearInterval(t); autoSubmit(); }
      } catch { /* ignore */ }
    }, 10000);
  }

  window.addEventListener('beforeunload', (e) => {
    if (document.getElementById('quizFinishBtn') && !document.getElementById('quizResult')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();