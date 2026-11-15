process.env.NODE_ENV = 'development';
process.env.PORT = '3999';
const app = require('./app');
const server = app.listen(3999, '127.0.0.1', async () => {
  const paths = ['/', '/health', '/login/student', '/login/teacher', '/admin/login', '/nope'];
  for (const p of paths) {
    try {
      const r = await fetch('http://127.0.0.1:3999' + p);
      const t = await r.text();
      console.log(p, r.status, t.length, t.slice(0, 160).replace(/\n/g, ' '));
    } catch (e) { console.log(p, 'ERR', e.message); }
  }
  process.exit(0);
});
server.on('error', e => { console.error('listen error', e); process.exit(1); });
