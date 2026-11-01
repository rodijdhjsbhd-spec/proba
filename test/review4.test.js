'use strict';

// Исправления по четвёртой независимой проверке (пачки N–U): каждая находка — проверкой.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const C = require('../server/content');

function makeWorld({ random = () => 0.99 } = {}) {
  const clock = { t: 1_000_000 };
  const game = new Game(null, { now: () => clock.t, random });
  game.checkCache = true;
  const advance = (ms) => {
    const steps = Math.round(ms / C.BALANCE.tickMs);
    for (let i = 0; i < steps; i++) {
      clock.t += C.BALANCE.tickMs;
      game.tick();
    }
  };
  return { game, clock, advance };
}
function join(game, name) {
  const { player } = game.register(name);
  game.setOnline(player.id, true);
  return player;
}
function walkTo(game, p, pred) {
  const o = game.sceneOf(p).objects.find(pred);
  assert.ok(o, 'такой объект есть в сцене');
  p.pos = { x: o.spot.x, y: o.spot.y, d: 'up' };
  return o;
}
const old = (p) => {
  p.createdAt -= (C.BALANCE.newbieProtectionH + 1) * 3600 * 1000; // не новосёл
};

test('заряд противогаза не размножается передачей туда-обратно', () => {
  const { game } = makeWorld();
  const [a, b] = ['Иван', 'Мария'].map((n) => join(game, n));
  game.addItem(a, 'gasmask', 1, 0);
  game.addItem(b, 'gasmask', 1, 100);
  // A отдаёт пустой противогаз B, B возвращает одну штуку
  game.addItem(b, 'gasmask', 1, game.chargeOf(a, 'gasmask'));
  game.removeItem(a, 'gasmask', 1);
  const back = game.chargeOf(b, 'gasmask');
  game.removeItem(b, 'gasmask', 1);
  game.addItem(a, 'gasmask', 1, back);
  assert.equal(a.gasmaskCharge + b.gasmaskCharge, 100, 'общий заряд не вырос');
});

test('лимит подарков новосёла: обмен «много за копейку» и «в долг» тоже под лимитом', () => {
  const { game } = makeWorld();
  const [n, o] = ['Новенький', 'Старожил'].map((x) => join(game, x));
  old(o);
  for (const p of [n, o]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  o.pos = { ...n.pos };
  n.money = 60;
  o.money = 5;
  const t1 = game.tradeOffer(n, o.id, { money: 20, items: {} }, { money: 1, items: {} });
  assert.equal(t1.ok, true, t1.error);
  assert.equal(game.tradeRespond(o, t1.trade, true).ok, false, '20 за 1 — подарок сверх лимита');
  const t2 = game.tradeOffer(n, o.id, { money: 30, items: {} }, { money: 0, items: { rusk: 1 } }, 7);
  assert.equal(game.tradeRespond(o, t2.trade, true).ok, false, 'в долг — тоже подарок');
  assert.equal(n.money, 60);
  // честная покупка проходит
  game.addItem(o, 'bread', 1);
  const t3 = game.tradeOffer(n, o.id, { money: 2, items: {} }, { money: 0, items: { bread: 1 } });
  assert.equal(game.tradeRespond(o, t3.trade, true).ok, true);
});

test('снимок перед опасной командой сохраняется, только если команда удалась', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  game.admin('kill', { id: a.id, cause: 'тест' });
  assert.equal(game.snapshots.length, 1);
  for (let i = 0; i < 10; i++) game.admin('kill', { id: 'нет_такого' });
  assert.equal(game.snapshots.length, 1, 'неудачные команды не вытесняют точки отката');
});

test('подсобки: перезарядка общая на жильца, обчищенная подсобка до завтра пуста для всех', () => {
  const { game, clock } = makeWorld({ random: () => 0.99 });
  const [p, q] = ['Иван', 'Пётр'].map((n) => join(game, n));
  for (const x of [p, q]) {
    game.admin('teleport', { id: x.id, place: 'corridor', floor: 99 });
    game.admin('give', { id: x.id, item: 'crowbar', count: 1, silent: true });
  }
  const doors = game.sceneOf(p).objects.filter((o) => o.type === 'locked');
  assert.ok(doors.length >= 2);
  p.pos = { ...doors[0].spot, d: 'up' };
  assert.match(game.searchStash(p).message, /нашлось/);
  p.pos = { ...doors[1].spot, d: 'up' };
  assert.equal(game.searchStash(p).ok, false, 'к соседней двери — тоже после перезарядки');
  q.pos = { ...doors[0].spot, d: 'up' };
  assert.match(game.searchStash(q).message, /уже всё вынесли/);
  clock.t += 1000;
  game.world.gameMinutes += 1440; // следующие сутки
  clock.t += C.BALANCE.stashCooldownMin * 60000;
  q.pos = { ...doors[0].spot, d: 'up' };
  assert.match(game.searchStash(q).message, /нашлось/);
});

test('план дома считают по тем, кто бывает в игре, а не по заброшенным', () => {
  const { game, clock } = makeWorld();
  const active = ['А', 'Б', 'В', 'Г'].map((n) => join(game, `Жилец${n}`));
  const gone = [];
  for (let i = 0; i < 20; i++) {
    const g = join(game, `Ушедший${'абвгдежзиклмнопрстуф'[i]}`);
    game.setOnline(g.id, false);
    gone.push(g);
  }
  clock.t += 8 * 24 * 60000;
  for (const g of gone) g.lastSeen = clock.t - 8 * 24 * 60000;
  for (const p of active) p.lastSeen = clock.t;
  game.world.plan = null;
  game.planCheck();
  assert.equal(game.world.plan.target, Math.max(20, active.length * C.BALANCE.planShiftsPerResident));
  assert.ok(active.length > 0);
});

test('петля на лестнице: тело ушедшего жильца проходит её один раз и ждёт', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 100 });
  game.admin('breakdown', { key: 'lift', broken: true });
  game.admin('anomaly', { kind: 'stairLoop', from: 100, to: 101, harm: true });
  const sanity = p.stats.sanity;
  game.setOnline(p.id, false);
  advance(10 * 60 * 1000);
  const loops = game.state.log.filter((e) => /петля на лестнице/.test(e.text)).length;
  assert.equal(loops, 1);
  assert.ok(p.stats.sanity >= sanity - 7, 'рассудок не обнулился');
  assert.ok(p.alive);
});

test('аварийный наряд: поломку переставили «не чинить» — наряд отменён без премии; на паузе часы стоят', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  walkTo(game, p, (o) => o.type === 'lift');
  game.admin('breakdown', { key: 'lift', broken: true, durationMin: 10, repairable: true });
  const r = game.repairStart(p);
  assert.equal(r.ok, true, r.error);
  game.admin('breakdown', { key: 'lift', broken: true, durationMin: 60 });
  const res = game.repairFinish(p, p.job, 1);
  assert.match(res.result.text, /наряд отменён/);
  assert.equal(p.money, 0);
  // пауза: сдача наряда не засчитывает время паузы
  game.admin('breakdown', { key: 'lift', broken: false });
  clock.t += C.BALANCE.repairCooldownSec * 1000;
  game.admin('breakdown', { key: 'lift', broken: true, durationMin: C.BALANCE.repairMinutes + 1, repairable: true });
  p.job = null;
  const r2 = game.repairStart(p);
  assert.equal(r2.ok, true, r2.error);
  game.admin('pause', { paused: true });
  clock.t += 5 * 60000;
  const res2 = game.repairFinish(p, p.job, 1);
  assert.doesNotMatch(res2.result.text, /починено/, 'пауза не чинит лифт');
  assert.ok(game.world.breakdowns.lift);
  game.admin('pause', { paused: false });
  assert.ok(Math.abs(game.world.breakdowns.lift.until - clock.t - 60000) < 2000, 'осталась ровно минута');
});

test('авария в цеху не срывает подработку в столовой; перезапуск возвращает ровно цену работы', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'canteen' });
  walkTo(game, p, (o) => o.type === 'counter');
  game.world.gameMinutes = Math.floor(game.world.gameMinutes / 1440) * 1440 + 12 * 60 + 5;
  const energy = p.stats.energy;
  assert.equal(game.sideJobStart(p, 'serve').ok, true);
  game.admin('breakdown', { key: 'factory', broken: true, durationMin: 5 });
  assert.ok(p.job, 'подработка идёт');
  const restarted = new Game(JSON.parse(JSON.stringify(game.state)));
  const q = restarted.getPlayer(p.id);
  assert.equal(Math.round(q.stats.energy), Math.round(energy), 'вернули столько, сколько стоила подработка');
  assert.equal(Math.round(q.stats.hunger), Math.round(p.stats.hunger), 'сытость за подработку не списывали — и не возвращаем');
});

test('мёртвый не перекладывает вещи; соседние кладовки не склеиваются; замурованная квартира подписана', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.addItem(p, 'bread', 2);
  game.kill(p, 'тест');
  assert.equal(game.windowPut(p, 'bread', 1).ok, false);
  assert.equal(game.payRent(p).ok, false);
  const ok = game.admin('replan', { scene: 'corridor:101', kind: 'closet', x: 3, y: 1, items: { stew: 1 } });
  assert.equal(ok.ok, true, ok.error);
  const near = game.admin('replan', { scene: 'corridor:101', kind: 'closet', x: 4, y: 1, items: { gasmask: 1 } });
  assert.equal(near.ok, false);
  const wall = game.admin('replan', { scene: 'corridor:101', kind: 'wall', x: 9, y: 1 });
  assert.match(wall.message, /кв\. 101/);
});

test('журнал богов: отказы по роли схлопываются; учётки и жильцы с «__proto__» не проходят', async () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  game.admin('ban', { id: a.id, minutes: 5, reason: 'тест' }, { who: 'root', role: 'god' });
  for (let i = 0; i < 3500; i++) game.admin('kill', { id: a.id }, { who: 'глаз', role: 'observer' });
  assert.ok(game.state.godLog.some((e) => e.cmd === 'ban'), 'настоящие записи не затёрты');
  const denied = game.state.godLog.filter((e) => e.denied);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].count, 3500);
  assert.equal(game.getPlayer('__proto__'), null);
  assert.equal(game.getPlayer('constructor'), null);
  assert.equal(game.admin('adminAdd', { login: '__proto__', password: 'backdoor123', role: 'god' }).ok, false);
  assert.equal(await game.verifyAdminAsync('__proto__', 'backdoor123'), null);
  // смена пароля учётки закрывает её открытые Пульты; старый пароль после смены не пускает
  const closed = [];
  game.on('admin_removed', (k) => closed.push(k));
  game.admin('adminAdd', { login: 'moder', password: 'secret123', role: 'moderator' });
  const pending = game.verifyAdminAsync('moder', 'secret123');
  game.admin('adminAdd', { login: 'moder', password: 'другой123', role: 'observer' });
  assert.equal(await pending, null, 'пароль сменили, пока он проверялся');
  assert.deepEqual(closed, ['moder']);
});

test('заявления: отправленные не вытесняются; автор ждёт ответа, прежде чем писать новое', () => {
  const { game } = makeWorld();
  const ps = ['Иван', 'Мария', 'Пётр'].map((n) => join(game, n));
  for (const p of ps) {
    game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
    walkTo(game, p, (o) => o.type === 'board');
  }
  const real = game.createPetition(ps[0], 'Почините наконец лифт на сто первом');
  assert.equal(real.ok, true, real.error);
  for (const p of ps.slice(1)) game.signPetition(p, game.state.petitions[0].id);
  assert.equal(game.state.petitions[0].status, 'sent');
  assert.equal(game.createPetition(ps[0], 'Ещё одно заявление от того же').ok, false);
  // много закрытых — отправленное остаётся
  for (let i = 0; i < 80; i++) game.state.petitions.push({ id: `x${i}`, floor: 101, text: 'старое', authorId: 'x', signers: [], status: 'done', createdAt: game.now(), resolvedAt: game.now() });
  game.expirePetitions(game.now());
  assert.ok(game.state.petitions.some((x) => x.status === 'sent'));
});

test('молва: подарки одному и тому же по сухарю не делают «щедрым»; «не открывает» — тому, кто не открыл', () => {
  const { game } = makeWorld();
  const [a, b] = ['Иван', 'Мария'].map((n) => join(game, n));
  for (let i = 0; i < 20; i++) game.markDeed(a, 'gift', b.id);
  assert.equal(a.deedLog.filter((d) => d.k === 'gift').length, 1);
  // отказ в туман: хозяин погиб, квартиру занял новый — молва не на новом
  const guest = join(game, 'Гость');
  const host = join(game, 'Хозяин');
  game.refusals.set(guest.id, { apt: host.apartment.number, owner: host.name, ownerId: host.id, ts: game.now(), kind: 'ignored' });
  game.kill(host, 'тест');
  game.kill(guest, 'Погиб в тумане');
  assert.ok(!game.alivePlayers().some((q) => (q.deedLog || []).some((d) => d.k === 'cold')));
});

test('торшер: дома светло — карманник не крадёт и в отключённый свет', () => {
  const { game } = makeWorld({ random: () => 0.1 });
  const [host, thief] = ['Хозяин', 'Вор'].map((n) => join(game, n));
  old(host);
  old(thief);
  game.admin('give', { id: host.id, item: 'torchere', count: 1, silent: true });
  assert.equal(game.useItem(host, 'torchere').ok, true);
  thief.location = { ...host.location };
  thief.pos = { ...host.pos };
  host.money = 5;
  game.admin('power', { on: false, from: 101, to: 101 });
  assert.equal(game.pickpocket(thief, host.id).ok, false);
  assert.equal(host.money, 5);
});
