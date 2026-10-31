'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const World = require('../public/shared/world.js');
const { WORLD_CONFIG } = require('../server/game');

const world = World.create(WORLD_CONFIG);
const facilityFloors = Object.values(WORLD_CONFIG.facilities);
const KEYS = [
  ...[1, 50, 97, 99, ...facilityFloors, 101, 102, 150, 999].map((f) => `corridor:${f}`),
  'home:10101',
  'home:99906',
  'canteen',
  'medpost',
  'factory',
  'lift',
  'stairs',
];

test('все схемы прямоугольные', () => {
  for (const [name, t] of Object.entries(World.TEMPLATES)) {
    const w = t.rows[0].length;
    t.rows.forEach((row, y) => assert.equal(row.length, w, `${name}, строка ${y}`));
  }
});

test('в каждой сцене можно встать на точку появления и дойти до всего, с чем можно взаимодействовать', () => {
  for (const key of KEYS) {
    const scene = world.scene(key);
    const spawn = world.spawn(key);
    assert.ok(World.canStand(scene, spawn.x, spawn.y), `${key}: точка появления в стене`);
    for (const o of scene.objects) {
      if (o.decor) continue;
      assert.ok(o.spot, `${key}: к объекту ${o.type} не подойти`);
      assert.ok(World.findPath(scene, spawn, o.spot), `${key}: до ${o.type} не дойти`);
      assert.ok(World.nearObject(o, o.spot), `${key}: с точки подхода ${o.type} не достать`);
    }
  }
});

test('этажи: жилые с квартирами, служебные с учреждением, технические с запертыми дверями', () => {
  const res = world.scene('corridor:101');
  assert.deepEqual(
    res.objects.filter((o) => o.type === 'apt').map((o) => o.number),
    ['10101', '10102', '10103', '10104', '10105', '10106'],
  );
  for (const [facility, floor] of Object.entries(WORLD_CONFIG.facilities)) {
    const s = world.scene(`corridor:${floor}`);
    assert.equal(s.objects.find((o) => o.type === 'facility').facility, facility);
    assert.equal(s.objects.filter((o) => o.type === 'apt').length, 0);
  }
  const tech = world.scene('corridor:50');
  assert.equal(tech.objects.filter((o) => o.type === 'locked').length, 6);
  assert.ok(tech.style.technical);
});

test('у каждого станка в цеху своя мини-игра', () => {
  const games = world.scene('factory').objects.filter((o) => o.type === 'station').map((o) => o.game).sort();
  assert.deepEqual(games, ['gauge', 'meter', 'sort']);
});

test('поиск пути обходит стены', () => {
  const s = world.scene('canteen');
  const path = World.findPath(s, world.spawn('canteen'), s.objects.find((o) => o.type === 'counter').spot);
  assert.ok(path && path.length > 3);
  for (const pt of path) assert.ok(!World.isSolidTile(s, Math.floor(pt.x), Math.floor(pt.y)));
});
