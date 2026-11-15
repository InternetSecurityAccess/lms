// public/js/groups-save-indicator.js
// Индикатор изменений формы привязки групп предмета.
// С момента 4.3 кнопка «Подписаться» — отдельная форма вне #groupsForm,
// поэтому этот скрипт не считает подписку «изменением» — и это правильно:
// подписка не меняет subject_groups, она меняет teacher_groups.
// Здесь остаётся только одна задача: «Сохранить привязки» активна,
// если состав group_ids изменился ИЛИ отмечены галочкой неподписанные группы
// (второй случай — подстраховка: препод мог не заметить кнопку «Подписаться»).
(() => {
  'use strict';
  const form = document.getElementById('groupsForm');
  if (!form) return;
  const btn = document.getElementById('groupsSaveBtn');
  const status = document.getElementById('groupsSaveStatus');
  const checkboxes = Array.from(form.querySelectorAll('input[name="group_ids"]'));
  const initial = new Set(
    checkboxes.filter((cb) => cb.dataset.initial === '1').map((cb) => cb.value)
  );
  function isChanged() {
    const cur = new Set(checkboxes.filter((cb) => cb.checked).map((cb) => cb.value));
    if (cur.size !== initial.size) return true;
    for (const v of cur) if (!initial.has(v)) return true;
    return false;
  }
  // Группа привязана к предмету, но преподаватель на неё не подписан.
  // Если препод просто оставит галочку и нажмёт «Сохранить» — сработает
  // INSERT в teacher_groups. Это ожидаемое поведение, но лучше подсказать.
  function hasUnsubscribed() {
    return checkboxes.some((cb) =>
      cb.checked && cb.dataset.subscribed === '0'
    );
  }
  function update() {
    const cur = new Set(checkboxes.filter((cb) => cb.checked).map((cb) => cb.value));
    const changed = isChanged();
    const willSubscribe = hasUnsubscribed();
    const actionable = changed || willSubscribe;
    if (btn) {
      btn.disabled = !actionable;
      btn.textContent = willSubscribe && !changed
        ? 'Подписаться на отмеченные'
        : 'Сохранить привязки';
    }
    if (status) {
      if (willSubscribe && !changed) {
        const n = checkboxes.filter(
          (cb) => cb.checked && cb.dataset.subscribed === '0'
        ).length;
        status.textContent = `Не подписаны: ${n}. Нажмите «Сохранить» или кнопку «Подписаться» рядом с группой.`;
        status.style.color = 'var(--warning)';
      } else {
        status.textContent = changed
          ? 'Не сохранено'
          : (cur.size > 0 ? 'Привязано к ' + cur.size : 'Не привязан ни к одной');
        status.style.color = changed ? 'var(--warning)' : 'var(--muted)';
      }
    }
  }
  checkboxes.forEach((cb) => cb.addEventListener('change', update));
  update();
})();