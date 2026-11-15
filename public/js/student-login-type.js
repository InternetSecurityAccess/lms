// public/js/student-login-type.js
(() => {
  'use strict';

  const input = document.getElementById('s-login');
  const hint = document.getElementById('s-login-hint');
  if (!input) return;

  function apply(type) {
    if (type === 'email') {
      input.setAttribute('type', 'email');
      input.setAttribute('maxlength', '200');
      input.removeAttribute('pattern');
      input.removeAttribute('title');
      input.setAttribute('placeholder', 'student@example.com');
      if (hint) hint.textContent = 'Email, по которому студент входит в систему.';
    } else {
      input.setAttribute('type', 'text');
      input.setAttribute('maxlength', '50');
      input.setAttribute('pattern', '[A-Za-zА-Яа-яЁё0-9._/-]+');
      input.setAttribute('title', 'Только буквы, цифры, точка, дефис, подчёркивание, слэш.');
      input.setAttribute('placeholder', 'Например: 1000002');
      if (hint) hint.textContent = 'Номер студенческого билета.';
    }
  }

  document.querySelectorAll('input[name="login_type"]').forEach((radio) => {
    radio.addEventListener('change', () => apply(radio.value));
  });

  // Начальное состояние — из отмеченного radio
  const checked = document.querySelector('input[name="login_type"]:checked');
  if (checked) apply(checked.value);
})();