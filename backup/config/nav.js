
'use strict';

const MENUS = {
  guest: [
    { section: 'main' },
    {
      href: '/login/student',
      label: 'Студент',
      titles: ['Вход'],
    },
    {
      href: '/login/teacher',
      label: 'Преподаватель',
      titles: ['Вход'],
    },
    {
      href: '/register',
      label: 'Регистрация',
      titles: ['Вход'],
      registrationOnly: true,
    },
    {
      href: '/admin/login',
      label: 'Администратор',
      titles: ['Вход для администратора'],
      adminOnly: true,
    },
  ],

  student: [
    { section: 'main' },
        {
      href: '/my-study',
      label: 'Моя учёба',
      titles: ['Моя учёба', 'Вся учёба'],
    },
    {
      href: '/my-teachers',
      label: 'Мои преподаватели',
      titles: ['Мои преподаватели'],
    },

    { section: 'content' },
    {
      href: '/my-subjects',
      label: 'Мои предметы',
      titles: ['Мои предметы'],
    },

    { section: 'work' },
    {
      href: '/my-assignments',
      label: 'Мои задания',
      titles: ['Мои задания'],
    },

    { section: 'messages' },
    {
      href: '/my-announcements',
      label: 'Объявления',
      titles: ['Объявления'],
      badge: 'announcementsUnread',
    },
    {
      href: '/my-chats',
      label: 'Мои чаты',
      titles: ['Мои чаты', 'Групповые чаты'],
      badge: 'groupChatUnread',
    },
    {
      href: '/my-inbox',
      label: 'Уведомления',
      titles: ['Уведомления'],
      badge: 'inboxCount',
    },
  ],

  teacher: [
    { section: 'main' },
    {
      href: '/my-groups',
      label: 'Мои группы',
      titles: ['Мои группы'],
    },

    { section: 'content' },
    {
      href: '/subjects',
      label: 'Мои предметы',
      titles: ['Мои предметы'],
    },

    { section: 'work' },
    {
      href: '/assignments',
      label: 'Задания',
      titles: ['Задания'],
    },
    {
      href: '/my-group-announcements',
      label: 'Объявления',
      titles: ['Объявления'],
    },

    { section: 'messages' },
    {
      href: '/my-group-chats',
      label: 'Мои чаты',
      titles: ['Мои чаты', 'Групповые чаты'],
      badge: 'groupChatUnread',
    },
    {
      href: '/inbox',
      label: 'Уведомления',
      titles: ['Уведомления'],
      badge: 'inboxCount',
    },

    { section: 'system' },
    {
      href: '/trash',
      label: 'Корзина',
      titles: ['Корзина'],
    },
  ],

  admin: [
    { section: 'main' },
    {
      href: '/admin',
      label: 'Обзор',
      titles: ['Обзор', 'Админка'],
      exact: true,
    },

    { section: 'work' },
    {
      href: '/admin/approvals',
      label: 'Заявки',
      titles: ['Заявки', 'Заявки на регистрацию'],
      badge: 'pendingApprovals',
    },

    { section: 'messages' },
    {
      href: '/admin/support',
      label: 'Поддержка',
      titles: ['Поддержка', 'Обращения', 'Обращение'],
      badge: 'supportUnreadCount',
    },

    { section: 'system' },
    {
      href: '/admin/slow-log',
      label: 'Мониторинг',
      titles: ['Мониторинг', 'Slow-log'],
    },
    {
      href: '/admin/sessions',
      label: 'Сессии',
      titles: ['Сессии', 'Активные сессии'],
    },
    {
      href: '/admin/audit',
      label: 'Аудит',
      titles: ['Аудит', 'Журнал аудита'],
    },
    {
      href: '/admin/settings',
      label: 'Настройки',
      titles: ['Настройки'],
    },
    {
      href: '/admin/trash',
      label: 'Корзина',
      titles: ['Корзина'],
    },
  ],
};

module.exports = MENUS;
