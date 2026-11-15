'use strict';
require('dotenv').config();
const fs = require('node:fs');
const app = require('./app');
const config = require('./config');
const db = require('./database');

// Единый корень. Внутри создаются подпапки по kind при первой загрузке,
// но корневые чаты/поддержку создаём сразу, чтобы не было сюрпризов.
fs.mkdirSync(config.STORAGE_DIR, { recursive: true });
fs.mkdirSync(config.CHAT_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(config.SUPPORT_FILES_DIR, { recursive: true });

const server = app.listen(config.PORT, config.HOST, () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Сервер:     http://localhost:${config.PORT}`);
  console.log(`  Админка:    http://localhost:${config.PORT}/admin/login`);
  console.log(`  Студент:    http://localhost:${config.PORT}/login/student`);
  console.log(`  Препод:     http://localhost:${config.PORT}/login/teacher`);
  console.log('───────────────────────────────────────────────────────');
  console.log(`  Хранилище:  ${config.STORAGE_DIR}`);
  console.log(`  Демо-студент:      ${config.DEMO_STUDENT.login} / ${config.DEMO_STUDENT.password}`);
  console.log(`  Демо-преподаватель: ${config.DEMO_TEACHER.login} / ${config.DEMO_TEACHER.password}`);
  console.log('═══════════════════════════════════════════════════════');
});

// ═══════════════════════════════════════════════════════════
// ТАЙМАУТЫ ДЛЯ МЕДЛЕННЫХ ЗАГРУЗОК (throttle)
// ═══════════════════════════════════════════════════════════
// Node 18+ рвёт запрос через 300 с и отдаёт голый 408. При throttle 1 Мбит/с
// файл 40 МБ грузится ~320 с — Node обрывает раньше. 30 минут — с запасом
// на любой throttle >= 1 Мбит/с при maxSizeMb <= 100.
// Формула: requestTimeout_ms >= (maxSizeMb * 8 / throttle_Mbps) * 1000 * 2
server.requestTimeout = 1_800_000;   // 30 мин
server.headersTimeout = 120_000;     // 2 мин
server.keepAliveTimeout = 65_000;    // 65 с

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════
let isShuttingDown = false;
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[server] ${signal}, завершение…`);
  server.close((err) => {
    try { db.close(); } catch (e) { console.error('[server] close db:', e); }
    if (err) { console.error('[server] close:', err); process.exitCode = 1; }
    process.exit();
  });
  setTimeout(() => { console.error('[server] force exit'); process.exit(1); }, 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => console.error('[server] unhandled:', r));
process.on('uncaughtException', (e) => { console.error('[server] uncaught:', e); shutdown('uncaughtException'); });