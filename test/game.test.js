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

test('поездка на лифте занимает время, сломанный лифт — застревание', () => {
  const { game, advance } = makeWorld();
  const p = join(game, 'Иван');
  assert.equal(game.move(p, { place: 'canteen' }).ok, true);
  assert.equal(p.location.place, 'lift');
  game.admin('breakdown', { key: 'lift', broken: true });
  advance(10000);
  assert.equal(p.location.place, 'lift');
  assert.equal(p.travel.stuck, true);
  game.admin('breakdown', { key: 'lift', broken: false });
  advance(10000);
  assert.equal(p.location.place, 'canteen');
  assert.equal(p.location.floor, C.FACILITIES.canteen.floor);
});

test('без лифта — по лестнице, это стоит сил; с переломом ноги нельзя', () => {
  const { game } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('breakdown', { key: 'lift', broken: true });
  const before = p.stats.energy;
  assert.equal(game.move(p, { place: 'factory' }).ok, true);
  assert.equal(p.travel.via, 'stairs');
  assert.ok(p.stats.energy < before);

  const q = join(game, 'Пётр');
  game.addCondition(q, 'leg');
  const res = game.move(q, { place: 'factory' });
  assert.equal(res.ok, false);
});

test('работа: смена тратит силы, правильные ответы дают талоны', () => {
  const { game, clock } = makeWorld();
  const p = join(game, 'Иван');
  game.admin('teleport', { id: p.id, place: 'factory' });
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
  assert.equal(game.buy(p, 'canteen', 'bread').ok, false); // нет денег
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
  assert.equal(game.seal(inside, true).ok, true);
  game.admin('fog', { from: 100, to: 110, warnSec: 5, durationMin: 6, intensity: 1 });
  advance(5000);
  assert.equal(game.fogPhase(), 'active');
  advance(60000);
  assert.ok(outside.stats.health < 90, `здоровье снаружи: ${outside.stats.health}`);
  assert.equal(Math.round(inside.stats.health), 100);
  advance(6 * 60000);
  assert.equal(game.world.fog, null, 'туман рассеялся сам');
  assert.equal(outside.alive, false, 'кто не спрятался — тот погиб');
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
  const b = join(game, 'Сосед');
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

  game.admin('teleport', { id: b.id, place: 'canteen' });
  assert.equal(game.tradeOffer(a, b.id, { money: 1 }, {}).ok, false, 'не рядом');
  assert.equal(game.tradeOffer(a, b.id, { money: 100 }, {}).ok, false, 'нет денег');
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
