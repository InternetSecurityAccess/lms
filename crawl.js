process.env.NODE_ENV = 'development';
const http = require('node:http');
const app = require('./app');
const server = app.listen(3998, '127.0.0.1', async () => {
  const base = { host: '127.0.0.1:3998', origin: 'http://127.0.0.1:3998', referer: 'http://127.0.0.1:3998/' };
  const jar = {};
  function setCookies(res) {
    const sc = res.headers['set-cookie'];
    if (!sc) return;
    for (const c of sc) { const [kv] = c.split(';'); const k = kv.split('=')[0]; jar[k] = kv; }
  }
  function cookieHeader() { return Object.values(jar).join('; '); }
  async function req(method, p, body) {
    return new Promise((resolve) => {
      const data = body ? new URLSearchParams(body).toString() : null;
      const r = http.request({ host: '127.0.0.1', port: 3998, path: p, method, headers: { ...base, cookie: cookieHeader(), ...(data ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
        let buf = ''; res.on('data', (d) => { buf += d; }); res.on('end', () => { setCookies(res); resolve({ status: res.statusCode, body: buf, loc: res.headers.location }); });
      });
      r.on('error', (e) => resolve({ status: 0, body: e.message }));
      if (data) r.write(data);
      r.end();
    });
  }
  const results = [];
  async function visit(p, label) {
    const r = await req('GET', p);
    results.push([label || p, r.status, r.loc || '', r.body.length]);
    // collect internal links
    const links = new Set();
    const re = /href="(\/[^"']*?)"/g; let m;
    while ((m = re.exec(r.body))) { const h = m[1].split('#')[0].split('?')[0]; if (h.startsWith('/') && !h.includes('/logout') && !h.includes('/download') && !h.includes('/file')) links.add(h); }
    return links;
  }
  // ADMIN
  await req('POST', '/admin/login', { login: 'admin', password: 'admin123' });
  console.log('admin login cookies:', Object.keys(jar).join(','));
  let queue = [...await visit('/admin', 'ADMIN /admin')];
  const seen = new Set(queue);
  let guard = 0;
  while (queue.length && guard++ < 60) {
    const p = queue.shift();
    const more = await visit(p, 'ADMIN');
    for (const l of more) if (!seen.has(l)) { seen.add(l); queue.push(l); }
  }
  console.log('--- ADMIN ---'); for (const r of results.splice(0)) console.log(r.join(' | '));
  // TEACHER
  for (const k in jar) delete jar[k];
  await req('POST', '/login/teacher', { login: 'ivanov@demo.local', password: 'Demo2026!' });
  console.log('teacher login cookies:', Object.keys(jar).join(','));
  queue = [...await visit('/teacher', 'TEACHER /teacher')];
  const seen2 = new Set(queue); guard = 0;
  while (queue.length && guard++ < 80) {
    const p = queue.shift();
    const more = await visit(p, 'TEACHER');
    for (const l of more) if (!seen2.has(l)) { seen2.add(l); queue.push(l); }
  }
  console.log('--- TEACHER ---'); for (const r of results.splice(0)) console.log(r.join(' | '));
  // STUDENT
  for (const k in jar) delete jar[k];
  await req('POST', '/login/student', { login: 'smirnov@demo.local', password: 'Demo2026!' });
  queue = [...await visit('/student', 'STUDENT /student')];
  const seen3 = new Set(queue); guard = 0;
  while (queue.length && guard++ < 80) {
    const p = queue.shift();
    const more = await visit(p, 'STUDENT');
    for (const l of more) if (!seen3.has(l)) { seen3.add(l); queue.push(l); }
  }
  console.log('--- STUDENT ---'); for (const r of results.splice(0)) console.log(r.join(' | '));
  process.exit(0);
});
