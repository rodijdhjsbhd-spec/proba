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

let PORT;
let BASE;
let proc;
let dir;

/** Свободный порт: спросить у системы, а не угадывать (рядом могут работать другие серверы). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test.before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: 'pw-test', DATA_FILE: path.join(dir, 'world.json'), REGISTER_LIMIT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('сервер не запустился')), 15000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('запущена')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on('exit', (code) => reject(new Error(`сервер вышел: ${code}`)));
  });
});

test.after(async () => {
  // сервер при остановке дописывает мир — ждём, пока выйдет, и только потом убираем папку
  if (proc && proc.exitCode === null) {
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    await exited;
  }
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

test('PWA и пуши: манифест, service worker, ключ в приветствии, подписка только на пуш-службы', async () => {
  const man = await get('/manifest.webmanifest');
  assert.equal(man.status, 200);
  assert.match(man.headers['content-type'], /manifest\+json/);
  assert.equal(JSON.parse(man.body).start_url, '/');
  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.body, /addEventListener\('push'/);
  assert.equal((await get('/offline.html')).status, 200);
  assert.equal((await get('/icons/icon-192.png')).status, 200);
  // ключ VAPID создан рядом с миром и пришёл жильцу
  assert.ok(fs.existsSync(path.join(dir, 'vapid.json')));
  const pl = await open('/ws');
  pl.send(JSON.stringify({ t: 'hello', proto: 2 }));
  pl.send(JSON.stringify({ t: 'register', name: 'Пушкин', login: 'pushkin', password: 'secret12' }));
  const welcome = await pl.next((m) => m.t === 'welcome');
  assert.equal(Buffer.from(welcome.push, 'base64url').length, 65);
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
  pl.send(JSON.stringify({ t: 'act', id: 1, action: 'push_subscribe', args: { sub: { endpoint: 'https://127.0.0.1:9/steal', keys } } }));
  const bad = await pl.next((m) => m.t === 'res' && m.id === 1);
  assert.equal(bad.ok, false);
  pl.send(JSON.stringify({ t: 'act', id: 2, action: 'push_subscribe', args: { sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys } } }));
  assert.equal((await pl.next((m) => m.t === 'res' && m.id === 2)).ok, true);
  // вид приходит изменениями: ждём, когда в нём появится телефон
  const patch = await pl.next((m) => m.t === 'vpatch' && m.set['you.push'] && m.set['you.push'].length === 1);
  assert.equal(patch.set['you.push'][0], 'https://fcm.googleapis.com/fcm/send/test');
  pl.send(JSON.stringify({ t: 'act', id: 3, action: 'push_unsubscribe', args: { endpoint: 'https://fcm.googleapis.com/fcm/send/test' } }));
  assert.equal((await pl.next((m) => m.t === 'res' && m.id === 3)).ok, true);
  pl.close();
});

test('соседи по сцене: сначала целиком, потом изменениями (шаг — коротко), по просьбе — снова целиком', async () => {
  const join = async (name, login) => {
    const ws = await open('/ws');
    ws.send(JSON.stringify({ t: 'hello', proto: 2 }));
    ws.send(JSON.stringify({ t: 'register', name, login, password: 'secret12' }));
    const w = await ws.next((m) => m.t === 'welcome');
    return { ws, id: w.id };
  };
  const a = await join('Соседов', 'sosedov');
  await new Promise((r) => setTimeout(r, 1600)); // паспорт — не чаще раза в 1,5 с с адреса
  const b = await join('Шагов', 'shagov');
  const ad = await open('/admin-ws');
  ad.send(JSON.stringify({ t: 'auth', password: 'pw-test' }));
  await ad.next((m) => m.t === 'admin_init');
  for (const [n, p] of [[1, a], [2, b]]) {
    ad.send(JSON.stringify({ t: 'cmd', id: n, cmd: 'teleport', args: { id: p.id, place: 'corridor', floor: 150 } }));
    assert.equal((await ad.next((m) => m.t === 'res' && m.id === n)).ok, true);
  }
  // A видит B целиком
  const full = await a.ws.next((m) => m.t === 'actors' && m.key === 'corridor:150' && m.base == null && m.actors.some((x) => x.id === b.id), 3000);
  // B делает шаг — A получает короткую запись о шаге к своей версии
  const bView = await b.ws.next((m) => (m.t === 'view' || m.t === 'vpatch') && JSON.stringify(m).includes('corridor:150'), 3000);
  const pos = bView.t === 'view' ? bView.view.you.pos : bView.set['you.pos'];
  b.ws.send(JSON.stringify({ t: 'pos', x: pos.x + 0.3, y: pos.y, d: 'right' }));
  const delta = await a.ws.next((m) => m.t === 'actors' && m.base != null && (m.moves || []).some((x) => x[0] === b.id), 3000);
  assert.ok(delta.seq > full.seq || delta.base >= full.seq);
  const mv = delta.moves.find((x) => x[0] === b.id);
  assert.equal(mv[3], 'right');
  assert.ok(!delta.actors.some((x) => x.id === b.id), 'шаг — без полной карточки');
  // клиент сбился — просит целиком
  a.ws.send(JSON.stringify({ t: 'actors_resync' }));
  await a.ws.next((m) => m.t === 'actors' && m.base == null && m.seq >= delta.seq, 3000);
  for (const ws of [a.ws, b.ws, ad]) ws.close();
});

test('старая вкладка (без версии протокола) получает вид и соседей целиком', async () => {
  const pl = await open('/ws');
  pl.send(JSON.stringify({ t: 'hello' }));
  pl.send(JSON.stringify({ t: 'register', name: 'Старовер', login: 'starover', password: 'secret12' }));
  await pl.next((m) => m.t === 'welcome');
  await pl.next((m) => m.t === 'view');
  const second = await pl.next((m) => m.t === 'view' || m.t === 'vpatch', 4000);
  assert.equal(second.t, 'view', 'изменений старая вкладка не понимает');
  pl.close();
});
