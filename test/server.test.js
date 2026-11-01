'use strict';

// Сервер целиком: запускаем настоящий процесс на свободном порту с временным миром.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: 'pw-test', DATA_FILE: path.join(dir, 'world.json'), REGISTER_LIMIT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('сервер не запустился')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('запущена')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on('exit', (code) => reject(new Error(`сервер вышел: ${code}`)));
  });
});

test.after(() => {
  if (proc) proc.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(BASE + pathname, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function open(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}`, { headers });
    const queue = [];
    const waiters = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.next = (pred, ms = 4000) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { pred, resolve: res };
        waiters.push(w);
        setTimeout(() => rej(new Error('не дождались сообщения')), ms);
      });
    };
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error('отказ'), { status: res.statusCode })));
    ws.on('error', reject);
  });
}

test('/healthz отвечает и показывает сохранение', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
  assert.equal(typeof j.uptimeSec, 'number');
});

test('статика с защитными заголовками', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('сокет с чужого сайта не открыть, со своего — можно', async () => {
  await assert.rejects(open('/ws', { Origin: 'https://evil.example' }), (e) => e.status === 403);
  const ws = await open('/ws', { Origin: BASE });
  ws.close();
});

test('Пульт: снимок изменениями и id ответа не затирается id созданной записи', async () => {
  const pl = await open('/ws');
  pl.send(JSON.stringify({ t: 'hello' }));
  pl.send(JSON.stringify({ t: 'register', name: 'Тестов', login: 'testov', password: 'secret12' }));
  await pl.next((m) => m.t === 'welcome');
  const ad = await open('/admin-ws');
  ad.send(JSON.stringify({ t: 'auth', password: 'pw-test' }));
  const init = await ad.next((m) => m.t === 'admin_init');
  assert.equal(init.snapshot.players.length, 1);
  // следующий снимок — без неизменившихся жильцов
  const snaps = [];
  for (let i = 0; i < 3; i++) snaps.push(await ad.next((m) => m.t === 'snapshot'));
  assert.ok(snaps.every((s) => s.snapshot.players === undefined));
  assert.ok(snaps.some((s) => s.upsert.length === 0), 'хотя бы одна секунда без изменений');
  // команда, которая возвращает свой id (расписание)
  ad.send(JSON.stringify({ t: 'cmd', id: 77, cmd: 'schedule', args: { cmd: 'announce', args: { title: 'Т', text: 'Т' }, label: 'Т', mode: 'in', value: '10' } }));
  const res = await ad.next((m) => m.t === 'res');
  assert.equal(res.id, 77);
  assert.equal(res.ok, true);
  pl.close();
  ad.close();
});
