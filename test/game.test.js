'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const C = require('../server/content');

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
  advance(10000);
  assert.equal(game.locationKey(p), 'corridor:50', 'доехал');
  game.admin('breakdown', { key: 'lift', broken: false });
  advance(60000);
  assert.equal(p.location.place, 'home', 'и дошёл домой');
});

test('в тумане тело ушедшего не идёт домой и получает полный урон', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'corridor', floor: 101 });
  game.admin('fog', { from: 101, to: 101, warnSec: 0, durationMin: 2 });
  game.setOnline(p.id, false);
  advance(60000);
  assert.equal(p.location.place, 'corridor', 'ждёт отбоя');
  assert.ok(p.stats.health <= 85, `туман бьёт отсутствующего: ${p.stats.health}`);
  advance(2 * 60000);
  advance(60000);
  assert.equal(p.location.place, 'home', 'после отбоя дошёл');
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
  assert.match(receipt.text, /Столовая/);
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
  const { game } = makeWorld();
  const { account } = game.createAccount('ivan', 'secret1');
  const first = game.register('Иван', { account }).player;
  assert.equal(game.accountPlayer(account), first);
  assert.equal(game.register('Иван Второй', { account }).ok, false, 'пока жив первый — второго не заселить');
  game.kill(first, 'тест');
  assert.equal(game.accountPlayer(account), null);
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
