// public/js/login-tabs.js
(() => {
  'use strict';

  const roleTabs = document.getElementById('roleTabs');
  const modeTabs = document.getElementById('modeTabs');

  function switchRole(role) {
    if (roleTabs) {
      roleTabs.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', (i === 0) === (role === 'student'));
      });
    }
    const paneStudent = document.getElementById('pane-student');
    const paneTeacher = document.getElementById('pane-teacher');
    if (paneStudent) paneStudent.classList.toggle('active', role === 'student');
    if (paneTeacher) paneTeacher.classList.toggle('active', role === 'teacher');
  }

  function switchMode(mode) {
    if (modeTabs) {
      modeTabs.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', (i === 0) === (mode === 'login'));
      });
    }
    const formLogin = document.getElementById('form-login');
    const formRegister = document.getElementById('form-register');
    if (formLogin) formLogin.classList.toggle('active', mode === 'login');
    if (formRegister) formRegister.classList.toggle('active', mode === 'register');
  }

  if (roleTabs) {
    roleTabs.querySelectorAll('.tab').forEach((t, i) => {
      t.addEventListener('click', () => switchRole(i === 0 ? 'student' : 'teacher'));
    });
  }
  if (modeTabs) {
    modeTabs.querySelectorAll('.tab').forEach((t, i) => {
      t.addEventListener('click', () => switchMode(i === 0 ? 'login' : 'register'));
    });
  }
})();