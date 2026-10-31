'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../server/storage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gh-storage-'));

test('нет файла — новый мир (null); битый файл — ошибка, а не пустой мир', () => {
  const dir = tmp();
  const file = path.join(dir, 'world.json');
  assert.equal(storage.load(file), null);
  fs.writeFileSync(file, '{"players": {');
  assert.throws(() => storage.load(file), storage.CorruptSaveError);
  fs.writeFileSync(file, '42');
  assert.throws(() => storage.load(file), storage.CorruptSaveError);
});

test('сохранение атомарное и читается обратно', () => {
  const file = path.join(tmp(), 'sub', 'world.json');
  storage.save(file, { a: 1 });
  assert.deepEqual(storage.load(file), { a: 1 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('резервные копии с ротацией', () => {
  const dir = tmp();
  const file = path.join(dir, 'world.json');
  const backups = path.join(dir, 'backups');
  assert.equal(storage.backup(file, backups), null, 'копировать нечего');
  storage.save(file, { n: 1 });
  for (let h = 0; h < 5; h++) storage.backup(file, backups, 3, new Date(Date.UTC(2026, 9, 31, h)));
  const copies = fs.readdirSync(backups).sort();
  assert.equal(copies.length, 3);
  assert.equal(copies[2], 'world-2026-10-31-04-00.json');
  assert.equal(storage.latestBackup(backups), path.join(backups, copies[2]));
});
