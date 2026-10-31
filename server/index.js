'use strict';

/**
 * Точка входа: HTTP-сервер со статикой + два WebSocket-канала:
 *   /ws        — игроки
 *   /admin-ws  — админка («симулятор бога»), вход по паролю
 *
 * Переменные окружения:
 *   PORT            — порт (по умолчанию 3000)
 *   ADMIN_PASSWORD  — пароль админки (если не задан — генерируется и сохраняется в data/admin.secret)
 *   DATA_FILE       — куда сохранять мир (по умолчанию data/world.json)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
const storage = require('./storage');
const { BALANCE, ITEMS } = require('./content');

const ITEM_CATALOG = Object.fromEntries(Object.entries(ITEMS).map(([id, it]) => [id, it.name]));

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'world.json');
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = resolveAdminPassword();
const OFFLINE_GRACE_MS = 20000; // сколько ждать переподключения, прежде чем считать игрока ушедшим

function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const file = path.join(ROOT, 'data', 'admin.secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* файла ещё нет */
  }
  const generated = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
  return generated;
}

// ---------------------------------------------------------------------------
// Мир
// ---------------------------------------------------------------------------
const game = new Game(storage.load(DATA_FILE));

// ---------------------------------------------------------------------------
// Статика
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const playerWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const adminWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') playerWss.handleUpgrade(req, socket, head, (ws) => playerWss.emit('connection', ws, req));
  else if (pathname === '/admin-ws') adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit('connection', ws, req));
  else socket.destroy();
});

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

/** playerId → Set<ws> */
const socketsByPlayer = new Map();
const offlineTimers = new Map();
const admins = new Set();

function bind(ws, player) {
  ws.playerId = player.id;
  if (!socketsByPlayer.has(player.id)) socketsByPlayer.set(player.id, new Set());
  socketsByPlayer.get(player.id).add(ws);
  clearTimeout(offlineTimers.get(player.id));
  offlineTimers.delete(player.id);
  game.setOnline(player.id, true);
  send(ws, { t: 'welcome', id: player.id, token: player.token, catalog: ITEM_CATALOG });
  send(ws, { t: 'chat_history', ...game.chatHistory(player) });
  pushView(player.id);
}

function unbind(ws) {
  const id = ws.playerId;
  if (!id) return;
  ws.playerId = null;
  const set = socketsByPlayer.get(id);
  if (!set) return;
  set.delete(ws);
  if (set.size) return;
  socketsByPlayer.delete(id);
  // ждём немного: вдруг это просто перезагрузка страницы
  offlineTimers.set(
    id,
    setTimeout(() => {
      offlineTimers.delete(id);
      if (!socketsByPlayer.has(id)) game.setOnline(id, false);
    }, OFFLINE_GRACE_MS),
  );
}

function pushView(id) {
  const set = socketsByPlayer.get(id);
  const p = game.getPlayer(id);
  if (!set || !p) return;
  const view = game.playerView(p);
  for (const ws of set) send(ws, { t: 'view', view });
}

function sendToPlayer(id, msg) {
  for (const ws of socketsByPlayer.get(id) || []) send(ws, msg);
}

// Игрок сменил локацию — отдаём ему историю местного чата.
const lastKey = new Map();
function syncLocation(id) {
  const p = game.getPlayer(id);
  if (!p) return;
  const key = game.locationKey(p);
  if (lastKey.get(id) !== key) {
    lastKey.set(id, key);
    sendToPlayer(id, { t: 'chat_history', ...game.chatHistory(p) });
  }
}

// ---- события мира → сокеты ----
game.on('dirty', (ids) => {
  for (const id of ids) pushView(id);
});

game.on('notify', ({ to, title, text, style }) => {
  for (const id of to) sendToPlayer(id, { t: 'notify', title, text, style });
});

game.on('chat', (msg) => {
  for (const ws of admins) send(ws, { t: 'chat', msg });
  if (msg.to) {
    sendToPlayer(msg.to, { t: 'chat', msg });
    return;
  }
  for (const [id] of socketsByPlayer) {
    if (msg.channel === 'global') {
      sendToPlayer(id, { t: 'chat', msg });
    } else {
      const p = game.getPlayer(id);
      if (p && game.locationKey(p) === msg.key) sendToPlayer(id, { t: 'chat', msg });
    }
  }
});

game.on('log', (entry) => {
  for (const ws of admins) send(ws, { t: 'log', entry });
});

// ---- игроки ----
const PLAYER_ACTIONS = {
  move: (p, a) => game.move(p, a),
  seal: (p, a) => game.seal(p, a.on),
  sleep: (p, a) => game.sleep(p, a.on),
  use: (p, a) => game.useItem(p, a.item),
  buy: (p, a) => game.buy(p, a.shop, a.key),
  work_start: (p, a) => game.workStart(p, a.game),
  work_submit: (p, a) => game.workSubmit(p, a.job, a.answers),
  work_cancel: (p) => game.workCancel(p),
  chat: (p, a) => game.chat(p, a.channel === 'global' ? 'global' : 'local', a.text),
  trade_offer: (p, a) => game.tradeOffer(p, a.to, a.give, a.want),
  trade_respond: (p, a) => game.tradeRespond(p, a.trade, !!a.accept),
};

playerWss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'hello') {
      const p = game.playerByToken(msg.token);
      if (p) bind(ws, p);
      else send(ws, { t: 'need_register' });
      return;
    }

    if (msg.t === 'register') {
      // «Новая жизнь» — отвязываемся от старого (мёртвого) персонажа
      if (ws.playerId) unbind(ws);
      const res = game.register(msg.name);
      if (!res.ok) {
        send(ws, { t: 'register_error', error: res.error });
        return;
      }
      bind(ws, res.player);
      return;
    }

    if (msg.t === 'act') {
      const p = ws.playerId ? game.getPlayer(ws.playerId) : null;
      if (!p) {
        send(ws, { t: 'need_register' });
        return;
      }
      const handler = PLAYER_ACTIONS[msg.action];
      const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
      let res;
      try {
        res = handler ? handler(p, args) : { ok: false, error: 'Неизвестное действие' };
      } catch (err) {
        console.error('[action]', msg.action, err);
        res = { ok: false, error: 'Что-то пошло не так.' };
      }
      send(ws, { t: 'res', id: msg.id, ...res });
      pushView(p.id);
      syncLocation(p.id);
    }
  });
  ws.on('close', () => unbind(ws));
});

// ---- админы ----
const failedLogins = new Map(); // ip → { count, until }

adminWss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'auth') {
      const lock = failedLogins.get(ip);
      if (lock && lock.until > Date.now()) {
        send(ws, { t: 'auth_error', error: 'Слишком много попыток. Подождите минуту.' });
        return;
      }
      const given = Buffer.from(String(msg.password || ''));
      const expected = Buffer.from(ADMIN_PASSWORD);
      const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
      if (!ok) {
        const count = (lock?.count || 0) + 1;
        failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
        send(ws, { t: 'auth_error', error: 'Неверный пароль.' });
        return;
      }
      failedLogins.delete(ip);
      ws.isAdmin = true;
      admins.add(ws);
      send(ws, {
        t: 'admin_init',
        content: game.adminContent(),
        log: game.state.log.slice(-200),
        chat: game.state.chatGlobal.slice(-100),
        snapshot: game.adminSnapshot(),
      });
      return;
    }

    if (!ws.isAdmin) {
      send(ws, { t: 'auth_error', error: 'Нужен пароль.' });
      return;
    }

    if (msg.t === 'cmd') {
      const res = game.admin(String(msg.cmd), msg.args && typeof msg.args === 'object' ? msg.args : {});
      send(ws, { t: 'res', id: msg.id, ...res });
      send(ws, { t: 'snapshot', snapshot: game.adminSnapshot() });
      for (const [id] of socketsByPlayer) syncLocation(id);
    }
  });
  ws.on('close', () => admins.delete(ws));
});

// ---------------------------------------------------------------------------
// Игровой цикл, сохранение, пинги
// ---------------------------------------------------------------------------
setInterval(() => {
  game.tick();
  for (const [id] of socketsByPlayer) {
    pushView(id);
    syncLocation(id);
  }
  if (admins.size) {
    const snapshot = game.adminSnapshot();
    for (const ws of admins) send(ws, { t: 'snapshot', snapshot });
  }
}, BALANCE.tickMs);

function persist() {
  try {
    storage.save(DATA_FILE, game.state);
  } catch (err) {
    console.error('[storage] Не удалось сохранить мир:', err.message);
  }
}
setInterval(persist, 10000);

setInterval(() => {
  for (const wss of [playerWss, adminWss]) {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    persist();
    console.log('\nМир сохранён. До свидания.');
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Гигахрущёвка запущена: http://localhost:${PORT}`);
  console.log(`Админка:               http://localhost:${PORT}/admin`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Пароль админки:        ${ADMIN_PASSWORD}  (задайте свой через ADMIN_PASSWORD)`);
});
