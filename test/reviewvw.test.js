'use strict';

// Исправления по проверке пачек V–W (пуши, карманный режим, рассылка изменениями).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const C = require('../server/content');

function makeWorld() {
  const clock = { t: 1_000_000 };
  const game = new Game(null, { now: () => clock.t, random: () => 0.99 });
  game.checkCache = true;
  return { game, clock };
}
function join(game, name) {
  const { player } = game.register(name);
  game.setOnline(player.id, true);
  return player;
}

test('срочные пуши (туман, смерть) не глушатся часовым лимитом обычных', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.pushSubscribe(p, { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: {} });
  game.setOnline(p.id, false);
  const pushes = [];
  game.on('push', (m) => pushes.push(m));
  // 12 обычных за час (стук и записки по очереди, раз в 10 минут на тему)
  for (let i = 0; i < 6; i++) {
    game.pushOffline(p, { title: 'Стук', body: 'x', tag: 'knock' });
    game.pushOffline(p, { title: 'Записка', body: 'x', tag: 'door' });
    clock.t += 10 * 60000 + 1000;
  }
  clock.t -= 10 * 60000; // всё ещё в пределах часа от первых
  const normal = pushes.length;
  assert.equal(game.pushOffline(p, { title: 'Шёпот', body: 'x', tag: 'whisper' }), false, 'обычный — сверх лимита');
  game.admin('fog', { from: 101, to: 101, warnSec: 30, durationMin: 3 });
  assert.ok(pushes.slice(normal).some((m) => m.tag === 'fog'), 'сирена ушла');
  game.kill(p, 'тест');
  assert.ok(pushes.some((m) => m.tag === 'death'), 'смерть ушла');
});

test('«в сети», но игра свёрнута (или связь оборвалась) — пуш всё равно уходит', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.pushSubscribe(p, { endpoint: 'https://fcm.googleapis.com/fcm/send/b', keys: {} });
  const pushes = [];
  game.on('push', (m) => pushes.push(m));
  game.admin('whisper', { id: p.id, text: 'тс-с' });
  assert.equal(pushes.length, 0, 'игра открыта — пуш не нужен');
  game.inGame = () => false; // сервер: нет видимой вкладки
  game.admin('fog', { from: 101, to: 101, warnSec: 30, durationMin: 3 });
  assert.ok(pushes.some((m) => m.tag === 'fog'));
  assert.ok(C.BALANCE);
});

test('пуш-ключи: точка вне кривой отклоняется, негодная подписка — «gone»; битый файл ключа не затирается', async () => {
  const Push = require('../server/push');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const bad = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
  assert.equal(Push.cleanSubscription(bad), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-vapid-'));
  const file = path.join(dir, 'vapid.json');
  const v = Push.loadVapid(file, 'mailto:a@b.c');
  assert.equal(Push.send.length >= 3, true);
  assert.equal(await Push.send(v, bad, { title: 'x' }, { fetchImpl: async () => ({ status: 201 }) }), 'gone');
  fs.writeFileSync(file, '{битый');
  assert.throws(() => Push.loadVapid(file), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{битый', 'файл не перезаписан');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('пуши: вопрос ЖЭК уходит; за задраенной дверью приход тумана — без тревоги; откат не возвращает чужой телефон', () => {
  const { game, clock } = makeWorld();
  const [a, b] = ['Иван', 'Мария'].map((n) => join(game, n));
  const phone = { endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: {} };
  game.pushSubscribe(a, phone);
  game.setOnline(a.id, false);
  const pushes = [];
  game.on('push', (m) => pushes.push(m));
  game.admin('ask', { target: { type: 'player', id: a.id }, question: 'Сдать соседа?', options: ['Да', 'Нет'] });
  assert.ok(pushes.some((m) => m.tag === 'ask' && /Сдать соседа/.test(m.body)));
  // задраился дома: сирена спокойная, приход тумана — без «бегите»
  game.setDoorSealed(a.apartment.number, true);
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 3 });
  assert.ok(!pushes.some((m) => m.tag === 'fog' && m.urgent), 'тревоги нет');
  game.admin('fogClear');
  // снимок, телефон перешёл к Марии, откат Ивана — телефон остаётся у Марии
  game.admin('snapshot', { label: 'с телефоном' });
  const sid = game.snapshots.at(-1).id;
  game.pushSubscribe(b, phone);
  clock.t += 1000;
  assert.equal(game.admin('restorePlayer', { snapshotId: sid, id: a.id }).ok, true);
  assert.deepEqual(game.getPlayer(a.id).push, []);
  assert.equal(game.getPlayer(b.id).push.length, 1);
  game.admin('restoreHouse', { snapshotId: sid });
  assert.deepEqual(game.getPlayer(a.id).push, [], 'и после отката дома');
  assert.equal(game.getPlayer(b.id).push.length, 1);
});
