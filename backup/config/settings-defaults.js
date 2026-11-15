'use strict';
module.exports = Object.freeze({
  // ─── Безопасность ───
  'security.passwordLevel': 'medium',
  'security.adminPasswordLevel': 'strong',
  'security.passwordMinLength': 0,
  'security.sessionMaxAgeHours': 8,
  'security.cookieSecure': null,
  // ─── Аутентификация / регистрация ───
  'auth.studentLoginType': 'student_id',
  'auth.registrationEnabled': false,
  'auth.registrationNeedsApproval': true,
  // ─── Демо-данные ───
  'demo.enabled': true,
  // ─── Аудит ───
  'audit.extended': false,
  'audit.extendedUntil': null,
  'audit.extendedAll': false,
  'audit.retentionDays': 1500,
  'audit.mutedActions': [],
  'audit.forceLogActions': [],
  // ─── Файлы ───
  'files.maxSizeMb': 100,
  'files.maxFilesPerUpload': 5,
  'files.uploadRateLimitMbps': 0,
  'files.uploadExtensions': [
    '.pdf', '.docx', '.pptx', '.txt', '.zip',
    '.png', '.jpg', '.jpeg', '.mp4', '.webm',
  ],
  'files.imageExtensions': ['.png', '.jpg', '.jpeg'],
  // ─── Редактор тем (Quill) ───
  'quill.toolbarGroups': [
    'fonts', 'inline', 'color', 'script', 'list',
    'indent', 'align', 'blocks', 'link', 'image', 'formula', 'clean',
  ],
  'quill.tableEnabled': true,
  // ─── Обратная связь ───
  'feedback.rateLimitMax': 5,
  'feedback.rateLimitWindowMin': 60,
  // ─── Чаты ───
  'chat.messageRateLimitMax': 30,
  'chat.messageRateLimitWindowMin': 1,
  'chat.messageRateLimitBlockMin': 1,
  // ─── Сдача работ ───
  'submit.rateLimitMax': 30,
  'submit.rateLimitWindowMin': 1,
  'submit.rateLimitBlockMin': 1,
  // ─── Колледж ───
  'college.short': 'ЧГТК',
  'college.shortName': 'Черемховский горнотехнический колледж им. М.И. Щадова',
  'college.name': 'ГБПОУ "ЧГТК им. М.И. Щадова"',
  'college.systemName': 'ИС',
  'college.systemFull': 'Система управления обучением',
  'college.address': 'Адрес колледжа',
  'college.phone': '+7 (000) 000-00-00',
  'college.email': 'info@chgtk.ru',
  'college.site': 'https://www.chgtk.ru',
  'college.timezone': 'Asia/Irkutsk',
});