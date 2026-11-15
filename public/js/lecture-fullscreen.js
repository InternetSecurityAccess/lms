// public/js/lecture-fullscreen.js
(() => {
  'use strict';

  const shell = document.getElementById('lectureShell');
  const btn = document.querySelector('[data-action="toggle-lecture-fullscreen"]');
  const label = document.getElementById('lectureFsLabel');
  if (!shell || !btn) return;

  btn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      (shell.requestFullscreen || shell.webkitRequestFullscreen || function () {}).call(shell);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
  });

  function updateLabel() {
    if (!label) return;
    label.textContent = document.fullscreenElement
      ? '✕ Выйти из полноэкранного режима'
      : '⛶ На весь экран';
  }
  document.addEventListener('fullscreenchange', updateLabel);
  document.addEventListener('webkitfullscreenchange', updateLabel);
  updateLabel();
})();