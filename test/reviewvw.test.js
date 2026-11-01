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
