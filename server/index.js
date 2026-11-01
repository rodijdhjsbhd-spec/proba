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
/**
 * Адрес игрока для лимитов и блокировок.
 * За своим прокси (TRUST_PROXY=1) — X-Real-IP или ПОСЛЕДНИЙ элемент X-Forwarded-For: его дописал ваш
 * прокси, а начало заголовка присылает сам клиент и может подделать. Заголовкам верим, только если
 * соединение пришло с локального адреса (прокси на той же машине) или из TRUSTED_PROXIES.
 * IPv4 внутри IPv6 приводим к IPv4, IPv6 — к сети /64 (иначе у одного абонента миллиарды адресов).
 */
const TRUSTED_PROXIES = String(process.env.TRUSTED_PROXIES || '').split(',').map((x) => x.trim()).filter(Boolean);
function normalizeIp(ip) {
  let a = String(ip || '').trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a.includes(':')) return `${a.split(':').slice(0, 4).join(':')}::/64`;
  return a || 'unknown';
}
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const fromProxy = TRUST_PROXY && (/^(127\.|::1$|::ffff:127\.)/.test(remote) || TRUSTED_PROXIES.includes(normalizeIp(remote)));
  if (fromProxy) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return normalizeIp(real);
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (chain.length) return normalizeIp(chain[chain.length - 1]);
  }
  return normalizeIp(remote);
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
    const file = storage.backup(DATA_FILE, BACKUP_DIR, 48, new Date(), { skipIfNewerThanMs: 50 * 60 * 1000 });
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
  socket.on('error', () => socket.destroy());
  const pathname = String(req.url || '').split('?')[0]; // без new URL: кривой адрес не должен ронять сервер
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

function sendBanned(ws, ban) {
  send(ws, { t: 'banned', reason: ban.reason, until: ban.until || null });
  setTimeout(() => ws.close(), 200);
}

function bind(ws, player) {
  ws.playerId = player.id;
  player.lastIp = ws.ip;
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

game.on('notify', ({ to, title, text, style, action, ask }) => {
  for (const id of to) sendToPlayer(id, { t: 'notify', title, text, style, action, ask });
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

// Бан: выкинуть из игры все подключения этих жильцов
game.on('kick', ({ ids, reason, until }) => {
  for (const id of ids) {
    for (const ws of socketsByPlayer.get(id) || []) sendBanned(ws, { reason, until });
  }
});

// Удалённое сообщение исчезает у всех
game.on('chat_delete', ({ id }) => {
  for (const [pid] of socketsByPlayer) sendToPlayer(pid, { t: 'chat_delete', id });
  for (const ws of admins) send(ws, { t: 'chat_delete', id });
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
  open_door: (p, a) => game.openDoor(p, a.guest),
  aid: (p, a) => game.aid(p, a.target, a.item),
  rob: (p, a) => game.rob(p, a.target),
  pickpocket: (p, a) => game.pickpocket(p, a.target),
  answer: (p, a) => game.answer(p, String(a.id || ''), a.option),
  evict: (p, a) => game.evict(p, a.guest),
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
  claim_account: (p, a) => game.claimAccount(p, a.login, a.password),
  report: (p, a) => game.report(p, String(a.id || '')),
  chat: (p, a) => game.chat(p, a.channel === 'global' ? 'global' : 'local', a.text),
  trade_offer: (p, a) => game.tradeOffer(p, a.to, a.give, a.want),
  trade_respond: (p, a) => game.tradeRespond(p, a.trade, !!a.accept),
};

const failedLogins = new Map(); // адрес → { count, until } — неудачные входы (Пульт и паспорта)

// Сколько жильцов заселили с каждого адреса за последний час
const registrations = new Map(); // ip → [время, ...]
function registrationAllowed(ip) {
  if (!REGISTER_LIMIT) return true;
  const now = Date.now();
  const recent = (registrations.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length) registrations.set(ip, recent);
  else registrations.delete(ip);
  return recent.length < REGISTER_LIMIT;
}
// чистим старые записи, чтобы карта адресов не росла бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of registrations) if (!list.some((t) => now - t < 60 * 60 * 1000)) registrations.delete(ip);
  for (const [ip, lock] of failedLogins) if (!lock.until || lock.until < now) failedLogins.delete(ip);
}, 10 * 60 * 1000);

playerWss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = clientIp(req);
  // слишком большое или битое сообщение — закрываем это соединение, а не падаем целиком
  ws.on('error', (err) => {
    console.error('[ws]', err.message);
    ws.terminate();
  });
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
    if (!p) {
      send(ws, { t: 'need_register' });
      return;
    }
    const ban = game.banInfo(p, ws.ip);
    if (ban) {
      sendBanned(ws, ban);
      return;
    }
    bind(ws, p);
    return;
  }

  // Вход по паспорту (логин и пароль) — с любого устройства
  if (msg.t === 'login') {
    const lock = failedLogins.get(`p:${ws.ip}`);
    if (lock && lock.until > Date.now()) {
      send(ws, { t: 'register_error', error: 'Слишком много попыток. Подождите минуту.' });
      return;
    }
    const res = game.verifyLogin(msg.login, msg.password);
    if (!res.ok) {
      const count = (lock?.count || 0) + 1;
      failedLogins.set(`p:${ws.ip}`, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
      send(ws, { t: 'register_error', error: res.error });
      return;
    }
    failedLogins.delete(`p:${ws.ip}`);
    const ban = game.accountBanInfo(res.account, ws.ip);
    if (ban) {
      sendBanned(ws, ban);
      return;
    }
    const p = game.accountPlayer(res.account);
    if (p) {
      if (ws.playerId) unbind(ws);
      bind(ws, p);
    } else {
      // все жильцы этого паспорта погибли — можно заселить нового
      ws.account = game.accountKey(res.account.login);
      send(ws, { t: 'need_new_life', login: res.account.login });
    }
    return;
  }

  if (msg.t === 'register') {
    const bound = ws.playerId ? game.getPlayer(ws.playerId) : null;
    const rebirth = !!ws.account || !!(bound && !bound.alive);
    if (!rebirth && !registrationAllowed(ws.ip)) {
      send(ws, { t: 'register_error', error: `С одного адреса можно заселять не больше ${REGISTER_LIMIT} жильцов в час. Подождите.` });
      return;
    }
    const ipBan = game.banInfo(null, ws.ip);
    if (ipBan) {
      sendBanned(ws, ipBan);
      return;
    }
    // Чей это жилец: паспорт, по которому вошли, паспорт погибшего, или новый паспорт
    const current = ws.playerId ? game.getPlayer(ws.playerId) : null;
    let account = null;
    if (ws.account) account = game.state.accounts[ws.account] || null;
    else if (current && !current.alive && current.account) account = game.state.accounts[current.account] || null;
    const legacyRebirth = !account && current && !current.alive && !current.account;
    if (!account && !legacyRebirth) {
      const name = game.checkNewName(msg.name);
      if (!name.ok) {
        send(ws, { t: 'register_error', error: name.error });
        return;
      }
      const created = game.createAccount(msg.login, msg.password);
      if (!created.ok) {
        send(ws, { t: 'register_error', error: created.error });
        return;
      }
      account = created.account;
    }
    const res = game.register(msg.name, { account });
    if (!res.ok) {
      send(ws, { t: 'register_error', error: res.error });
      return;
    }
    // «Новая жизнь» — отвязываемся от старого (мёртвого) персонажа
    if (ws.playerId) unbind(ws);
    ws.account = null;
    if (!rebirth) {
      if (!registrations.has(ws.ip)) registrations.set(ws.ip, []);
      registrations.get(ws.ip).push(Date.now());
    }
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
      if (!handler) res = { ok: false, error: 'Неизвестное действие' };
      else if (p.down) res = { ok: false, error: 'Вы без сознания.' };
      else res = handler(p, args);
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

adminWss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.isAlive = true;
  ws.on('error', (err) => {
    console.error('[admin ws]', err.message);
    ws.terminate();
  });
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
    const total = failedLogins.get('admin:*');
    if ((lock && lock.until > Date.now()) || (total && total.until > Date.now())) {
      send(ws, { t: 'auth_error', error: 'Слишком много попыток. Подождите минуту.' });
      return;
    }
    const given = Buffer.from(String(msg.password || ''));
    const expected = Buffer.from(ADMIN_PASSWORD);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      const count = (lock?.count || 0) + 1;
      failedLogins.set(ip, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
      // общий счётчик — против перебора с разных адресов
      const all = failedLogins.get('admin:*');
      const fresh = all && Date.now() - all.since < 60000 ? all : { since: Date.now(), count: 0, until: 0 };
      fresh.count++;
      if (fresh.count >= 30) fresh.until = Date.now() + 60000;
      failedLogins.set('admin:*', fresh);
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
    game.state.savedAt = Date.now();
    storage.save(DATA_FILE, game.state);
  } catch (err) {
    console.error('[storage] Не удалось сохранить мир:', err.message);
  }
}
setInterval(persist, 10000);

// Смерть — сохраняем сразу (в течение секунды), чтобы падение сервера не «откатывало» беды бога
let persistTimer = null;
game.on('log', (entry) => {
  if (entry.kind === 'death' && !persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, 1000);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[fatal]', err);
  persist();
  process.exit(1);
});

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
