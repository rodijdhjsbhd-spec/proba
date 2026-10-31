'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MG = require('../server/minigames');

test('сортировка: идеальные ответы = 1, мусор = 0', () => {
  const job = MG.createJob('sort');
  assert.equal(job.publicData.items.length, 12);
  assert.equal(job.publicData.answers, undefined, 'ответы не уходят клиенту');
  assert.equal(MG.scoreJob(job, job.secret.answers, 10000), 1);
  assert.equal(MG.scoreJob(job, [], 10000), 0);
  assert.equal(MG.scoreJob(job, job.secret.answers, 500), 0, 'слишком быстро — подозрительно');
  assert.equal(MG.scoreJob(job, job.secret.answers, 120000), 0.5, 'опоздание — половина');
});

test('счётчики: считаются совпавшие цифры', () => {
  const job = MG.createJob('meter');
  const perfect = job.secret.readings.slice();
  assert.equal(MG.scoreJob(job, perfect, 15000), 1);
  const oneWrong = perfect.slice();
  oneWrong[0] = oneWrong[0].split('').map((d) => String((Number(d) + 1) % 10)).join('');
  assert.equal(MG.scoreJob(job, oneWrong, 15000), 0.8);
});

test('манометр: нажатия в зелёной зоне засчитываются', () => {
  const job = MG.createJob('gauge');
  const p = job.secret.params;
  // находим моменты, когда стрелка в зелёной зоне
  const good = [];
  for (let t = 3000; t < 28000 && good.length < p.presses; t += 10) {
    if (Math.abs(MG.gaugePos(p, t) - p.center) <= p.width / 2 && (!good.length || t - good[good.length - 1] >= 300)) good.push(t);
  }
  assert.equal(good.length, p.presses);
  assert.equal(MG.scoreJob(job, good, 29000), 1);
  assert.equal(MG.scoreJob(job, good, 1000), 0, 'нажатия «из будущего» не считаются');
});

test('награда растёт с качеством', () => {
  assert.equal(MG.rewardFor(0.1), 0);
  assert.equal(MG.rewardFor(1), 6);
  assert.ok(MG.rewardFor(0.5) < MG.rewardFor(0.9));
});
