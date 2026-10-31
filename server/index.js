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
 *   BACKUP_DIR      — куда класть почасовые копии мира (по умолчанию data/backups)
 *   REGISTER_LIMIT  — сколько жильцов в час можно заселить с одного адреса (по умолчанию 5, 0 — без ограничения)
 *   TRUST_PROXY     — 1, если сервер стоит за своим nginx/Caddy: тогда адрес игрока берётся из X-Forwarded-For
 *   OFFLINE_GRACE_MS — сколько ждать переподключения, прежде чем считать жильца ушедшим (по умолчанию 20000)
 *   GH_BALANCE      — JSON с правками баланса из server/content.js (BALANCE), например '{"hungerPerMin":-2}'
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, WORLD_CONFIG } = require('./game');
const storage = require('./storage');
const { BALANCE, ITEMS } = require('./content');

const ITEM_CATALOG = Object.fromEntries(Object.entries(ITEMS).map(([id, it]) => [id, it.name]));

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'world.json');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups');
const REGISTER_LIMIT = process.env.REGISTER_LIMIT === undefined ? 5 : Number(process.env.REGISTER_LIMIT) || 0;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = resolveAdminPassword();
// сколько ждать переподключения, прежде чем считать игрока ушедшим
const OFFLINE_GRACE_MS = Number(process.env.OFFLINE_GRACE_MS) || 20000;

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

/** Адрес игрока. За своим прокси — из X-Forwarded-For, иначе — адрес соединения. */
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Мир
// ---------------------------------------------------------------------------
let saved;
try {
  saved = storage.load(DATA_FILE);
} catch (err) {
  // Битый файл мира: не запускаемся, иначе через 10 секунд пустой мир затрёт дом.
  const last = storage.latestBackup(BACKUP_DIR);
  console.error(`\n[storage] ${err.message}`);
  console.error('Сервер не запущен, чтобы не затереть дом пустым миром.');
  console.error(last ? `Последняя резервная копия: ${last}\nСкопируйте её на место ${DATA_FILE} и запустите сервер снова.` : `Резервных копий нет. Чтобы начать мир заново, удалите ${DATA_FILE}.`);
  process.exit(1);
}
const game = new Game(saved);

function makeBackup() {
  try {
    const file = storage.backup(DATA_FILE, BACKUP_DIR);
    if (file) console.log(`[storage] Резервная копия мира: ${file}`);
  } catch (err) {
    console.error('[storage] Не удалось сделать резервную копию:', err.message);
  }
}
makeBackup();
setInterval(makeBackup, 60 * 60 * 1000);

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
  send(ws, { t: 'welcome', id: player.id, token: player.token, catalog: ITEM_CATALOG, world: WORLD_CONFIG });
  lastActors.delete(player.id);
  send(ws, { t: 'chat_history', ...game.chatHistory(player) });
  game.setOnline(player.id, true); // после приветствия: квитанция «Пока вас не было» придёт уже в игру
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
  if (msg.adminOnly) return; // записки и листки — только в ленту Пульта
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
  knock: (p, a) => game.knock(p, a.apt),
  search: (p) => game.searchChute(p),
  board: (p) => game.readBoard(p),
  note: (p, a) => game.slipNote(p, a.apt, a.text, !!a.anon),
  parcel: (p, a) => game.leaveParcel(p, a.apt, a.give, a.text),
  pin: (p, a) => game.pinNote(p, a.text),
  unpin: (p) => game.unpinNote(p),
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

// Сколько жильцов заселили с каждого адреса за последний час
const registrations = new Map(); // ip → [время, ...]
function registrationAllowed(ip) {
  if (!REGISTER_LIMIT) return true;
  const now = Date.now();
  const recent = (registrations.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  registrations.set(ip, recent);
  return recent.length < REGISTER_LIMIT;
}

playerWss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = clientIp(req);
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    try {
      handlePlayerMessage(ws, raw);
    } catch (err) {
      console.error('[player message]', err);
    }
  });
  ws.on('close', () => unbind(ws));
});

function handlePlayerMessage(ws, raw) {
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
    if (!registrationAllowed(ws.ip)) {
      send(ws, { t: 'register_error', error: `С одного адреса можно заселять не больше ${REGISTER_LIMIT} жильцов в час. Подождите.` });
      return;
    }
    const res = game.register(msg.name);
    if (!res.ok) {
      send(ws, { t: 'register_error', error: res.error });
      return;
    }
    // «Новая жизнь» — отвязываемся от старого (мёртвого) персонажа
    if (ws.playerId) unbind(ws);
    if (!registrations.has(ws.ip)) registrations.set(ws.ip, []);
    registrations.get(ws.ip).push(Date.now());
    bind(ws, res.player);
    return;
  }

  if (msg.t === 'pos') {
    const p = ws.playerId ? game.getPlayer(ws.playerId) : null;
    if (!p) return;
    const now = Date.now();
    if (now - (ws.lastPosAt || 0) < 30) return;
    ws.lastPosAt = now;
    if (!game.setPos(p, msg.x, msg.y, msg.d)) send(ws, { t: 'pos_fix', x: p.pos.x, y: p.pos.y, seq: p.posSeq });
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
}

// ---- админы ----
const failedLogins = new Map(); // ip → { count, until }

adminWss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    try {
      handleAdminMessage(ws, ip, raw);
    } catch (err) {
      console.error('[admin message]', err);
    }
  });
  ws.on('close', () => admins.delete(ws));
});

function handleAdminMessage(ws, ip, raw) {
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
      chat: [...game.state.chatGlobal.slice(-100), ...game.state.noteFeed.slice(-100)].sort((a, b) => a.ts - b.ts),
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
}

// ---------------------------------------------------------------------------
// Игровой цикл, сохранение, пинги
// ---------------------------------------------------------------------------
setInterval(() => {
  try {
    game.tick();
  } catch (err) {
    // Ошибка в одном тике не должна ронять весь дом
    console.error('[tick]', err);
  }
  for (const [id] of socketsByPlayer) {
    try {
      pushView(id);
      syncLocation(id);
    } catch (err) {
      console.error('[view]', id, err);
    }
  }
  if (admins.size) {
    try {
      const snapshot = game.adminSnapshot();
      for (const ws of admins) send(ws, { t: 'snapshot', snapshot });
    } catch (err) {
      console.error('[snapshot]', err);
    }
  }
}, BALANCE.tickMs);

// Кто где стоит — рассылаем каждому жильцу состав его сцены (только если что-то изменилось).
const lastActors = new Map(); // playerId → подпись последней отправки
setInterval(() => {
  try {
    broadcastActors();
  } catch (err) {
    console.error('[actors]', err);
  }
}, 100);

function broadcastActors() {
  const byScene = new Map();
  for (const [id] of socketsByPlayer) {
    const p = game.getPlayer(id);
    if (!p || !p.alive) continue;
    const key = game.locationKey(p);
    if (!byScene.has(key)) byScene.set(key, []);
    byScene.get(key).push(id);
  }
  for (const [key, ids] of byScene) {
    const actors = game.sceneActors(key);
    const sig = key + JSON.stringify(actors);
    for (const id of ids) {
      if (lastActors.get(id) === sig) continue;
      lastActors.set(id, sig);
      sendToPlayer(id, { t: 'actors', key, actors });
    }
  }
}

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
