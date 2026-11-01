'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const C = require('../server/content');
const World = require('../public/shared/world');

/** Мир с управляемым временем: clock.advance(ms) + тики. */
function makeWorld({ random = () => 0.99 } = {}) {
  const clock = { t: 1_000_000 };
  const game = new Game(null, { now: () => clock.t, random });
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

/** Поставить жильца вплотную к объекту текущей сцены (как будто он туда дошёл). */
function walkTo(game, p, test) {
  const o = game.sceneOf(p).objects.find(test);
  assert.ok(o, 'такой объект есть в сцене');
  p.pos = { x: o.spot.x, y: o.spot.y, d: 'up' };
  return o;
}
const type = (t) => (o) => o.type === t;

test('новосёл получает пустую квартиру на первом жилом этаже', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  assert.equal(a.apartment.floor, C.BUILDING.firstResidentialFloor);
  assert.equal(a.apartment.number, `${C.BUILDING.firstResidentialFloor}01`);
  assert.equal(b.apartment.number, `${C.BUILDING.firstResidentialFloor}02`);
  assert.equal(a.money, 0);
  assert.deepEqual(a.inventory, {});
  assert.equal(a.location.place, 'home');
});

test('плохие имена отклоняются', () => {
  const { game } = makeWorld();
  assert.equal(game.register('').ok, false);
  assert.equal(game.register('<').ok, false);
  assert.equal(game.register('  Пётр  ').player.name, 'Пётр');
});

test('квартира погибшего достаётся следующему жильцу', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  game.kill(a, 'тест');
  const b = join(game, 'Мария');
  assert.equal(b.apartment.number, a.apartment.number);
});

test('путь в столовую: к двери, в коридор, к лифту, вниз, к двери столовой', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  const canteenFloor = C.FACILITIES.canteen.floor;

  walkTo(game, p, type('bed'));
  assert.equal(game.move(p, { place: 'corridor' }).ok, false, 'от кровати в коридор не выйти');
  walkTo(game, p, type('hermodoor'));
  assert.equal(game.move(p, { place: 'corridor' }).ok, true);
  assert.equal(game.locationKey(p), `corridor:${p.apartment.floor}`);
  const door = game.sceneOf(p).objects.find((o) => o.type === 'apt' && o.number === p.apartment.number);
  assert.ok(Math.hypot(p.pos.x - door.spot.x, p.pos.y - door.spot.y) < 0.01, 'вышел у своей двери');

  assert.equal(game.move(p, { place: 'canteen' }).ok, false, 'столовая на другом этаже');
  assert.equal(game.move(p, { place: 'corridor', floor: canteenFloor }).ok, false, 'надо подойти к лифту');
  walkTo(game, p, type('lift'));
  assert.equal(game.move(p, { place: 'corridor', floor: p.apartment.floor }).ok, false, 'уже на этом этаже');
  assert.equal(game.move(p, { place: 'corridor', floor: canteenFloor }).ok, true);
  assert.equal(p.location.place, 'lift');

  game.admin('breakdown', { key: 'lift', broken: true });
  advance(10000);
  assert.equal(p.location.place, 'lift');
  assert.equal(p.travel.stuck, true, 'застрял');
  game.admin('breakdown', { key: 'lift', broken: false });
  advance(10000);
  assert.equal(game.locationKey(p), `corridor:${canteenFloor}`);

  walkTo(game, p, (o) => o.type === 'facility' && o.facility === 'canteen');
  assert.equal(game.move(p, { place: 'canteen' }).ok, true);
  assert.equal(p.location.place, 'canteen');
  walkTo(game, p, type('exit'));
  assert.equal(game.move(p, { place: 'corridor' }).ok, true);
  assert.equal(game.locationKey(p), `corridor:${canteenFloor}`);
});

test('лестница стоит сил; сломанный лифт не везёт; с переломом ноги по лестнице нельзя', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('breakdown', { key: 'lift', broken: true });
  walkTo(game, p, type('lift'));
  assert.equal(game.move(p, { place: 'corridor', floor: 96, via: 'lift' }).ok, false);
  assert.equal(game.move(p, { place: 'corridor', floor: 96, via: 'stairs' }).ok, false, 'лестница в другом конце коридора');
  walkTo(game, p, type('stairs'));
  const before = p.stats.energy;
  assert.equal(game.move(p, { place: 'corridor', floor: 96, via: 'stairs' }).ok, true);
  assert.equal(p.travel.via, 'stairs');
  assert.ok(p.stats.energy < before);

  const q = join(game, 'Пётр');
  game.admin('teleport', { id: q.id, place: 'corridor', floor: 101 });
  walkTo(game, q, type('stairs'));
  game.addCondition(q, 'leg');
  assert.equal(game.move(q, { place: 'corridor', floor: 96, via: 'stairs' }).ok, false);
});

test('домой — только с своего этажа и от своей двери; задраенная дверь не выпускает', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 102 });
  assert.equal(game.move(p, { place: 'home' }).ok, false);
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  walkTo(game, p, (o) => o.type === 'apt' && o.number !== p.apartment.number);
  assert.equal(game.move(p, { place: 'home' }).ok, false, 'чужая дверь');
  walkTo(game, p, (o) => o.type === 'apt' && o.number === p.apartment.number);
  assert.equal(game.move(p, { place: 'home' }).ok, true);
  walkTo(game, p, type('hermodoor'));
  assert.equal(game.seal(p, true).ok, true);
  assert.equal(game.move(p, { place: 'corridor' }).ok, false);
  assert.equal(game.seal(p, false).ok, true);
  assert.equal(game.move(p, { place: 'corridor' }).ok, true);
});

test('движение: сквозь стены и прыжками ходить нельзя', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  const start = { ...p.pos };
  clock.t += 100;
  assert.equal(game.setPos(p, start.x + 0.4, start.y, 'right'), true, 'обычный шаг');
  clock.t += 100;
  assert.equal(game.setPos(p, start.x + 0.4, 0.5, 'up'), false, 'в стену');
  clock.t += 100;
  assert.equal(game.setPos(p, start.x + 15, start.y, 'right'), false, 'телепорт');
  assert.equal(game.setPos(p, 'abc', 1, 'up'), false);
  // за секунду можно уйти на несколько клеток
  for (let i = 1; i <= 10; i++) {
    clock.t += 100;
    assert.equal(game.setPos(p, start.x + 0.4 + i * 0.4, start.y, 'right'), true, `шаг ${i}`);
  }
});

test('работа: смена тратит силы, правильные ответы дают талоны', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'factory' });
  assert.equal(game.workStart(p, 'sort').ok, false, 'надо подойти к станку');
  walkTo(game, p, (o) => o.type === 'station' && o.game === 'meter');
  assert.equal(game.workStart(p, 'sort').ok, false, 'это другой станок');
  walkTo(game, p, (o) => o.type === 'station' && o.game === 'sort');
  const energy = p.stats.energy;
  const res = game.workStart(p, 'sort');
  assert.equal(res.ok, true);
  assert.equal(p.stats.energy, energy - C.BALANCE.workEnergyCost);
  clock.t += 10000;
  const answers = p.job.secret.answers.slice();
  const done = game.workSubmit(p, res.job.id, answers);
  assert.equal(done.ok, true);
  assert.equal(done.result.score, 1);
  assert.ok(p.money >= 6);
});

test('работа недоступна со сломанной рукой и при аварии в цеху', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'factory' });
  walkTo(game, p, (o) => o.type === 'station' && o.game === 'sort');
  game.addCondition(p, 'arm');
  assert.equal(game.workStart(p, 'sort').ok, false);
  game.cureCondition(p, 'arm');
  game.admin('breakdown', { key: 'factory', broken: true });
  assert.equal(game.workStart(p, 'sort').ok, false);
});

test('столовая: покупка за талоны; после кражи ложек суп только со своей ложкой', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'canteen' });
  p.money = 20;
  assert.equal(game.buy(p, 'canteen', 'bread').ok, false, 'надо подойти к раздаче');
  walkTo(game, p, type('counter'));
  p.money = 0;
  assert.equal(game.buy(p, 'canteen', 'bread').ok, false, 'нет денег');
  p.money = 20;
  assert.equal(game.buy(p, 'canteen', 'bread').ok, true);
  assert.equal(p.inventory.bread, 1);
  assert.equal(game.buy(p, 'canteen', 'spoon').ok, true);

  game.admin('cutlery', { steal: true, percent: 100 });
  assert.equal(p.inventory.spoon, undefined, 'ложку украли');
  assert.equal(game.buy(p, 'canteen', 'soup').ok, false);
  assert.equal(game.buy(p, 'canteen', 'spoon').ok, false);
  game.addItem(p, 'spoon');
  assert.equal(game.buy(p, 'canteen', 'soup').ok, true);
});

test('туман: снаружи калечит, за задраенной гермодверью — безопасно', () => {
  const { game, advance } = makeWorld();
  const outside = join(game, 'Снаружи');
  const inside = join(game, 'Внутри');
  game.admin('teleport', { id: outside.id, place: 'corridor', floor: outside.apartment.floor });
  walkTo(game, inside, type('hermodoor'));
  assert.equal(game.seal(inside, true).ok, true);
  game.admin('fog', { from: 100, to: 110, warnSec: 5, durationMin: 6, intensity: 1 });
  advance(5000);
  assert.equal(game.fogPhase(), 'active');
  advance(60000);
  assert.ok(outside.stats.health < 90, `здоровье снаружи: ${outside.stats.health}`);
  assert.equal(Math.round(inside.stats.health), 100);
  advance(6 * 60000);
  assert.equal(game.world.fog, null, 'туман рассеялся сам');
  advance(C.BALANCE.downSec * 1000);
  assert.equal(outside.alive, false, 'кто не спрятался — тот погиб (никто не помог, пока лежал без сознания)');
  assert.equal(outside.deathCause, 'Погиб в тумане');
});

test('противогаз снижает урон от тумана и изнашивается', () => {
  const { game, advance } = makeWorld();
  const bare = join(game, 'Без');
  const masked = join(game, 'В маске');
  for (const p of [bare, masked]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.addItem(masked, 'gasmask');
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 5 });
  advance(60000);
  assert.ok(masked.stats.health > bare.stats.health + 10);
  assert.ok(masked.gasmaskCharge < 100);
});

test('голод убивает', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('setStats', { id: p.id, stats: { hunger: 0, health: 5 } });
  advance(60000);
  assert.equal(p.alive, false);
  assert.equal(p.deathCause, 'Умер от голода');
});

test('болезнь лечится таблетками; заразная — передаётся соседу', () => {
  const { game, advance } = makeWorld({ random: () => 0 });
  const a = join(game, 'Больной');
  const b = join(game, 'Соседка');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'canteen' });
  game.admin('infect', { target: { type: 'player', id: a.id }, condition: 'flu' });
  advance(2000);
  assert.ok(game.hasCondition(b, 'flu'), 'сосед заразился');

  assert.equal(game.useItem(a, 'pills').ok, false, 'таблеток нет');
  game.addItem(a, 'pills');
  assert.equal(game.useItem(a, 'pills').ok, true);
  assert.equal(game.hasCondition(a, 'flu'), false);
});

test('обмен: подарок сразу, обмен — после согласия; только рядом', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  a.money = 10;
  game.addItem(b, 'bread', 2);

  assert.equal(game.tradeOffer(a, b.id, { money: 3 }, {}).ok, true);
  assert.equal(a.money, 7);
  assert.equal(b.money, 3);

  const offer = game.tradeOffer(a, b.id, { money: 4 }, { items: { bread: 1 } });
  assert.equal(offer.ok, true);
  assert.equal(game.tradeRespond(a, offer.trade, true).ok, false, 'принять может только второй');
  assert.equal(game.tradeRespond(b, offer.trade, true).ok, true);
  assert.equal(a.money, 3);
  assert.equal(a.inventory.bread, 1);
  assert.equal(b.inventory.bread, 1);

  assert.equal(game.tradeOffer(a, b.id, { money: 100 }, {}).ok, false, 'нет денег');
  walkTo(game, b, type('stairs'));
  assert.equal(game.tradeOffer(a, b.id, { money: 1 }, {}).ok, false, 'далеко в коридоре');
  game.admin('teleport', { id: b.id, place: 'canteen' });
  assert.equal(game.tradeOffer(a, b.id, { money: 1 }, {}).ok, false, 'вообще в другом месте');
});

test('стук в дверь слышит хозяин, если он дома', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  assert.equal(game.knock(a, b.apartment.number).ok, false, 'надо подойти');
  walkTo(game, a, (o) => o.type === 'apt' && o.number === b.apartment.number);
  const res = game.knock(a, b.apartment.number);
  assert.equal(res.ok, true);
  assert.ok(notes.some((n) => n.to.includes(b.id) && n.title === 'Стук в дверь'));
  assert.equal(game.knock(a, b.apartment.number).ok, false, 'не так часто');
  clock.t += 4000;
  game.admin('teleport', { id: b.id, place: 'canteen' });
  assert.match(game.knock(a, b.apartment.number).message, /нет дома/);
});

test('мусоропровод: иногда находка, потом пауза', () => {
  const { game, clock } = makeWorld({ random: () => 0.1 });
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  walkTo(game, p, type('chute'));
  assert.equal(game.searchChute(p).ok, true);
  assert.equal(p.inventory.rusk, 1);
  assert.equal(game.searchChute(p).ok, false, 'надо подождать');
  clock.t += 6 * 60000;
  assert.equal(game.searchChute(p).ok, true);
});

test('доска объявлений показывает сообщения радиоточки', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('announce', { text: 'Завтра отключат воду.' });
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  assert.equal(game.readBoard(p).ok, false);
  walkTo(game, p, type('board'));
  const res = game.readBoard(p);
  assert.equal(res.ok, true);
  assert.equal(res.notes[0].text, 'Завтра отключат воду.');
});

test('сон — у кровати; ушедший из игры засыпает у себя в кровати', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  assert.equal(game.sleep(p, true).ok, false);
  walkTo(game, p, type('bed'));
  assert.equal(game.sleep(p, true).ok, true);
  game.admin('teleport', { id: p.id, place: 'factory' });
  game.setOnline(p.id, false);
  assert.equal(p.location.place, 'factory', 'мгновенно домой не переносит');
  advance(60000);
  assert.equal(p.location.place, 'home');
  assert.ok(game.nearTo(p, type('bed')), 'лежит у кровати');
  assert.equal(p.sleeping, true);
});

test('админ: несчастный случай, смерть и воскрешение', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.admin('accident', { id: p.id, accident: 'armBreak' });
  assert.ok(game.hasCondition(p, 'arm'));
  assert.ok(notes.some((n) => n.title === C.ACCIDENTS.armBreak.name));

  game.admin('accident', { id: p.id, accident: 'liftShaft' });
  assert.equal(p.alive, false);
  assert.equal(p.deathCause, C.ACCIDENTS.liftShaft.name);

  assert.equal(game.admin('revive', { id: p.id }).ok, true);
  assert.equal(p.alive, true);
  assert.equal(p.location.place, 'home');
});

test('админ: цели событий и произвольное событие', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.admin('teleport', { id: b.id, place: 'factory' });
  assert.equal(game.resolveTargets({ type: 'floors', from: 101, to: 101 }).length, 1);
  assert.equal(game.resolveTargets({ type: 'place', place: 'factory' })[0], b);
  assert.equal(game.resolveTargets({ type: 'random', count: 1 }).length, 1);

  const res = game.admin('custom', {
    target: { type: 'all' },
    title: 'Прорвало трубу',
    text: 'Вода по колено',
    effect: { health: -10, money: 5, items: { bread: 1 } },
  });
  assert.equal(res.ok, true);
  for (const p of [a, b]) {
    assert.equal(p.stats.health, 90);
    assert.equal(p.money, 5);
    assert.equal(p.inventory.bread, 1);
  }
});

test('отключение света закрывает учреждения на этаже', () => {
  const { game } = makeWorld();
  const floor = C.FACILITIES.canteen.floor;
  assert.equal(game.facilityStatus('canteen').open, true);
  game.admin('power', { on: false, from: floor, to: floor });
  assert.equal(game.facilityStatus('canteen').open, false);
  game.admin('power', { on: true });
  assert.equal(game.facilityStatus('canteen').open, true);
});

test('поломка с таймером чинится сама', () => {
  const { game, advance } = makeWorld();
  game.admin('breakdown', { key: 'canteen', broken: true, durationMin: 1 });
  assert.equal(game.facilityStatus('canteen').open, false);
  advance(61000);
  assert.equal(game.facilityStatus('canteen').open, true);
});

test('пауза замораживает мир', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('pause', { paused: true });
  const h = p.stats.hunger;
  advance(30000);
  assert.equal(p.stats.hunger, h);
});

test('состояние переживает сохранение и загрузку', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.addItem(p, 'stew', 2);
  const restored = new Game(JSON.parse(JSON.stringify(game.state)));
  const again = restored.playerByToken(p.token);
  assert.equal(again.name, 'Иван');
  assert.equal(again.inventory.stew, 2);
});

test('вид игрока собирается для всех мест', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  for (const place of ['home', 'corridor', 'canteen', 'medpost', 'factory']) {
    game.admin('teleport', { id: p.id, place, floor: 101 });
    const view = game.playerView(p);
    assert.equal(view.here.place, place);
    assert.ok(view.here.title);
  }
  assert.ok(game.adminSnapshot().players.length === 1);
});

test('имена: служебные и занятые живыми жильцами нельзя', () => {
  const { game } = makeWorld();
  join(game, 'Иван');
  assert.equal(game.register('ЖЭК').ok, false);
  assert.equal(game.register('радиоточка').ok, false);
  assert.equal(game.register('иван').ok, false, 'регистр не важен');
  const dead = join(game, 'Пётр');
  game.kill(dead, 'тест');
  assert.equal(game.register('Пётр').ok, true, 'имя погибшего свободно');
});

test('дом переполнен — ошибка, а не падение сервера', () => {
  const { game } = makeWorld();
  const old = C.BUILDING.maxFloor;
  C.BUILDING.maxFloor = C.BUILDING.firstResidentialFloor;
  try {
    for (let i = 0; i < C.BUILDING.apartmentsPerFloor; i++) assert.equal(game.register(`Жилец${i}`).ok, true);
    const res = game.register('Лишний');
    assert.equal(res.ok, false);
    assert.match(res.error, /переполнен/);
  } finally {
    C.BUILDING.maxFloor = old;
  }
});

test('галлюцинации говорят выдуманными голосами, не именами соседей', () => {
  const { game } = makeWorld({ random: () => 0 });
  const p = join(game, 'Иван');
  join(game, 'Мария');
  const msgs = [];
  game.on('chat', (m) => msgs.push(m));
  game.hallucinate(p);
  assert.equal(msgs[0].to, p.id);
  assert.ok(C.HALLUCINATION_VOICES.includes(msgs[0].from.name));
  assert.equal(msgs[0].from.apt, '???');
});

test('Пульт не может писать в чат от имени живого жильца', () => {
  const { game } = makeWorld();
  join(game, 'Иван');
  assert.equal(game.admin('chat', { text: 'привет', as: 'иван' }).ok, false);
  assert.equal(game.admin('chat', { text: 'привет', as: 'ЖЭК' }).ok, true);
});

test('давно погибшие уходят в архив домовой книги', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.kill(p, 'тест');
  game.archiveDead();
  assert.ok(game.getPlayer(p.id), 'свежий погибший ещё в Пульте');
  clock.t += (C.ARCHIVE_DEAD_AFTER_H + 1) * 3600 * 1000;
  game.archiveDead();
  assert.equal(game.getPlayer(p.id), null);
  assert.equal(game.playerByToken(p.token), null);
  assert.equal(game.state.archive[0].name, 'Иван');
  assert.equal(game.adminSnapshot().archived, 1);
});

test('выход из игры не спасает: тело идёт домой ногами', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 120 });
  game.setOnline(p.id, false);
  assert.ok(p.homeward);
  advance(1000);
  assert.equal(p.location.place, 'corridor', 'ещё в пути');
  advance(30000);
  assert.equal(game.locationKey(p), `home:${p.apartment.number}`);
  assert.equal(p.homeward, null);
});

test('застрявший в лифте и после выхода остаётся в кабине', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  walkTo(game, p, type('lift'));
  game.move(p, { place: 'corridor', floor: 50, via: 'lift' });
  game.admin('breakdown', { key: 'lift', broken: true });
  advance(2000);
  game.setOnline(p.id, false);
  advance(5 * 60000);
  assert.equal(p.location.place, 'lift');
  assert.equal(p.travel.stuck, true);
  game.admin('breakdown', { key: 'lift', broken: false });
  advance(60000);
  assert.equal(p.location.place, 'home', 'лифт починили — доехал и дошёл домой');
});

test('тело ушедшего: в тумане на своём этаже не замирает, а идёт домой', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 3 });
  game.setOnline(p.id, false);
  advance(15000);
  assert.equal(p.location.place, 'home', 'добрёл до своей двери');
  assert.ok(p.stats.health < 100, 'по дороге туман бил');
});

test('тело ушедшего: с безопасного этажа в туман не идёт — ждёт отбоя', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'canteen' });
  game.admin('fog', { from: 101, to: 110, warnSec: 0, durationMin: 2, intensity: 3 });
  game.setOnline(p.id, false);
  advance(60000);
  assert.equal(game.locationKey(p), 'corridor:100', 'вышло из столовой, но к лифту в туман не поехало');
  assert.equal(Math.round(p.stats.health), 100);
  advance(2 * 60000);
  assert.equal(p.location.place, 'home', 'после отбоя дошло');
});

test('тело ушедшего: по лестнице — только если хватает сил; сломался лифт в пути — застряло', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 400 });
  game.admin('breakdown', { key: 'lift', broken: true });
  game.admin('setStats', { id: p.id, stats: { energy: 5 } });
  game.setOnline(p.id, false);
  advance(3 * 60000);
  assert.equal(game.locationKey(p), 'corridor:400', 'сил на 299 этажей нет — стоит');

  const q = join(game, 'Мария');
  game.admin('breakdown', { key: 'lift', broken: false });
  game.admin('teleport', { id: q.id, place: 'corridor', floor: 300 });
  game.setOnline(q.id, false);
  advance(2000);
  assert.equal(q.location.place, 'lift', 'поехало на лифте');
  game.admin('breakdown', { key: 'lift', broken: true });
  advance(60000);
  assert.equal(q.travel.stuck, true, 'лифт сломался в пути — застряло, как застрял бы живой');
});

test('голод сам по себе не убивает того, кто не в сети', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('setStats', { id: p.id, stats: { hunger: 12 } });
  game.setOnline(p.id, false);
  advance(3 * 3600 * 1000 / 20); // ускоренно: несколько часов тиков не нужны — порог проверяется каждый тик
  assert.ok(p.stats.hunger >= C.BALANCE.offlineHungerFloor - 0.001);
  game.admin('setStats', { id: p.id, stats: { hunger: 0, health: 30 } });
  advance(10 * 60000);
  assert.equal(p.alive, true, 'от голода отсутствующий не умирает');
});

test('квитанция ЖЭК: кто стучал и что случилось, пока вас не было', () => {
  const { game, clock, advance } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.setOnline(a.id, false);
  game.admin('teleport', { id: b.id, place: 'corridor', floor: 101 });
  walkTo(game, b, (o) => o.type === 'apt' && o.number === a.apartment.number);
  game.knock(b, a.apartment.number);
  game.admin('breakdown', { key: 'canteen', broken: true });
  clock.t += 10 * 60000;
  advance(1000);
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.setOnline(a.id, true);
  const receipt = notes.find((n) => n.style === 'receipt');
  assert.ok(receipt, 'квитанция пришла');
  assert.match(receipt.text, /Вас не было/);
  assert.match(receipt.text, /Стучали в дверь: Мария/);
  assert.match(receipt.text, /сломано: столовая/);
});

test('отсутствующие видны соседям в сцене, но помечены', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.setOnline(a.id, false);
  const actors = game.sceneActors('corridor:101');
  assert.equal(actors.find((x) => x.id === a.id).away, true);
  assert.equal(actors.find((x) => x.id === b.id).away, false);
});

test('записка и передачка под дверь: хозяин находит дома, даже если его не было', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  const feed = [];
  game.on('chat', (m) => m.adminOnly && feed.push(m));
  game.setOnline(a.id, false);
  game.admin('teleport', { id: b.id, place: 'corridor', floor: 101 });
  b.money = 10;
  game.addItem(b, 'bread', 2);
  assert.equal(game.slipNote(b, a.apartment.number, 'привет').ok, false, 'надо подойти');
  walkTo(game, b, (o) => o.type === 'apt' && o.number === a.apartment.number);
  assert.equal(game.slipNote(b, a.apartment.number, 'Держись, сосед', true).ok, true);
  assert.equal(game.leaveParcel(b, a.apartment.number, { money: 3, items: { bread: 1 } }, 'на ужин').ok, false, 'не так часто');
  clock.t += 10000;
  assert.equal(game.leaveParcel(b, a.apartment.number, { money: 30 }).ok, false, 'нет таких денег');
  assert.equal(game.leaveParcel(b, a.apartment.number, { money: 3, items: { bread: 1 } }, 'на ужин').ok, true);
  assert.equal(b.money, 7);
  assert.equal(b.inventory.bread, 1);
  assert.equal(feed.length, 2, 'Пульт видит обе передачи');
  assert.equal(feed[0].anon, true);
  assert.equal(feed[0].from.name, 'Мария', 'ЖЭК знает автора анонимки');

  // хозяин возвращается домой
  clock.t += 10 * 60000;
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.setOnline(a.id, true);
  const receipt = notes.find((n) => n.style === 'receipt');
  assert.match(receipt.text, /Записка без подписи: «Держись, сосед»/);
  assert.match(receipt.text, /Передачка от Мария/);
  assert.equal(a.money, 3);
  assert.equal(a.inventory.bread, 1);
  assert.equal(game.state.doorDrops[a.apartment.number], undefined);
});

test('под чужую дверь — да, под свою и пустую — нет', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  walkTo(game, a, (o) => o.type === 'apt' && o.number === a.apartment.number);
  assert.equal(game.slipNote(a, a.apartment.number, 'себе').ok, false);
  walkTo(game, a, (o) => o.type === 'apt' && o.number === '10106');
  assert.equal(game.slipNote(a, '10106', 'кому-нибудь').ok, false, 'квартира пустует');
});

test('листок на доске: один на жильца, видят соседи, Пульт может снять, со временем снимается сам', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) {
    game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
    walkTo(game, p, type('board'));
  }
  assert.equal(game.pinNote(a, 'Меняю лампочку на сухари').ok, true);
  clock.t += 10000;
  assert.equal(game.pinNote(a, 'Меняю вилку на хлеб').ok, true);
  const seen = game.readBoard(b).pinned;
  assert.equal(seen.length, 1, 'старый листок заменён');
  assert.equal(seen[0].text, 'Меняю вилку на хлеб');
  assert.equal(game.readBoard(a).pinned[0].mine, true);
  assert.equal(game.admin('unpin', { id: seen[0].id }).ok, true);
  assert.equal(game.readBoard(b).pinned.length, 0);
  clock.t += 10000;
  game.pinNote(b, 'Ищу таблетки');
  clock.t += (C.NOTES.boardTtlH + 1) * 3600 * 1000;
  game.expireBoardNotes();
  assert.equal(game.readBoard(a).pinned.length, 0, 'листок снят по сроку');
});

/** Жилец a у своей двери снаружи, хозяин b дома у гермодвери. */
function knockScene() {
  const w = makeWorld();
  const { game } = w;
  const guest = join(game, 'Иван');
  const host = join(game, 'Мария');
  game.admin('teleport', { id: guest.id, place: 'corridor', floor: 101 });
  walkTo(game, guest, (o) => o.type === 'apt' && o.number === host.apartment.number);
  walkTo(game, host, type('hermodoor'));
  return { ...w, guest, host };
}

test('гости: постучал — хозяин впустил — оба за одной гермодверью', () => {
  const { game, guest, host } = knockScene();
  assert.equal(game.openDoor(host, guest.id).ok, false, 'никто не стучал');
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.knock(guest, host.apartment.number);
  const knock = notes.find((n) => n.title === 'Стук в дверь');
  assert.deepEqual(knock.action, { label: 'Открыть', act: 'open_door', args: { guest: guest.id } });
  assert.equal(game.playerView(host).you.knocker.id, guest.id);
  assert.equal(game.openDoor(host, guest.id).ok, true);
  assert.equal(game.locationKey(guest), `home:${host.apartment.number}`);
  assert.equal(game.locationKey(guest), game.locationKey(host));
  assert.equal(game.playerView(guest).here.ownHome, false);
  assert.equal(game.playerView(host).here.ownHome, true);
  // гермодверь общая: задраил гость — защищены оба
  walkTo(game, guest, type('hermodoor'));
  assert.equal(game.seal(guest, true).ok, true);
  assert.equal(game.playerView(host).you.sealed, true);
  assert.equal(game.move(guest, { place: 'corridor' }).ok, false, 'задраено — не выйти');
  game.seal(guest, false);
  assert.equal(game.move(guest, { place: 'corridor' }).ok, true);
  assert.equal(game.locationKey(guest), 'corridor:101');
  const door = game.sceneOf(guest).objects.find((o) => o.type === 'apt' && o.number === host.apartment.number);
  assert.ok(Math.hypot(guest.pos.x - door.spot.x, guest.pos.y - door.spot.y) < 0.01, 'вышел у двери хозяина');
});

test('гость пережидает туман за чужой задраенной дверью', () => {
  const { game, advance, guest, host } = knockScene();
  game.admin('fog', { from: 101, to: 101, warnSec: 10, durationMin: 3 });
  game.knock(guest, host.apartment.number);
  game.openDoor(host, guest.id);
  game.seal(host, true);
  advance(2 * 60000);
  assert.equal(Math.round(guest.stats.health), 100);
  assert.equal(Math.round(host.stats.health), 100);
});

test('выставили в туман — дом узнает, если гость погибнет', () => {
  const { game, advance, guest, host } = knockScene();
  game.knock(guest, host.apartment.number);
  game.openDoor(host, guest.id);
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 10, intensity: 3 });
  const chat = [];
  game.on('chat', (m) => chat.push(m.text));
  assert.equal(game.evict(host, guest.id).ok, true);
  assert.equal(game.locationKey(guest), 'corridor:101');
  advance(3 * 60000 + C.BALANCE.downSec * 1000);
  assert.equal(guest.alive, false);
  assert.ok(chat.some((t) => /выставили за дверь/.test(t)), chat.join(' | '));
});

test('не открыли в туман — тоже станет известно', () => {
  const { game, advance, guest, host } = knockScene();
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 10, intensity: 3 });
  const chat = [];
  game.on('chat', (m) => chat.push(m.text));
  game.knock(guest, host.apartment.number);
  advance(3 * 60000 + C.BALANCE.downSec * 1000);
  assert.equal(guest.alive, false);
  assert.ok(chat.some((t) => /ему не открыли/.test(t)));
});

test('впустить может только хозяин изнутри, и только того, кто ещё у двери', () => {
  const { game, guest, host } = knockScene();
  game.knock(guest, host.apartment.number);
  walkTo(game, host, type('bed'));
  assert.equal(game.openDoor(host, guest.id).ok, false, 'надо подойти к двери');
  walkTo(game, host, type('hermodoor'));
  walkTo(game, guest, type('lift'));
  assert.equal(game.openDoor(host, guest.id).ok, false, 'гость ушёл');
});

test('умер хозяин — гости выходят в коридор', () => {
  const { game, guest, host } = knockScene();
  game.knock(guest, host.apartment.number);
  game.openDoor(host, guest.id);
  game.kill(host, 'тест');
  assert.equal(game.locationKey(guest), 'corridor:101');
});

test('старое сохранение: гермодверь жильца переезжает на квартиру', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  const old = JSON.parse(JSON.stringify(game.state));
  const saved = old.players[p.id];
  saved.sealed = true;
  delete saved.location.apt;
  const g2 = new (require('../server/game').Game)(old);
  assert.equal(g2.doorSealed(p.apartment.number), true);
  assert.equal(g2.getPlayer(p.id).sealed, undefined);
  assert.equal(g2.locationKey(g2.getPlayer(p.id)), `home:${p.apartment.number}`);
});

test('без сознания: вне дома не умирают сразу; помощь предметом поднимает', () => {
  const { game, clock, advance } = makeWorld();
  const victim = join(game, 'Иван');
  const helper = join(game, 'Мария');
  for (const p of [victim, helper]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('accident', { id: victim.id, accident: 'shock' });
  game.admin('setStats', { id: victim.id, stats: { health: 5 } });
  game.admin('accident', { id: victim.id, accident: 'shock' });
  assert.equal(victim.alive, true);
  assert.ok(victim.down, 'лежит без сознания');
  assert.equal(game.move(victim, { place: 'home' }).ok, false, 'без сознания не ходят');
  assert.equal(game.setPos(victim, victim.pos.x + 0.1, victim.pos.y, 'right'), false);
  assert.equal(game.sceneActors('corridor:101').find((a) => a.id === victim.id).down, true);
  assert.equal(game.aid(helper, victim.id, 'bandage').ok, false, 'бинта нет');
  game.addItem(helper, 'bandage');
  assert.equal(game.aid(helper, victim.id, 'bandage').ok, true);
  assert.equal(victim.down, null);
  assert.ok(victim.stats.health >= 10);
  assert.equal(helper.inventory.bandage, undefined, 'бинт потрачен');
  advance(C.BALANCE.downSec * 1000 + 5000);
  assert.equal(victim.alive, true, 'очнулся и живёт');
  clock.t += 1;
});

test('без сознания: не помогли — смерть; обшарить карманы можно, жертва узнает, если очнётся', () => {
  const { game, advance } = makeWorld();
  const victim = join(game, 'Иван');
  const thief = join(game, 'Пётр');
  const saver = join(game, 'Мария');
  for (const p of [victim, thief, saver]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  victim.money = 9;
  game.addItem(victim, 'stew', 3);
  victim.createdAt -= (C.BALANCE.newbieProtectionH + 1) * 3600 * 1000; // уже не новосёл
  thief.createdAt -= (C.BALANCE.newbieProtectionH + 1) * 3600 * 1000; // новосёлам воровать нельзя
  assert.equal(game.rob(thief, victim.id).ok, false, 'в сознании не обшарить');
  game.admin('custom', { target: { type: 'player', id: victim.id }, title: 'Обвал', effect: { health: -200 } });
  assert.ok(victim.down);
  assert.equal(game.rob(thief, victim.id).ok, true);
  assert.equal(thief.money, 9);
  assert.equal(thief.inventory.stew, 2, 'забрал две банки из трёх');
  assert.equal(game.rob(thief, victim.id).ok, false, 'второй раз нельзя');
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.addItem(saver, 'bread');
  assert.equal(game.aid(saver, victim.id, 'bread').ok, true, 'даже хлеб приводит в чувство');
  assert.match(notes.find((n) => n.title === 'Вы очнулись').text, /рылся: Пётр/);

  game.admin('custom', { target: { type: 'player', id: victim.id }, title: 'Обвал', effect: { health: -200 } });
  advance(C.BALANCE.downSec * 1000 + 2000);
  assert.equal(victim.alive, false, 'никто не помог — умер');
  assert.equal(victim.deathCause, 'Обвал');
});

test('дома без сознания не лежат — умирают; смертельный случай и «Убить» из Пульта — сразу', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  game.admin('custom', { target: { type: 'player', id: a.id }, title: 'Сердце', effect: { health: -200 } });
  assert.equal(a.alive, false, 'у себя дома — сразу');
  const b = join(game, 'Мария');
  game.admin('teleport', { id: b.id, place: 'corridor', floor: 101 });
  game.admin('accident', { id: b.id, accident: 'liftShaft' });
  assert.equal(b.alive, false);
});

test('планировщик: событие через N минут, повтор, отмена', () => {
  const { game, advance } = makeWorld();
  join(game, 'Иван');
  const res = game.admin('schedule', { cmd: 'fog', args: { from: 101, to: 101, warnSec: 0, durationMin: 0.5 }, label: 'Туман на 101', mode: 'in', value: 1 });
  assert.equal(res.ok, true, res.error);
  assert.equal(game.adminSnapshot().schedule.length, 1);
  advance(59000);
  assert.equal(game.world.fog, null);
  advance(2000);
  assert.ok(game.world.fog, 'туман по расписанию');
  assert.equal(game.adminSnapshot().schedule.length, 0, 'однократное снято после срабатывания');

  const every = game.admin('schedule', { cmd: 'announce', args: { text: 'Проверка' }, label: 'Сводка', mode: 'in', value: 1, repeat: 'every', repeatMin: 1 });
  advance(61000);
  advance(61000);
  assert.equal(game.state.schedule[0].runs, 2);
  assert.equal(game.admin('unschedule', { id: every.id }).ok, true);
  assert.equal(game.state.schedule.length, 0);
  assert.equal(game.admin('schedule', { cmd: 'schedule', args: {}, mode: 'in', value: 1 }).ok, false, 'расписание в расписании нельзя');
  assert.equal(game.admin('schedule', { cmd: 'fog', mode: 'at', value: '25:99' }).ok, false);
});

test('планировщик: игровое время и случайное окно', () => {
  const { game, clock } = makeWorld({ random: () => 0.5 });
  game.world.gameMinutes = 8 * 60; // 08:00
  const now = clock.t;
  game.admin('schedule', { cmd: 'announce', args: { text: 'Ночь' }, label: 'Ночное', mode: 'at', value: '02:00' });
  assert.equal(game.state.schedule[0].at, now + 18 * 60 * 1000, '18 игровых часов = 18 реальных минут');
  game.admin('schedule', { cmd: 'announce', args: { text: 'Когда-нибудь' }, mode: 'window', value: 10 });
  assert.equal(game.state.schedule[1].at, now + 5 * 60000);
});

test('пауза замораживает таймеры: туман, болезни и расписание продолжаются с того же места', () => {
  const { game, clock, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 1 });
  game.addCondition(p, 'flu');
  game.admin('schedule', { cmd: 'announce', args: { text: 'x' }, mode: 'in', value: 2 });
  const fogUntil = game.world.fog.until;
  const fluUntil = p.conditions[0].until;
  const at = game.state.schedule[0].at;
  game.admin('pause', { paused: true });
  clock.t += 10 * 60000; // десять минут паузы
  game.admin('pause', { paused: false });
  assert.equal(game.world.fog.until, fogUntil + 10 * 60000);
  assert.equal(p.conditions[0].until, fluUntil + 10 * 60000);
  assert.equal(game.state.schedule[0].at, at + 10 * 60000);
  advance(1000);
  assert.ok(game.world.fog, 'туман не кончился за время паузы');
});

test('паспорт: создание, вход, неверный пароль, занятый логин', () => {
  const { game } = makeWorld();
  assert.equal(game.createAccount('ab', 'secret1').ok, false, 'короткий логин');
  assert.equal(game.createAccount('ivan', '123').ok, false, 'короткий пароль');
  const { account } = game.createAccount('Ivan_101', 'secret1');
  assert.ok(account);
  assert.notEqual(account.hash, 'secret1', 'пароль хранится хешем');
  assert.equal(game.createAccount('ivan_101', 'other12').ok, false, 'логин занят (регистр не важен)');
  assert.equal(game.verifyLogin('IVAN_101', 'secret1').ok, true);
  assert.equal(game.verifyLogin('ivan_101', 'wrong12').ok, false);
  assert.equal(game.verifyLogin('nobody', 'secret1').ok, false);
});

test('паспорт: один живой жилец, новая жизнь на том же паспорте', () => {
  const { game, clock } = makeWorld();
  const { account } = game.createAccount('ivan', 'secret1');
  const first = game.register('Иван', { account }).player;
  assert.equal(game.accountPlayer(account), first);
  assert.equal(game.register('Иван Второй', { account }).ok, false, 'пока жив первый — второго не заселить');
  game.kill(first, 'тест');
  assert.equal(game.accountPlayer(account), null);
  assert.equal(game.register('Иван Второй', { account }).ok, false, 'сразу после смерти — рано');
  clock.t += C.BALANCE.rebirthDelayMin * 60000 + 1000;
  const second = game.register('Иван Второй', { account }).player;
  assert.equal(second.account, 'ivan');
  assert.deepEqual(account.playerIds, [first.id, second.id]);
});

test('паспорт можно выдать старому жильцу без него', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  assert.equal(game.playerView(p).you.account, null);
  assert.equal(game.claimAccount(p, 'ivan', 'secret1').ok, true);
  assert.equal(game.playerView(p).you.account, 'ivan');
  assert.equal(game.claimAccount(p, 'ivan2', 'secret1').ok, false);
});

test('модерация: заглушка, бан паспорта и адреса, разбан', () => {
  const { game } = makeWorld();
  const { account } = game.createAccount('ivan', 'secret1');
  const p = game.register('Иван', { account }).player;
  game.setOnline(p.id, true);
  p.lastIp = '10.0.0.7';
  assert.equal(game.admin('mute', { id: p.id, minutes: 5 }).ok, true);
  assert.equal(game.chat(p, 'global', 'привет').ok, false);
  game.admin('unmute', { id: p.id });
  assert.equal(game.chat(p, 'global', 'привет').ok, true);

  const kicks = [];
  game.on('kick', (k) => kicks.push(k));
  assert.equal(game.admin('ban', { id: p.id, minutes: 0, reason: 'спам', ip: true }).ok, true);
  assert.deepEqual(kicks[0].ids, [p.id]);
  assert.equal(game.banInfo(p).reason, 'спам');
  assert.ok(game.accountBanInfo(account), 'паспорт закрыт');
  assert.ok(game.banInfo(null, '10.0.0.7'), 'адрес закрыт');
  game.admin('unban', { id: p.id });
  assert.equal(game.banInfo(p, '10.0.0.7'), null);
});

test('модерация: удалить сообщение у всех и жалоба в журнал', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.chat(a, 'global', 'плохое слово');
  const msg = game.state.chatGlobal.find((m) => m.text === 'плохое слово');
  assert.equal(game.report(a, msg.id).ok, false, 'на себя нельзя');
  assert.equal(game.report(b, msg.id).ok, true);
  assert.ok(game.state.log.some((e) => e.kind === 'report' && /плохое слово/.test(e.text)));
  clock.t += 1000;
  assert.equal(game.report(b, msg.id).ok, false, 'не так часто');
  const deleted = [];
  game.on('chat_delete', (d) => deleted.push(d.id));
  assert.equal(game.admin('deleteMessage', { id: msg.id }).ok, true);
  assert.deepEqual(deleted, [msg.id]);
  assert.equal(game.state.chatGlobal.some((m) => m.id === msg.id), false);
});

test('после перезапуска сервера квитанция считает отсутствие с момента сохранения, а не входа', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  clock.t += 3 * 3600 * 1000; // три часа играл
  const saved = JSON.parse(JSON.stringify({ ...game.state, savedAt: clock.t }));
  clock.t += 60000; // минута простоя
  const g2 = new (require('../server/game').Game)(saved, { now: () => clock.t });
  const notes = [];
  g2.on('notify', (n) => notes.push(n));
  g2.setOnline(p.id, true);
  assert.equal(notes.find((n) => n.style === 'receipt'), undefined, 'за минуту простоя квитанции нет');
});

test('квитанция не пересказывает служебный журнал Пульта', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.setOnline(a.id, false);
  game.admin('custom', { target: { type: 'player', id: b.id }, title: 'Тайный обыск', text: 'x', style: 'whisper' });
  game.admin('breakdown', { key: 'lift', broken: true, durationMin: 37, reason: 'Диспетчер запил' });
  game.admin('kill', { id: b.id, cause: 'Забрали люди в сером' });
  clock.t += 10 * 60000;
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.setOnline(a.id, true);
  const text = notes.find((n) => n.style === 'receipt').text;
  assert.doesNotMatch(text, /Тайный обыск/);
  assert.doesNotMatch(text, /37 мин/);
  assert.doesNotMatch(text, /люди в сером/);
  assert.match(text, /Мария/, 'о смерти соседа по этажу — да, но без причины');
});

test('болезни вне сети не «отлёживаются»: срок идёт так же медленно, как и вред', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.addCondition(p, 'flu');
  game.setOnline(p.id, false);
  advance(20 * 60000);
  assert.ok(game.hasCondition(p, 'flu'), 'грипп никуда не делся за 20 минут вне сети');
});

test('имена-двойники: латинские буквы, точки и пробелы не обходят уникальность', () => {
  const { game } = makeWorld();
  join(game, 'Вася');
  assert.equal(game.register('Bacя').ok, false);
  assert.equal(game.register('Вася.').ok, false);
  assert.equal(game.register('ЖЭK').ok, false);
  assert.equal(game.register('Ж Э К').ok, false);
});

test('воскрешение всегда даёт уникальное имя', () => {
  const { game } = makeWorld();
  const a = join(game, 'Абвгдежзийклмнопрсту');
  game.kill(a, 'тест');
  join(game, 'Абвгдежзийклмнопрсту');
  game.admin('revive', { id: a.id });
  const names = game.alivePlayers().map((p) => p.name);
  assert.equal(new Set(names).size, names.length, names.join(' | '));
});

test('лимит смен за реальный час', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'factory' });
  walkTo(game, p, (o) => o.type === 'station' && o.game === 'sort');
  for (let i = 0; i < C.BALANCE.shiftsPerHour; i++) {
    p.stats.energy = 100;
    const r = game.workStart(p, 'sort');
    assert.equal(r.ok, true, `смена ${i + 1}`);
    game.workCancel(p);
  }
  p.stats.energy = 100;
  const over = game.workStart(p, 'sort');
  assert.equal(over.ok, false);
  assert.match(over.error, /Норму на этот час/);
  clock.t += 3600 * 1000 + 1000;
  assert.equal(game.workStart(p, 'sort').ok, true, 'через час снова можно');
});

test('карманник в темноте: только без света, не у новосёла, неудача выдаёт вора', () => {
  const { game, clock } = makeWorld({ random: () => 0.9 }); // 0.9 ≥ шанса — неудача
  const thief = join(game, 'Пётр');
  const victim = join(game, 'Иван');
  for (const p of [thief, victim]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  victim.money = 5;
  thief.createdAt -= (C.BALANCE.newbieProtectionH + 1) * 3600 * 1000; // новосёлам воровать нельзя
  assert.equal(game.pickpocket(thief, victim.id).ok, false, 'светло');
  game.admin('power', { on: false, from: 101, to: 101 });
  assert.equal(game.pickpocket(thief, victim.id).ok, false, 'новосёл под защитой');
  victim.createdAt -= (C.BALANCE.newbieProtectionH + 1) * 3600 * 1000;
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  const fail = game.pickpocket(thief, victim.id);
  assert.match(fail.message, /схватил вас за руку/);
  assert.match(notes.find((n) => n.to.includes(victim.id)).text, /Пётр/);
  assert.equal(victim.money, 5);
  assert.equal(game.pickpocket(thief, victim.id).ok, false, 'не так часто');
  clock.t += 61000;
  game.random = () => 0.1; // удача
  const ok = game.pickpocket(thief, victim.id);
  assert.match(ok.message, /Добыча/);
  assert.ok(victim.money < 5);
});

test('дилемма ЖЭК: вопрос с вариантами, ответ — в журнал Пульта', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  assert.equal(game.admin('ask', { target: { type: 'player', id: p.id }, question: 'Сдать соседа?', options: ['Да'] }).ok, false, 'нужно два варианта');
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  assert.equal(game.admin('ask', { target: { type: 'player', id: p.id }, question: 'Сдать соседа?', options: ['Да', 'Нет', 'Промолчать'] }).ok, true);
  const ask = notes[0].ask;
  assert.deepEqual(ask.options, ['Да', 'Нет', 'Промолчать']);
  assert.equal(game.playerView(p).you.asks.length, 1);
  assert.equal(game.answer(p, ask.id, 1).ok, true);
  assert.ok(game.state.log.some((e) => e.kind === 'answer' && /ответил: «Нет»/.test(e.text)));
  assert.equal(game.answer(p, ask.id, 0).ok, false, 'второй раз — нет');
});

test('счётчик бед за час в Пульте и пометка смертельных случаев', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('accident', { id: p.id, accident: 'slip' });
  game.admin('infect', { target: { type: 'player', id: p.id }, condition: 'flu' });
  assert.equal(game.adminSnapshot().players[0].harmsHour, 2);
  assert.match(game.adminContent().accidents.liftShaft.name, /смертельно/);
});

test('смена, прерванная перезапуском сервера, возвращает силы', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'factory' });
  walkTo(game, p, (o) => o.type === 'station' && o.game === 'sort');
  const before = p.stats.energy;
  game.workStart(p, 'sort');
  const g2 = new (require('../server/game').Game)(JSON.parse(JSON.stringify(game.state)));
  assert.equal(Math.round(g2.getPlayer(p.id).stats.energy), Math.round(before));
});

test('суточный завоз: запас кончается, в 08:00 привозят по числу закрытых смен', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'canteen' });
  walkTo(game, p, type('counter'));
  p.money = 100;
  game.state.stock.canteen.stew = 1;
  assert.equal(game.buy(p, 'canteen', 'stew').ok, true);
  const out = game.buy(p, 'canteen', 'stew');
  assert.equal(out.ok, false);
  assert.match(out.error, /кончилось/);
  assert.equal(game.playerView(p).here.shop.find((e) => e.key === 'stew').left, 0);
  assert.equal(game.playerView(p).here.shop.find((e) => e.key === 'tea').left, null, 'чай без ограничений');
  // ни одной смены за сутки — завоз скудный (60%)
  game.world.gameMinutes = 7 * 60 + 59 + 1440;
  advance(2000);
  assert.equal(game.state.stock.canteen.stew, Math.round(C.SHOPS.canteen.find((e) => e.item === 'stew').daily * 0.6));
  // смены закрыты — завоз полный+
  game.world.shiftsToday = 100;
  game.world.gameMinutes = 7 * 60 + 59 + 2 * 1440;
  advance(2000);
  assert.equal(game.state.stock.canteen.stew, Math.round(C.SHOPS.canteen.find((e) => e.item === 'stew').daily * 1.4));
  assert.equal(game.world.shiftsToday, 0);
  // ЖЭК: недовоз и внеплановая машина
  game.admin('supply', { mode: 'short' });
  game.world.gameMinutes = 7 * 60 + 59 + 3 * 1440;
  advance(2000);
  assert.ok(game.state.stock.canteen.stew <= 2, 'урезанный завоз');
  const before = game.state.stock.canteen.bread;
  game.admin('supply', { mode: 'extra' });
  assert.ok(game.state.stock.canteen.bread > before);
});

test('расходники: фильтр противогаза и батарейка фонарика', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.addItem(p, 'gasmask');
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 20, intensity: 0.1 });
  advance(6 * 60000);
  assert.equal(p.gasmaskCharge, 0, 'фильтр забился');
  assert.equal(p.inventory.gasmask, 1, 'сам противогаз остался');
  assert.equal(game.maskWorks(p), false);
  game.addItem(p, 'filter');
  assert.equal(game.useItem(p, 'filter').ok, true);
  assert.equal(game.maskWorks(p), true);
  assert.equal(game.useItem(p, 'battery').ok, false, 'батарейки нет');
  game.addItem(p, 'battery');
  assert.equal(game.useItem(p, 'battery').ok, false, 'нет фонарика');
  game.admin('fogEnd');
  game.addItem(p, 'flashlight');
  game.admin('power', { on: false, from: 101, to: 101 });
  advance(13 * 60000);
  assert.equal(p.flashCharge, 0, 'фонарик сел');
  assert.equal(game.useItem(p, 'battery').ok, true);
  assert.equal(game.torchWorks(p), true);
});

test('лампы: ЖЭК гасит, в коридоре темно, жилец с лампочкой вкручивает', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  assert.equal(game.isDarkFor(p), false);
  game.admin('lamps', { from: 101, to: 101, count: 4 });
  assert.equal(game.world.lampsOut[101].length, 4);
  assert.equal(game.isDarkFor(p), true, 'половина ламп погасла — темно');
  const i = game.world.lampsOut[101][0];
  const lamp = game.sceneOf(p).lamps[i];
  assert.equal(game.fixLamp(p, i).ok, false, 'надо подойти');
  p.pos = { x: lamp[0], y: lamp[1], d: 'up' };
  assert.equal(game.fixLamp(p, i).ok, false, 'нужна лампочка');
  game.addItem(p, 'bulb');
  assert.equal(game.fixLamp(p, i).ok, true);
  assert.equal(game.world.lampsOut[101].length, 3);
  assert.equal(game.isDarkFor(p), true, 'три из шести всё ещё не горят');
  game.admin('lamps', { from: 101, to: 101, on: true });
  assert.equal(game.isDarkFor(p), false);
});

test('трудовая книжка: опыт, разряд, задания сложнее, надбавка', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'factory' });
  walkTo(game, p, (o) => o.type === 'station' && o.game === 'sort');
  assert.equal(game.rankOf(p, 'sort'), 1);
  p.skills = { sort: C.RANKS[2] }; // 3 разряд
  p.stats.energy = 100;
  const r = game.workStart(p, 'sort');
  assert.equal(r.job.data.items.length, 16, 'больше деталей');
  clock.t += 10000;
  const done = game.workSubmit(p, r.job.id, p.job.secret.answers);
  assert.match(done.result.text, /надбавка за разряд \+1/);
  assert.equal(done.result.reward, 7);
  assert.equal(game.playerView(p).you.skills.find((x) => x.id === 'sort').rank, 3);
});

test('памятка новосёла: шаги, учебная тревога без урона, подъёмные', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  const steps = () => game.playerView(p).you.tutorial.filter((t) => t.done).map((t) => t.id);
  walkTo(game, p, type('hermodoor'));
  game.move(p, { place: 'corridor' });
  assert.deepEqual(steps(), ['corridor']);
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 96 });
  walkTo(game, p, type('facility'));
  game.move(p, { place: 'factory' });
  walkTo(game, p, (o) => o.type === 'station' && o.game === 'sort');
  const r = game.workStart(p, 'sort');
  clock.t += 10000;
  game.workSubmit(p, r.job.id, p.job.secret.answers);
  game.addItem(p, 'bread');
  game.useItem(p, 'bread');
  assert.deepEqual(steps().sort(), ['corridor', 'eat', 'factory', 'shift'].sort());
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  walkTo(game, p, (o) => o.type === 'apt' && o.number === p.apartment.number);
  game.move(p, { place: 'home' });
  assert.ok(notes.some((n) => n.title === 'УЧЕБНАЯ ТРЕВОГА'), 'учебная тревога');
  const hp = p.stats.health;
  walkTo(game, p, type('hermodoor'));
  game.seal(p, true);
  const money = p.money;
  game.chat(p, 'global', 'Здравствуйте, соседи!');
  assert.equal(game.playerView(p).you.tutorial, null, 'памятка пройдена — скрыта');
  assert.equal(p.money, money + C.BALANCE.tutorialReward);
  assert.equal(p.stats.health, hp, 'тревога учебная — без урона');
  assert.equal(game.sceneActors(game.locationKey(p))[0].newbie, true);
});

test('некролог, «†» на двери, наследник с вещью и разрядами', () => {
  const { game, clock } = makeWorld();
  const { account } = game.createAccount('ivan', 'secret1');
  const a = game.register('Иван', { account }).player;
  game.setOnline(a.id, true);
  a.skills = { sort: C.RANKS[3] }; // 4 разряд
  a.shifts = 12;
  a.deeds = { helped: 3 };
  game.addItem(a, 'stew', 2);
  const n = join(game, 'Сосед Петров');
  game.kill(a, 'Погиб в тумане');
  const ob = game.playerView(a).you.obituary;
  assert.equal(ob.shifts, 12);
  assert.equal(ob.helped, 3);
  assert.equal(ob.cause, 'Погиб в тумане');
  assert.ok(game.playerView(a).you.rebirthInSec > 0);
  game.admin('teleport', { id: n.id, place: 'corridor', floor: 101 });
  const plate = game.playerView(n).here.residents.find((r) => r.number === a.apartment.number);
  assert.match(plate.name, /† Иван/);
  clock.t += C.BALANCE.rebirthDelayMin * 60000 + 1000;
  const heir = game.register('Иван II', { account }).player;
  assert.equal(game.rankOf(heir, 'sort'), 3, 'разряд на ступень ниже');
  assert.equal(heir.inventory.stew, 1, 'одна вещь из опечатанной квартиры');
  assert.equal(game.playerView(heir).you.tutorial, null, 'наследнику памятка не нужна');
});

test('отголосок: погибший шепчет фразу соседу на грани безумия', () => {
  const { game } = makeWorld({ random: () => 0 });
  const dead = join(game, 'Иван');
  const living = join(game, 'Мария');
  game.kill(dead, 'тест');
  assert.equal(game.echo(living, 0).ok, false, 'живые не отголоски');
  assert.equal(game.echo(dead, 99).ok, false);
  assert.equal(game.echo(dead, 0).ok, true);
  assert.equal(game.echo(dead, 1).ok, false, 'один раз');
  const msgs = [];
  game.on('chat', (m) => msgs.push(m));
  game.hallucinate(living);
  assert.equal(msgs[0].text, C.ECHO_PHRASES[0]);
  assert.equal(msgs[0].from.name, 'Иван †');
});

test('опасность на клетке: наступил — беда; огородил — безопасно; срок истекает', () => {
  const { game, clock, advance } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  const res = game.admin('hazard', { playerId: a.id, kind: 'wire', minutes: 5 });
  assert.equal(res.ok, true, res.error);
  const hz = game.world.hazards['corridor:101'][0];
  assert.equal(game.playerView(b).here.hazards[0].kind, 'wire');
  // идём на провод маленькими шагами
  const hp = a.stats.health;
  a.pos = { x: hz.x - 0.4, y: hz.y, d: 'right' };
  clock.t += 200;
  assert.equal(game.setPos(a, hz.x, hz.y, 'right'), true);
  assert.ok(a.stats.health < hp, 'ударило током');
  // огородить может сосед, стоя рядом
  b.pos = { x: hz.x + 1, y: hz.y, d: 'left' };
  assert.equal(game.fenceHazard(b, hz.id).ok, true);
  const hp2 = b.stats.health;
  clock.t += 200;
  game.setPos(b, hz.x + 0.6, hz.y, 'left');
  clock.t += 200;
  game.setPos(b, hz.x, hz.y, 'left');
  assert.equal(b.stats.health, hp2, 'огорожено — не бьёт');
  advance(6 * 60000);
  assert.equal(game.world.hazards['corridor:101'], undefined, 'срок вышел');
});

test('палитра: своя болезнь, несчастный случай и предмет без перезапуска', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  const c = game.admin('paletteAdd', { type: 'conditions', def: { name: 'Лифтовая икота', kind: 'disease', durationMin: 5, contagious: 0.2, perMin: { sanity: -2 }, blocks: ['work'], symptom: 'икает' } });
  assert.equal(c.ok, true, c.error);
  assert.equal(game.admin('infect', { target: { type: 'player', id: p.id }, condition: c.id }).ok, true);
  assert.ok(game.hasBlock(p, 'work'), 'блокирует работу');
  const it = game.admin('paletteAdd', { type: 'items', def: { name: 'Настойка', desc: 'Горькая', use: { sanity: 5 }, cure: [c.id] } });
  game.admin('give', { id: p.id, item: it.id, count: 1, silent: true });
  assert.equal(game.useItem(p, it.id).ok, true);
  assert.equal(game.hasCondition(p, c.id), false, 'вылечила');
  const acc = game.admin('paletteAdd', { type: 'accidents', def: { name: 'Упала люстра', text: 'Бах!', effect: { health: -12 } } });
  game.admin('accident', { id: p.id, accident: acc.id });
  assert.equal(Math.round(p.stats.health), 88);
  assert.ok(game.adminContent().conditions[c.id], 'видно в Пульте');
  // сохранение и загрузка: палитра переживает перезапуск
  const g2 = new (require('../server/game').Game)(JSON.parse(JSON.stringify(game.state)));
  assert.ok(C.CONDITIONS[c.id]);
  assert.equal(game.admin('paletteRemove', { type: 'items', id: it.id }).ok, true);
  assert.equal(C.ITEMS[it.id], undefined);
  assert.equal(game.admin('paletteAdd', { type: 'conditions', def: { name: '' } }).ok, false, 'без названия нельзя');
  game.admin('paletteRemove', { type: 'conditions', id: c.id });
  game.admin('paletteRemove', { type: 'accidents', id: acc.id });
  assert.ok(g2);
});

test('режиссёр подсказывает: без сознания, частые беды, тишина; шкала напряжения', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  game.admin('custom', { target: { type: 'player', id: a.id }, title: 'Обвал', effect: { health: -200 } });
  for (let i = 0; i < 3; i++) game.admin('accident', { id: b.id, accident: 'slip' });
  const d = game.director();
  assert.ok(d.hints.some((h) => h.id === `down:${a.id}`));
  assert.ok(d.hints.some((h) => h.id === `harm:${b.id}`));
  assert.ok(d.tension > 0);
  clock.t += 20 * 60000;
  game.state.log = [];
  assert.ok(game.director().hints.some((h) => h.id === 'quiet'));
});

test('Глазок ЖЭК: снимок сцены с жильцами и опасностями', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('hazard', { scene: 'corridor:101', kind: 'hole' });
  const snap = game.sceneSnapshot('corridor:101');
  assert.equal(snap.actors[0].name, 'Иван');
  assert.equal(snap.hazards[0].kind, 'hole');
  assert.equal(snap.residents[p.apartment.number].name, 'Иван');
  assert.equal(game.sceneSnapshot('nonsense:1'), null);
});

test('опасность кликом в Глазке: ровно в клетку, в стену нельзя; в снимке Пульта видна сцена жильца', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  const sc = game.map.scene('corridor:101');
  let free = null;
  let wall = null;
  for (let y = 0; y < sc.h && (!free || !wall); y++) {
    for (let x = 0; x < sc.w; x++) {
      if (!free && !World.isSolidTile(sc, x, y)) free = { x, y };
      if (!wall && World.isSolidTile(sc, x, y)) wall = { x, y };
    }
  }
  const r = game.admin('hazard', { scene: 'corridor:101', kind: 'rats', x: free.x + 0.3, y: free.y + 0.7 });
  assert.equal(r.ok, true, r.error);
  const hz = game.world.hazards['corridor:101'][0];
  assert.deepEqual([hz.x, hz.y], [free.x + 0.5, free.y + 0.5]);
  assert.equal(game.admin('hazard', { scene: 'corridor:101', kind: 'rats', x: wall.x + 0.5, y: wall.y + 0.5 }).ok, false);
  assert.equal(game.adminSnapshot().players.find((x) => x.id === p.id).scene, 'corridor:101');
});

test('паспортный стол: смена имени, занятые и зарезервированные имена нельзя', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  join(game, 'Мария');
  assert.equal(game.admin('rename', { id: a.id, name: 'Мария' }).ok, false, 'занято');
  assert.equal(game.admin('rename', { id: a.id, name: 'Сосед' }).ok, false, 'зарезервировано домом');
  assert.equal(game.admin('rename', { id: a.id, name: '!' }).ok, false, 'плохое имя');
  const r = game.admin('rename', { id: a.id, name: 'Пётр', reason: 'непотребное имя' });
  assert.equal(r.ok, true, r.error);
  assert.equal(a.name, 'Пётр');
  assert.deepEqual(a.formerNames, ['Иван']);
  assert.ok(game.nameTaken('Иван') === null, 'старое имя освободилось');
  assert.ok(a.journal.some((j) => j.text.includes('Паспортный стол')));
});

test('шрамы дома: копоть от провода, налёт после тумана, мел и последние слова; выцветают', () => {
  const { game, clock, advance } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('accident', { id: a.id, accident: 'shock' });
  const key = 'corridor:101';
  assert.ok(game.world.scars[key].some((sc) => sc.kind === 'soot'), 'копоть');
  // последние слова
  clock.t += 1000;
  assert.equal(game.chat(b, 'local', 'Если что — ключ под ковриком').ok, true);
  game.admin('kill', { id: b.id, cause: 'Обвал' });
  const lw = game.world.scars[key].find((sc) => sc.kind === 'lastword');
  assert.equal(lw.text, 'Если что — ключ под ковриком');
  assert.ok(game.world.scars[key].some((sc) => sc.kind === 'chalk'));
  assert.ok(game.playerView(a).here.scars.some((sc) => sc.kind === 'lastword' && sc.by === 'Мария'));
  // туман оставляет налёт
  game.admin('fog', { from: 102, to: 103, warnSec: 0, durationMin: 1 });
  advance(70 * 1000);
  assert.ok((game.world.scars['corridor:102'] || []).some((sc) => sc.kind === 'film'), 'налёт');
  // стереть
  assert.equal(game.admin('scarsClear', { scene: 'corridor:102' }).ok, true);
  assert.equal(game.world.scars['corridor:102'], undefined);
  // выцветают за scarHours
  clock.t += C.BALANCE.scarHours * 3600 * 1000 + 1000;
  advance(60 * 1000);
  assert.equal(game.world.scars[key], undefined);
});

test('бумаги: читаются и не тратятся; записка от ЖЭК под дверь', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('give', { id: p.id, item: 'paper_walker', count: 1, silent: true });
  const r = game.useItem(p, 'paper_walker');
  assert.equal(r.ok, true);
  assert.match(r.read.text, /обход/i);
  assert.equal(p.inventory.paper_walker, 1, 'бумага осталась');
  assert.equal(game.playerView(p).you.inventory.find((i) => i.id === 'paper_walker').readable, true);
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  assert.equal(game.admin('plantNote', { id: p.id, text: 'Не выходи завтра.', from: 'Доброжелатель' }).ok, true);
  game.admin('teleport', { id: p.id, place: 'home' });
  game.collectDrops(p);
  assert.ok(p.journal.some((j) => j.text.includes('от Доброжелатель') && j.text.includes('Не выходи завтра')));
});

test('радиоточка: эфир слышат только у радиоточки, тишина и очередь ЖЭК', () => {
  const { game, advance } = makeWorld();
  const home = join(game, 'Иван');
  const out = join(game, 'Мария');
  game.admin('teleport', { id: out.id, place: 'corridor', floor: 101 });
  const heard = [];
  game.on('radio', (e) => heard.push(e));
  game.admin('radio', { text: 'Говорит ЖЭК. Проверка связи.', now: true });
  assert.deepEqual(heard.map((e) => e.to), [home.id], 'в коридоре радиоточки нет');
  assert.equal(heard[0].text, 'Говорит ЖЭК. Проверка связи.');
  // очередь уходит в ближайшую передачу
  game.admin('radio', { text: 'Из очереди' });
  advance(C.BALANCE.radioEveryMin * 1000 + 1000);
  assert.ok(heard.some((e) => e.text === 'Из очереди'));
  // тишина
  game.admin('radioSilence', { minutes: 30 });
  const n = heard.length;
  advance(C.BALANCE.radioEveryMin * 3000);
  assert.equal(heard.length, n, 'в тишине эфира нет');
  game.admin('teleport', { id: home.id, place: 'home' });
  home.pos = { ...game.map.scene(`home:${home.apartment.number}`).objects.find((o) => o.type === 'radio').spot, d: 'up' };
  assert.equal(game.listenRadio(home).silence, C.RADIO.silence);
  // низкий рассудок — эфир сбоит
  game.admin('radioSilence', { minutes: 0 });
  home.stats.sanity = 5;
  let garbled = 0;
  for (let i = 0; i < 20; i++) if (game.radioFor(home, 'Обычная передача о каше и тушёнке').garbled) garbled++;
  assert.ok(garbled >= 15);
});

test('стена памяти в столовой: имена выбывших', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.admin('kill', { id: b.id, cause: 'Туман' });
  game.admin('teleport', { id: a.id, place: 'canteen' });
  assert.equal(game.memorial(a).ok, false, 'надо подойти');
  a.pos = { ...game.map.scene('canteen').objects.find((o) => o.type === 'memorial').spot, d: 'up' };
  const m = game.memorial(a);
  assert.equal(m.ok, true);
  assert.equal(m.memorial[0].name, 'Мария');
});

// ---------------------------------------------------------------------------
// Исправления по второй проверке
// ---------------------------------------------------------------------------
test('туман из расписания с сиреной 0 с: ровно один туман, без рекурсии', () => {
  const { game, advance } = makeWorld();
  join(game, 'Иван');
  const notes = [];
  game.on('notify', (n) => notes.push(n.title));
  game.admin('schedule', { cmd: 'fog', args: { from: 101, to: 101, warnSec: '0', durationMin: 1 }, mode: 'in', value: 0, repeat: 'every', repeatMin: 60 });
  advance(1000);
  assert.equal(notes.filter((t) => t === 'СИРЕНА').length, 1);
  assert.equal(notes.filter((t) => t === 'ТУМАН').length, 1);
  const e = game.state.schedule[0];
  assert.equal(e.runs, 1);
  assert.ok(e.at - game.now() <= 60 * 60000 + 1000, 'повтор — через час, а не через сотни часов');
});

test('таймеры, созданные на паузе, отсчитываются от паузы', () => {
  const { game, clock } = makeWorld();
  join(game, 'Иван');
  game.admin('pause', { paused: true });
  clock.t += 60 * 60000; // час на паузе
  game.admin('fog', { from: 101, to: 101, warnSec: 30, durationMin: 3 });
  game.admin('breakdown', { key: 'lift', broken: true, durationMin: 5 });
  game.admin('pause', { paused: false });
  assert.equal(Math.round((game.world.fog.warnUntil - game.now()) / 1000), 30);
  assert.equal(Math.round((game.world.breakdowns.lift.until - game.now()) / 60000), 5);
});

test('перезапуск сервера не съедает таймер «без сознания»', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'canteen' });
  game.admin('custom', { target: { type: 'player', id: p.id }, title: 'Удар', effect: { health: -200 } });
  assert.ok(p.down);
  const left = p.down.until - game.now();
  game.state.savedAt = game.now();
  const saved = JSON.parse(JSON.stringify(game.state));
  clock.t += 3 * 60000; // сервер лежал три минуты
  const g2 = new Game(saved, { now: () => clock.t });
  const q = g2.getPlayer(p.id);
  assert.equal(q.down.until - g2.now(), left);
  g2.tick();
  assert.equal(q.alive, true);
});

test('передачка погибшему возвращается отправителю, записка — нет; дверь новому жильцу открыта', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.setOnline(b.id, false);
  a.money = 20;
  a.createdAt -= 3 * 3600 * 1000; // не новосёл: у новосёлов лимит подарков
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  walkTo(game, a, (o) => o.type === 'apt' && o.number === b.apartment.number);
  assert.equal(game.leaveParcel(a, b.apartment.number, { money: 10, items: {} }, 'Маше').ok, true);
  game.state.doors[b.apartment.number] = { sealed: true };
  game.kill(b, 'тест');
  assert.equal(a.money, 20, 'талоны вернулись');
  assert.equal(game.state.doorDrops[b.apartment.number], undefined);
  const c = join(game, 'Чужак');
  assert.equal(c.apartment.number, b.apartment.number);
  assert.equal(c.money, 0);
  assert.equal(game.doorSealed(c.apartment.number), false);
});

test('хозяин умер в туман — гости пережидают внутри, после тумана выходят', () => {
  const { game, advance, guest, host } = knockScene();
  game.knock(guest, host.apartment.number);
  game.openDoor(host, guest.id);
  game.seal(host, true);
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 1 });
  game.kill(host, 'тест');
  assert.equal(game.locationKey(guest), `home:${host.apartment.number}`, 'в туман не выставили');
  assert.equal(join(game, 'Новенький').apartment.number === host.apartment.number, false, 'квартиру с людьми внутри не отдают');
  advance(70 * 1000);
  assert.equal(game.locationKey(guest), 'corridor:101', 'туман ушёл — вышли');
  assert.equal(Math.round(guest.stats.health), 100);
});

test('гость открыл чужую дверь и ушёл — дверь задраивается за ним, хозяин в безопасности', () => {
  const { game, guest, host } = knockScene();
  game.knock(guest, host.apartment.number);
  game.openDoor(host, guest.id);
  game.seal(host, true);
  walkTo(game, guest, type('hermodoor'));
  assert.equal(game.seal(guest, false).ok, true);
  assert.equal(game.move(guest, { place: 'corridor' }).ok, true);
  assert.equal(game.doorSealed(host.apartment.number), true);
});

test('без сознания: лечение от ЖЭК будит; помощь — верное сообщение; в лифте не дотянуться', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('custom', { target: { type: 'player', id: a.id }, title: 'Удар', effect: { health: -200 } });
  assert.ok(a.down);
  game.admin('custom', { target: { type: 'player', id: a.id }, title: 'Чудо', effect: { health: 50 } });
  assert.equal(a.down, null, 'очнулся');
  game.admin('give', { id: b.id, item: 'bread', count: 1, silent: true });
  b.pos = { ...a.pos };
  a.stats.hunger = 10;
  const r = game.aid(b, a.id, 'bread');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.message, /приходит в себя/);
  a.travel = { via: 'lift', toFloor: 96, fromFloor: 101, startedAt: game.now(), arriveAt: game.now() + 9999 };
  assert.equal(game.canTouch(b, a), false);
});

test('упал на лестнице — тело в коридоре ближайшего этажа, где ему могут помочь', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  const q = join(game, 'Мария');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  walkTo(game, p, type('stairs'));
  assert.equal(game.startTravel(p, 96, 'stairs').ok, true);
  clock.t += 1000;
  game.fall(p, 'тест');
  assert.equal(p.travel, null);
  assert.equal(p.location.place, 'corridor');
  assert.ok(p.location.floor <= 101 && p.location.floor >= 96);
  // соседка приходит на этот этаж и помогает
  game.admin('teleport', { id: q.id, place: 'corridor', floor: p.location.floor });
  q.pos = { ...p.pos };
  game.admin('give', { id: q.id, item: 'bread', count: 1, silent: true });
  assert.equal(game.aid(q, p.id, 'bread').ok, true);
  assert.equal(p.down, null);
});

test('имена: греческие двойники и невидимые заполнители не проходят', () => {
  const { game } = makeWorld();
  join(game, 'Наташа');
  assert.equal(game.register('Ηаташа').ok, false, 'греческая Эта');
  assert.equal(game.register('Наташаㅤ').ok, false);
  assert.equal(game.register('ㅤㅤ').ok, false);
  assert.equal(game.register('ЖЭΚ').ok, false);
});

test('жалоба на сообщение — одна; заглушённый не пишет приписку; не больше двух свёртков под одну дверь', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.chat(b, 'global', 'привет');
  const id = game.state.chatGlobal.at(-1).id;
  assert.equal(game.report(a, id).ok, true);
  clock.t += 20000;
  assert.equal(game.report(a, id).ok, false);
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  walkTo(game, a, (o) => o.type === 'apt' && o.number === b.apartment.number);
  game.setOnline(b.id, false);
  a.money = 10;
  game.admin('mute', { id: a.id, minutes: 30 });
  assert.equal(game.leaveParcel(a, b.apartment.number, { money: 1, items: {} }, 'обидное').ok, true);
  assert.equal(game.state.doorDrops[b.apartment.number][0].text, '');
  clock.t += 10000;
  game.leaveParcel(a, b.apartment.number, { money: 1, items: {} }, '');
  clock.t += 10000;
  assert.equal(game.leaveParcel(a, b.apartment.number, { money: 1, items: {} }, '').ok, false);
});

test('воскресить нельзя, если по паспорту уже живёт другой', () => {
  const { game, clock } = makeWorld();
  const acc = game.createAccount('vasya', 'secret12').account;
  const old = game.register('Вася', { account: acc }).player;
  game.kill(old, 'тест');
  clock.t += (C.BALANCE.rebirthDelayMin + 1) * 60000;
  assert.equal(game.register('Василий', { account: acc }).ok, true);
  assert.equal(game.admin('revive', { id: old.id }).ok, false);
});

test('квитанция: в гостях, талоны, кто рылся в карманах', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  a.money = 30;
  a.createdAt -= (C.BALANCE.newbieProtectionH + 1) * 3600 * 1000; // не новосёл — его можно обшарить
  game.admin('teleport', { id: a.id, place: 'canteen' });
  game.setOnline(a.id, false);
  game.markAway(a, game.now());
  const b = join(game, 'Мария');
  b.createdAt -= (C.BALANCE.newbieProtectionH + 1) * 3600 * 1000;
  game.admin('teleport', { id: b.id, place: 'canteen' });
  game.admin('custom', { target: { type: 'player', id: a.id }, title: 'Удар', effect: { health: -200 } });
  b.pos = { ...a.pos };
  assert.equal(game.rob(b, a.id).ok, true);
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  clock.t += 6 * 60000;
  game.setOnline(a.id, true);
  const receipt = notes.find((n) => n.title === 'Квитанция ЖЭК');
  assert.ok(receipt, 'квитанция пришла');
  assert.match(receipt.text, /без сознания/);
  assert.match(receipt.text, /Талоны: 30 → 0/);
  assert.match(receipt.text, /рылся: Мария/);
});

test('хозяин видит и может выставить гостя, ушедшего из сети', () => {
  const { game, guest, host } = knockScene();
  game.knock(guest, host.apartment.number);
  game.openDoor(host, guest.id);
  game.setOnline(guest.id, false);
  const people = game.playerView(host).here.people;
  assert.ok(people.some((x) => x.id === guest.id && x.away));
  assert.equal(game.evict(host, guest.id).ok, true);
});

test('молва: поступки складываются в черты, видны соседям и выцветают; цели «щедрые» и «скупые»', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  const c = join(game, 'Пётр');
  for (const p of [a, b, c]) p.createdAt -= 3 * 3600 * 1000; // не новосёлы
  for (const p of [a, b, c]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('give', { id: a.id, item: 'bread', count: 2, silent: true });
  b.pos = { ...a.pos };
  assert.equal(game.tradeOffer(a, b.id, { money: 0, items: { bread: 1 } }, { money: 0, items: {} }).gift, true);
  assert.deepEqual(game.rumor(a), ['щедрый']);
  assert.ok(game.playerView(c).here.people.find((x) => x.id === a.id).rumor.includes('щедрый'));
  c.money = 50;
  assert.deepEqual(game.resolveTargets({ type: 'generous', count: 1 }).map((p) => p.id), [a.id]);
  assert.equal(game.resolveTargets({ type: 'stingy', count: 1 })[0].id, c.id, 'ничего не делал, а талоны есть');
  assert.equal(game.adminSnapshot().players.find((p) => p.id === a.id).deeds.gift, 1);
  clock.t += C.BALANCE.rumorHours * 3600 * 1000;
  assert.deepEqual(game.rumor(a), [], 'выцвело');
});

test('разнарядка: сдать у доски за свою квартиру, смены засчитываются сами, итог и цели', () => {
  const { game, clock, advance } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  const r = game.admin('assign', { from: 101, to: 101, text: 'Сбор ложек', kind: 'item', item: 'spoon', amount: 1, minutes: 10 });
  assert.equal(r.ok, true, r.error);
  const id = game.state.assignments[0].id;
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  walkTo(game, a, type('board'));
  assert.equal(game.submitAssignment(a, id).ok, false, 'нет ложки');
  game.admin('give', { id: a.id, item: 'spoon', count: 1, silent: true });
  assert.equal(game.submitAssignment(a, id).ok, true);
  assert.equal(game.submitAssignment(a, id).ok, false, 'уже сдано');
  const board = game.readBoard(a);
  assert.deepEqual(board.assignments[0].done, [a.apartment.number]);
  assert.equal(board.assignments[0].total, 2);
  // смены
  game.admin('assign', { from: 101, to: 101, text: 'Ударная смена', kind: 'shifts', amount: 1, minutes: 30 });
  const sid = game.state.assignments[1].id;
  game.assignmentShift(b);
  assert.ok(game.state.assignments[1].done[b.apartment.number]);
  // срок вышел
  clock.t += 11 * 60000;
  advance(1000);
  assert.equal(game.state.assignments[0].closed, true);
  assert.deepEqual(game.resolveTargets({ type: 'assignmentDone', id }).map((p) => p.id), [a.id]);
  assert.deepEqual(game.resolveTargets({ type: 'assignmentFailed', id }).map((p) => p.id), [b.id]);
  // цели по этажу квартиры, а не по месту
  game.admin('teleport', { id: b.id, place: 'canteen' });
  assert.ok(game.resolveTargets({ type: 'homeFloors', from: 101, to: 101 }).some((p) => p.id === b.id));
  assert.ok(sid);
});

test('коллективная жалоба: подписи у доски, уходит в ЖЭК, наказать подписавших', () => {
  const { game, clock } = makeWorld();
  const [a, b, c] = ['Иван', 'Мария', 'Пётр'].map((n) => join(game, n));
  for (const p of [a, b, c]) {
    game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
    walkTo(game, p, type('board'));
  }
  assert.equal(game.createPetition(a, 'мало').ok, false);
  assert.equal(game.createPetition(a, 'Почините лифт, третий день стоит').ok, true);
  const pet = game.state.petitions[0];
  assert.equal(game.signPetition(a, pet.id).ok, false, 'автор уже подписал');
  game.signPetition(b, pet.id);
  assert.equal(pet.status, 'open');
  game.signPetition(c, pet.id);
  assert.equal(pet.status, 'sent');
  assert.ok(game.director().hints.some((h) => h.id === `petition:${pet.id}`));
  assert.equal(game.resolveTargets({ type: 'petitionSigners', id: pet.id }).length, 3);
  c.money = 5;
  assert.equal(game.admin('petitionResolve', { id: pet.id, verdict: 'punished', reply: 'Лифт исправен.' }).ok, true);
  assert.equal(c.money, 3);
  assert.equal(game.readBoard(a).petitions[0].status, 'punished');
  assert.equal(game.admin('petitionResolve', { id: pet.id, verdict: 'done' }).ok, false, 'уже решено');
  clock.t += 1000;
});

test('старший по этажу: выборы у доски своего этажа и звонок о тумане из расписания', () => {
  const { game, advance } = makeWorld();
  const [a, b, c] = ['Иван', 'Мария', 'Пётр'].map((n) => join(game, n));
  for (const p of [a, b, c]) {
    game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
    walkTo(game, p, type('board'));
  }
  game.voteElder(a, b.id);
  assert.equal(game.elderOf(101), null, 'нужно не меньше половины (2 из 3)');
  game.voteElder(c, b.id);
  assert.equal(game.elderOf(101).id, b.id);
  assert.equal(game.playerView(b).you.elderOf, 101);
  assert.ok(game.readBoard(a).elder.name.startsWith('Мария'));
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  game.admin('schedule', { cmd: 'fog', args: { from: 101, to: 102, warnSec: 30, durationMin: 2 }, mode: 'in', value: 5 });
  advance(60 * 1000);
  assert.equal(notes.filter((n) => n.title === 'Звонок из ЖЭК').length, 0, 'ещё рано');
  advance(2 * 60 * 1000 + 1000);
  const call = notes.filter((n) => n.title === 'Звонок из ЖЭК');
  assert.equal(call.length, 1);
  assert.deepEqual(call[0].to, [b.id]);
  assert.equal(notes.filter((n) => n.title === 'СИРЕНА').length, 0, 'сирены ещё нет');
});

test('долговая расписка: в долг до дня N, вернуть, передать, просрочка на доске и цель «должники»', () => {
  const { game, advance } = makeWorld();
  const [a, b, c] = ['Иван', 'Мария', 'Пётр'].map((n) => join(game, n));
  for (const p of [a, b, c]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  b.pos = { ...a.pos };
  c.pos = { ...a.pos };
  game.admin('give', { id: a.id, item: 'stew', count: 1, silent: true });
  const r = game.tradeOffer(a, b.id, { money: 0, items: { stew: 1 } }, { money: 5, items: {} }, 1);
  assert.equal(r.ok, true, r.error);
  assert.equal(game.tradeRespond(b, r.trade, true).ok, true, 'талонов у Марии нет — но в долг можно');
  assert.equal(b.inventory.stew, 1);
  const iou = game.state.ious[0];
  assert.equal(iou.dueDay, game.gameDay() + 1);
  assert.equal(game.playerView(b).you.ious.owe.length, 1);
  // Иван перепродаёт расписку Петру
  assert.equal(game.transferIou(a, iou.id, c.id).ok, true);
  assert.equal(game.playerView(c).you.ious.held.length, 1);
  // срок прошёл — должник на доске и в цели (переводим игровые часы, чтобы никто не умер с голоду)
  game.world.gameMinutes += 2 * 1440;
  advance(1000);
  walkTo(game, c, type('board'));
  assert.equal(game.readBoard(c).debtors.length, 1);
  assert.deepEqual(game.resolveTargets({ type: 'debtors' }).map((p) => p.id), [b.id]);
  b.money = 5;
  assert.equal(game.repayIou(b, iou.id).ok, true);
  assert.equal(c.money, 5, 'долг ушёл тому, у кого расписка');
  assert.equal(game.resolveTargets({ type: 'debtors' }).length, 0);
});

test('полночь: хлеб черствеет, в авоське за окном — медленнее, туман делает его туманным', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('give', { id: p.id, item: 'bread', count: 3, silent: true });
  walkTo(game, p, type('window'));
  assert.equal(game.windowPut(p, 'bread', 2).ok, true);
  game.world.gameMinutes = Math.ceil(game.world.gameMinutes / 1440) * 1440 + 1; // за полночь
  game.dayCheck(game.now());
  assert.equal(p.inventory.stale_bread, 1, 'в кармане зачерствел');
  const day = Math.floor(game.world.gameMinutes / 1440);
  assert.equal(p.window.bread, day % C.BALANCE.windowSpoilEvery === 0 ? undefined : 2, 'за окном — не каждую ночь');
  p.window = { bread: 2 };
  game.admin('fog', { from: p.apartment.floor, to: p.apartment.floor, warnSec: 0, durationMin: 1 });
  assert.equal(p.window.fog_bread, 2, 'туман покрыл налётом');
  assert.equal(game.windowTake(p, 'fog_bread', 2).ok, true);
  assert.equal(p.inventory.fog_bread, 2);
});

test('квартплата: в полночь со всех, кто был в доме; не хватило — долг на доске и цель «должники»', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) p.createdAt -= 3 * 3600 * 1000;
  a.money = 10;
  b.money = 1;
  game.world.gameMinutes = Math.ceil(game.world.gameMinutes / 1440) * 1440 + 1;
  game.dayCheck(game.now());
  assert.equal(a.money, 10 - C.BALANCE.rent);
  assert.equal(b.money, 0);
  assert.equal(b.rentDebt, C.BALANCE.rent - 1);
  assert.deepEqual(game.resolveTargets({ type: 'debtors' }).map((p) => p.id), [b.id]);
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  walkTo(game, a, type('board'));
  assert.equal(game.readBoard(a).rentDebtors[0].name, 'Мария');
  b.money = 5;
  game.admin('teleport', { id: b.id, place: 'corridor', floor: 101 });
  walkTo(game, b, type('board'));
  assert.equal(game.payRent(b).ok, true);
  assert.equal(b.rentDebt, 0);
  game.admin('rentSet', { amount: 0 });
  game.world.gameMinutes += 1440;
  game.dayCheck(game.now());
  assert.equal(b.money, 5 - (C.BALANCE.rent - 1), 'квартплату отменили');
  clock.t += 1;
});

test('честная экономика: новосёл дарит не больше лимита; один адрес — пометка и флажок', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  b.pos = { ...a.pos };
  a.money = 20;
  a.lastIp = b.lastIp = '10.0.0.1';
  assert.equal(game.tradeOffer(a, b.id, { money: C.BALANCE.newbieGiftLimit + 1, items: {} }, { money: 0, items: {} }).ok, false);
  assert.equal(game.tradeOffer(a, b.id, { money: 3, items: {} }, { money: 0, items: {} }).ok, true);
  assert.ok(game.state.log.at(-1).text.includes('один адрес'));
  game.tradeOffer(a, b.id, { money: 2, items: {} }, { money: 0, items: {} });
  assert.equal(game.adminSnapshot().players.find((p) => p.id === a.id).suspicious, true);
});

test('подработка за паёк: по часам, раз в окно, оплата натурой', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'canteen' });
  walkTo(game, p, type('counter'));
  game.world.gameMinutes = Math.floor(game.world.gameMinutes / 1440) * 1440 + 10 * 60; // 10:00
  assert.equal(game.sideJobStart(p, 'serve').ok, false, 'раздача — с 12:00');
  game.world.gameMinutes += 2 * 60 + 5; // 12:05
  const r = game.sideJobStart(p, 'serve');
  assert.equal(r.ok, true, r.error);
  clock.t += 10000;
  const answers = p.job.secret.answers;
  const res = game.workSubmit(p, r.job.id, answers);
  assert.equal(res.ok, true);
  assert.equal(p.inventory.bread, 1);
  assert.equal(p.inventory.kissel, 1);
  assert.equal(p.money, 0, 'талонов не платят');
  assert.equal(game.sideJobStart(p, 'serve').ok, false, 'в это окно уже работали');
  assert.equal(game.playerView(p).you.skills.length, 3, 'подработка — не станок');
});

test('барыга: только на техническом этаже, цены растут в туман, облава и цель «клиенты»', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  assert.equal(game.admin('barygaPlace', { floor: 101 }).ok, false);
  assert.equal(game.admin('barygaPlace', { floor: 99 }).ok, true);
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 99 });
  assert.ok(game.sceneActors('corridor:99').some((a) => a.npc === 'baryga'));
  assert.equal(game.barygaOffer(p).ok, false, 'далеко');
  p.pos = { x: game.world.baryga.x + 1, y: game.world.baryga.y, d: 'left' };
  game.admin('give', { id: p.id, item: 'bulb', count: 2, silent: true });
  game.admin('give', { id: p.id, item: 'paper_list', count: 1, silent: true });
  const offer = game.barygaOffer(p);
  assert.equal(offer.items.find((x) => x.id === 'bulb').price, 2);
  assert.equal(offer.items.find((x) => x.id === 'paper_list').price, 1);
  assert.equal(game.barygaSell(p, 'bulb', 1).ok, true);
  assert.equal(p.money, 2);
  game.admin('fog', { from: 101, to: 101, warnSec: 30, durationMin: 1 });
  assert.equal(game.barygaPrice('bulb'), 3, 'в туман дороже');
  assert.equal(game.admin('barygaRaid', {}).ok, true);
  assert.equal(game.world.baryga, null);
  assert.deepEqual(game.resolveTargets({ type: 'barygaClients' }).map((q) => q.id), [p.id]);
});

test('план дома: смены копятся, через неделю — премия участникам и доска почёта', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.planCheck();
  game.world.plan.target = 3;
  for (let i = 0; i < 3; i++) game.planShift(a);
  game.admin('teleport', { id: a.id, place: 'factory' });
  walkTo(game, a, type('jobboard'));
  const view = game.readPlan(a);
  assert.equal(view.plan.done, 3);
  assert.equal(view.plan.mine, 3);
  const before = a.money;
  game.world.gameMinutes += 7 * 1440;
  game.dayCheck(game.now());
  assert.equal(a.money - before, C.BALANCE.planBonus - (a.createdAt > game.now() - C.BALANCE.newbieProtectionH * 3600e3 ? 0 : C.BALANCE.rent));
  assert.equal(game.world.honor.workers[0].name, 'Иван');
  assert.equal(b.money, 0, 'не участвовал — премии нет');
});

test('марионетки: появляются в сцене, ходят по проходам, говорят и стучат', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  const q = join(game, 'Мария');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  const r = game.admin('puppetCreate', { preset: 'double', playerId: q.id, scene: 'corridor:101' });
  assert.equal(r.ok, true, r.error);
  const actor = game.sceneActors('corridor:101').find((a) => a.npc === 'puppet');
  assert.equal(actor.name, 'Мария', 'двойник носит имя жильца');
  assert.equal(actor.lookId, q.id, 'и его внешность');
  const pp = game.world.puppets[r.puppetId];
  const target = { x: pp.x + 4, y: pp.y };
  assert.equal(game.admin('puppetMove', { id: pp.id, ...target }).ok, true);
  for (let i = 0; i < 30; i++) game.stepPuppets(0.1);
  assert.ok(Math.hypot(pp.x - target.x, pp.y - target.y) < 0.6, 'дошла');
  const chat = [];
  game.on('chat', (m) => chat.push(m));
  game.admin('puppetSay', { id: pp.id, text: 'Не выходите сегодня.' });
  assert.equal(chat[0].from.puppet, true);
  assert.equal(chat[0].key, 'corridor:101');
  const notes = [];
  game.on('notify', (n) => notes.push(n));
  assert.equal(game.admin('puppetKnock', { id: pp.id, apt: q.apartment.number }).ok, true);
  assert.ok(notes.some((n) => n.title === 'Стук в дверь' && /Мария/.test(n.text)));
  game.admin('puppetRemove', { id: pp.id });
  assert.equal(game.sceneActors('corridor:101').filter((a) => a.npc).length, 0);
});

test('одержимые вещи: мусоропровод шепчет тем, кто в коридоре; листок на доске от любого имени', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  const far = join(game, 'Мария');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  const said = [];
  game.on('object_say', (e) => said.push(e));
  assert.equal(game.admin('objectVoice', { floor: 101, object: 'chute', text: 'Вытащите меня…' }).ok, true);
  assert.deepEqual(said.map((e) => e.to), [p.id]);
  game.admin('objectVoice', { floor: 101, object: 'board', text: 'Не открывайте на три стука.', as: 'Сосед сверху' });
  walkTo(game, p, type('board'));
  assert.equal(game.readBoard(p).pinned[0].name, 'Сосед сверху');
  assert.ok(far);
});

test('журнал богов, роли, снимок перед опасной командой и откат жильца и дома', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  // роли
  assert.equal(game.admin('adminAdd', { login: 'moder', password: 'secret123', role: 'moderator' }).ok, true);
  assert.equal(game.admin('kill', { id: a.id }, { who: 'moder', role: 'moderator' }).ok, false, 'модератору нельзя убивать');
  assert.equal(game.admin('mute', { id: a.id, minutes: 5 }, { who: 'moder', role: 'moderator' }).ok, true);
  assert.equal(game.admin('mute', { id: a.id }, { who: 'глаз', role: 'observer' }).ok, false);
  assert.ok(game.state.godLog.some((e) => e.who === 'moder' && e.cmd === 'kill' && e.error === 'нет прав'));
  assert.ok(!game.state.godLog.some((e) => e.args.includes('secret123')), 'пароль не попал в журнал');
  // опасная команда — снимок
  a.money = 42;
  game.admin('kill', { id: a.id, cause: 'тест' }, { who: 'root', role: 'god' });
  assert.equal(game.snapshots.length, 1);
  assert.equal(game.snapshots[0].who, 'root');
  // откат жильца: снова жив, талоны на месте
  const snapId = game.snapshots[0].id;
  assert.equal(game.admin('restorePlayer', { snapshotId: snapId, id: a.id }).ok, true);
  assert.equal(a.alive, false, 'старый объект больше не в мире');
  const a2 = game.getPlayer(a.id);
  assert.equal(a2.alive, true);
  assert.equal(a2.money, 42);
  assert.equal(game.playerByToken(a2.token).id, a.id, 'токен тот же');
  // откат дома: Мария погибла — откатили дом — жива
  game.admin('kill', { id: b.id, cause: 'тест' });
  const before = game.snapshots.at(-1).id;
  game.admin('restoreHouse', { snapshotId: before });
  assert.equal(game.getPlayer(b.id).alive, true);
  assert.ok(game.snapshots.some((x) => x.label === 'перед откатом дома'), 'откат можно отменить');
});

test('вылазки: служебная дверь на техническом этаже — монтировкой, постоянная добыча, перезарядка, ЖЭК видит', () => {
  const { game, clock } = makeWorld({ random: () => 0.99 });
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 99 });
  walkTo(game, p, type('locked'));
  assert.equal(game.searchStash(p).ok, false, 'без монтировки не открыть');
  game.admin('give', { id: p.id, item: 'crowbar', count: 1, silent: true });
  const r = game.searchStash(p);
  assert.equal(r.ok, true, r.error);
  const d = game.stashDoor(p);
  const loot = game.stashLoot(d.id);
  assert.equal(p.inventory[loot] >= 1, true, 'постоянная добыча этой двери');
  assert.equal(game.searchStash(p).ok, false, 'перезарядка');
  clock.t += C.BALANCE.stashCooldownMin * 60000 + 1000;
  game.removeItem(p, 'crowbar', 1);
  assert.equal(game.searchStash(p).ok, true, 'вскрытую дверь можно и без монтировки');
  assert.deepEqual(game.resolveTargets({ type: 'techVisitors' }).map((q) => q.id), [p.id]);
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  assert.equal(game.searchStash(p).ok, false, 'на жилом этаже подсобок нет');
});

test('аварийный наряд: только у поломок со сроком и с разрешения ЖЭК; ремонт сокращает и чинит', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  walkTo(game, p, type('lift'));
  game.admin('breakdown', { key: 'lift', broken: true, durationMin: 0, repairable: true });
  assert.equal(game.repairStart(p).ok, false, 'бессрочную поломку чинит только ЖЭК');
  game.admin('breakdown', { key: 'lift', broken: false });
  game.admin('breakdown', { key: 'lift', broken: true, durationMin: 3, repairable: true });
  assert.equal(game.playerView(p).world.repairs.lift, 3);
  const r = game.repairStart(p);
  assert.equal(r.ok, true, r.error);
  // идеальные нажатия: моменты, когда стрелка в зелёной зоне
  const MG = require('../server/minigames');
  const perfect = () => {
    const pr = p.job.secret.params;
    const out = [];
    for (let t = 0; t < 30000 && out.length < pr.presses; t += 10) if (Math.abs(MG.gaugePos(pr, t) - pr.center) <= (pr.width / 2) * 0.8 && (!out.length || t - out.at(-1) > 300)) out.push(t);
    return out;
  };
  const presses = perfect();
  clock.t += presses.at(-1) + 500;
  const res = game.workSubmit(p, r.job.id, presses);
  assert.equal(res.ok, true);
  assert.equal(p.money, C.BALANCE.repairReward);
  assert.ok(game.world.breakdowns.lift.until - game.now() <= 60 * 1000 + 100, 'на 2 минуты короче');
  clock.t += C.BALANCE.repairCooldownSec * 1000;
  const r2 = game.repairStart(p);
  const presses2 = perfect();
  clock.t += presses2.at(-1) + 500;
  game.workSubmit(p, r2.job.id, presses2);
  assert.equal(game.world.breakdowns.lift, null, 'починили');
});

test('микроклимат: тексты и вид без вреда; с множителем — вред, но не за задраенной дверью', () => {
  const { game, advance } = makeWorld();
  const out = join(game, 'Иван');
  const home = join(game, 'Мария');
  game.admin('teleport', { id: out.id, place: 'corridor', floor: 101 });
  game.admin('climate', { from: 101, to: 101, kind: 'draft', minutes: 30 });
  const v = game.playerView(out);
  assert.equal(v.here.climate.kind, 'draft');
  assert.match(v.here.text, /тянет/);
  const hp = out.stats.health;
  advance(60 * 1000);
  assert.ok(out.stats.health >= hp, 'без множителя — без вреда');
  game.admin('climate', { from: 101, to: 101, kind: 'draft', minutes: 30, harm: 2 });
  walkTo(game, home, type('hermodoor'));
  game.seal(home, true);
  const hp1 = out.stats.health;
  const hp2 = home.stats.health;
  advance(5 * 60 * 1000);
  assert.ok(out.stats.health < hp1, 'сквозняк в коридоре вредит');
  assert.ok(home.stats.health >= hp2, 'за задраенной дверью — нет');
  game.admin('climateClear', {});
  assert.equal(game.playerView(out).here.climate, null);
});

test('звук в доме: только тем, кто в сети, по цели', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  game.setOnline(b.id, false);
  const heard = [];
  game.on('sound', (e) => heard.push(e));
  assert.equal(game.admin('sound', { target: { type: 'all' }, kind: 'cry' }).ok, true);
  assert.deepEqual(heard.map((e) => e.to), [a.id]);
  assert.match(heard[0].text, /плачет/);
  assert.equal(game.admin('sound', { target: { type: 'all' }, kind: 'nope' }).ok, false);
});

// ---------------------------------------------------------------------------
// Исправления по третьей проверке
// ---------------------------------------------------------------------------
test('заряд противогаза ходит вместе с вещью: новый — полный, отработанный — пустой', () => {
  const { game } = makeWorld();
  const a = join(game, 'Иван');
  const b = join(game, 'Мария');
  for (const p of [a, b]) game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  b.pos = { ...a.pos };
  game.admin('give', { id: a.id, item: 'gasmask', count: 1, silent: true });
  a.gasmaskCharge = 0;
  assert.equal(game.tradeOffer(a, b.id, { money: 0, items: { gasmask: 1 } }, { money: 0, items: {} }).ok, true);
  assert.equal(b.gasmaskCharge, 0, 'отработанный остаётся отработанным');
  assert.equal(game.maskWorks(b), false);
  game.admin('give', { id: a.id, item: 'gasmask', count: 1, silent: true });
  assert.equal(a.gasmaskCharge, 100, 'новый — с полным фильтром');
  assert.equal(game.windowPut(a, 'gasmask', 1).ok, false, 'в авоську — только еду');
});

test('наследство одно: вещь уходит из опечатанной квартиры, второй наследник её не получит', () => {
  const { game, clock } = makeWorld();
  const dead = join(game, 'Иван');
  game.admin('give', { id: dead.id, item: 'gasmask', count: 1, silent: true });
  game.kill(dead, 'тест');
  clock.t += (C.BALANCE.rebirthDelayMin + 1) * 60000;
  const h1 = game.register('Иван второй', { predecessor: dead }).player;
  assert.equal(h1.inventory.gasmask, 1);
  assert.equal(dead.inventory.gasmask || 0, 0, 'у покойника забрали');
  const h2 = game.register('Иван третий', { predecessor: dead }).player;
  assert.equal(h2.inventory.gasmask || 0, 0);
  assert.equal(game.isNewbie(h1), false, 'наследник — не новосёл');
});

test('новый туман поверх старого не выгоняет гостей погибшего хозяина', () => {
  const { game, guest, host } = knockScene();
  game.knock(guest, host.apartment.number);
  game.openDoor(host, guest.id);
  game.seal(host, true);
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 5 });
  game.kill(host, 'тест');
  game.admin('fog', { from: 101, to: 102, warnSec: 0, durationMin: 5 });
  assert.equal(game.locationKey(guest), `home:${host.apartment.number}`);
});

test('опасность не перепрыгнуть длинным шагом; две опасности в одну клетку не встают', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  const sc = game.map.scene('corridor:101');
  const y = 3.5;
  game.admin('hazard', { scene: 'corridor:101', kind: 'wire', x: 10.5, y });
  assert.equal(game.admin('hazard', { scene: 'corridor:101', kind: 'steam', x: 10.5, y }).ok, false);
  p.pos = { x: 9.3, y, d: 'right' };
  clock.t += 2000;
  const hp = p.stats.health;
  assert.equal(game.setPos(p, 11.6, y, 'right'), true);
  assert.ok(p.stats.health < hp, 'ударило по дороге');
  assert.ok(sc);
});

test('палитра: прототипы не трогаются; имя с украинской і не выдаст себя за соседа', () => {
  const { game } = makeWorld();
  assert.equal(game.admin('paletteRemove', { type: 'constructor', id: 'keys' }).ok, false);
  assert.equal(typeof Object.keys, 'function');
  assert.equal(game.admin('paletteAdd', { type: '__proto__', def: { name: 'x' } }).ok, false);
  const r = game.admin('paletteAdd', { type: 'accidents', def: { name: 'Тест', condition: 'constructor' } });
  assert.equal(C.ACCIDENTS[r.id].condition, undefined);
  game.admin('paletteRemove', { type: 'accidents', id: r.id });
  join(game, 'Nikita');
  assert.equal(game.register('Nіkіta').ok, false);
});

test('последние слова — только сказанное рядом и недавно; удалённое ЖЭК не всплывает', () => {
  const { game, clock } = makeWorld();
  const a = join(game, 'Иван');
  game.admin('teleport', { id: a.id, place: 'corridor', floor: 101 });
  game.chat(a, 'global', 'мой телефон 123');
  clock.t += 1000;
  game.kill(a, 'тест');
  assert.ok(!(game.world.scars['corridor:101'] || []).some((x) => x.kind === 'lastword'), 'общий чат — не последние слова');
  const b = join(game, 'Мария');
  game.admin('teleport', { id: b.id, place: 'corridor', floor: 101 });
  game.chat(b, 'local', 'гадость');
  const id = [...game.localChat.get('corridor:101')].at(-1).id;
  game.admin('deleteMessage', { id });
  clock.t += 1000;
  game.kill(b, 'тест');
  assert.ok(!(game.world.scars['corridor:101'] || []).some((x) => x.kind === 'lastword' && x.text === 'гадость'));
});

test('дилемма: после срока ответить нельзя, окно закрывается; учебной тревоги нет в настоящую сирену', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('ask', { target: { type: 'player', id: p.id }, question: 'Да?', options: ['Да', 'Нет'], timeoutMin: 1 });
  const ask = p.asks[0];
  clock.t += 2 * 60000;
  const r = game.answer(p, ask.id, 0);
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
  p.tutorial = { done: ['eat'], rewarded: false, drill: false };
  game.admin('fog', { from: p.apartment.floor, to: p.apartment.floor, warnSec: 60, durationMin: 1 });
  game.tutorialDrill(p);
  assert.equal(p.tutorial.drill, false, 'учения не в настоящую тревогу');
});
