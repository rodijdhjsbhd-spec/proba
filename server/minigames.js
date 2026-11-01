'use strict';

/**
 * Мини-игры «работы» в цеху.
 *
 * Схема: сервер генерирует задание (create), отдаёт клиенту только публичную
 * часть (publicData), клиент присылает ответы, сервер сам считает результат
 * (score от 0 до 1). Правильные ответы на клиент не уходят там, где это
 * возможно, поэтому «подделать» смену сложнее.
 */

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------------------
// 1. Сортировка деталей
// ---------------------------------------------------------------------------
const SORT_PARTS = {
  bolt: { name: 'Болт', ok: ['оцинкованный', 'латунный', 'новый', 'стальной'], bad: ['ржавый', 'гнутый', 'с трещиной', 'без резьбы'] },
  nut: { name: 'Гайка', ok: ['оцинкованная', 'латунная', 'новая', 'стальная'], bad: ['ржавая', 'гнутая', 'с трещиной', 'без резьбы'] },
  washer: { name: 'Шайба', ok: ['оцинкованная', 'латунная', 'новая', 'пружинная'], bad: ['ржавая', 'гнутая', 'с трещиной', 'с заусенцем'] },
};
const SORT_BINS = [
  { id: 'bolt', name: 'Болты' },
  { id: 'nut', name: 'Гайки' },
  { id: 'washer', name: 'Шайбы' },
  { id: 'defect', name: 'Брак' },
];
const SIZES = ['М6', 'М8', 'М10', 'М12'];

function createSort(rank = 1) {
  const count = 12 + (rank - 1) * 2; // выше разряд — больше деталей за то же время
  const items = [];
  const answers = [];
  for (let i = 0; i < count; i++) {
    const type = pick(Object.keys(SORT_PARTS));
    const part = SORT_PARTS[type];
    const defect = Math.random() < 0.3;
    const adj = defect ? pick(part.bad) : pick(part.ok);
    items.push(`${part.name} ${pick(SIZES)}, ${adj}`);
    answers.push(defect ? 'defect' : type);
  }
  return {
    publicData: {
      title: 'Сортировка деталей',
      rules: 'Разложите детали по ящикам. Любая испорченная деталь — в «Брак».',
      items,
      bins: SORT_BINS,
      limitSec: 40,
    },
    secret: { answers },
    limitSec: 40,
    minSec: 4,
  };
}

function scoreSort(job, answers) {
  if (!Array.isArray(answers)) return 0;
  const correct = job.secret.answers;
  let ok = 0;
  for (let i = 0; i < correct.length; i++) if (answers[i] === correct[i]) ok++;
  return ok / correct.length;
}

// ---------------------------------------------------------------------------
// 2. Снятие показаний счётчиков (на память)
// ---------------------------------------------------------------------------
function createMeter(rank = 1) {
  const digits = rank >= 4 ? 6 : 5; // со 4-го разряда — шестизначные счётчики
  const readings = [];
  for (let i = 0; i < 5; i++) readings.push(String(rnd(10 ** digits)).padStart(digits, '0'));
  const showMs = Math.max(1100, 2000 - (rank - 1) * 150);
  return {
    publicData: {
      title: 'Показания счётчиков',
      rules: `Каждое показание видно ${(showMs / 1000).toFixed(1).replace('.', ',')} с. Запомните и перепишите все пять в журнал.`,
      readings, // клиент показывает их по одному и прячет
      showMs,
      limitSec: 60,
    },
    secret: { readings },
    limitSec: 60,
    minSec: 8,
  };
}

function scoreMeter(job, answers) {
  if (!Array.isArray(answers)) return 0;
  const correct = job.secret.readings;
  let digits = 0;
  let ok = 0;
  correct.forEach((value, i) => {
    const given = String(answers[i] ?? '').replace(/\D/g, '').padStart(value.length, '0').slice(-value.length);
    for (let d = 0; d < value.length; d++) {
      digits++;
      if (given[d] === value[d]) ok++;
    }
  });
  return digits ? ok / digits : 0;
}

// ---------------------------------------------------------------------------
// 3. Манометр: нажать, когда стрелка в зелёной зоне
// ---------------------------------------------------------------------------
// Позиция стрелки (0..1) — детерминированная функция времени. Та же формула
// продублирована в клиенте (public/game.js → gaugePos), чтобы сервер мог
// проверить присланные моменты нажатий.
function gaugePos(p, tMs) {
  const t = tMs / 1000;
  return clamp01(0.5 + 0.33 * Math.sin(t * p.w1 + p.p1) + 0.14 * Math.sin(t * p.w2 + p.p2));
}

function createGauge(rank = 1) {
  const params = {
    w1: 1.6 + Math.random() * 0.9,
    p1: Math.random() * Math.PI * 2,
    w2: 3.4 + Math.random() * 1.8,
    p2: Math.random() * Math.PI * 2,
    center: 0.3 + Math.random() * 0.4,
    width: Math.max(0.06, 0.12 - (rank - 1) * 0.012), // выше разряд — уже зелёная зона
    presses: 6,
  };
  return {
    publicData: {
      title: 'Стравливание давления',
      rules: 'Жмите «Сброс», когда стрелка манометра в зелёной зоне. Шесть сбросов.',
      ...params,
      limitSec: 30,
    },
    secret: { params },
    limitSec: 30,
    minSec: 1,
  };
}

function scoreGauge(job, answers, elapsedMs) {
  if (!Array.isArray(answers)) return 0;
  const p = job.secret.params;
  const presses = answers
    .map(Number)
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= (job.limitSec + 5) * 1000 && t <= elapsedMs + 1000)
    .slice(0, p.presses);
  let hits = 0;
  let last = -Infinity;
  for (const t of presses) {
    if (t - last < 250) continue; // слишком частые нажатия не считаем
    last = t;
    const pos = gaugePos(p, t);
    if (Math.abs(pos - p.center) <= p.width / 2) hits++;
  }
  return hits / p.presses;
}

// ---------------------------------------------------------------------------
const GAMES = {
  sort: { name: 'Сортировка деталей', create: createSort, score: scoreSort },
  meter: { name: 'Показания счётчиков', create: createMeter, score: scoreMeter },
  gauge: { name: 'Стравливание давления', create: createGauge, score: scoreGauge },
};

/** Талоны за смену в зависимости от качества (0..1). */
function rewardFor(score) {
  if (score < 0.3) return 0;
  return Math.max(1, Math.round(score * 6));
}

function createJob(gameId, rank = 1) {
  const game = GAMES[gameId];
  if (!game) return null;
  const job = game.create(Math.max(1, Math.min(6, rank)));
  return { game: gameId, ...job };
}

/**
 * Посчитать результат смены. elapsedMs — сколько прошло на сервере.
 * Слишком быстрые ответы считаются подозрительными, просроченные — штрафуются.
 */
function scoreJob(job, answers, elapsedMs) {
  const game = GAMES[job.game];
  if (!game) return 0;
  if (elapsedMs < job.minSec * 1000) return 0;
  let score = clamp01(game.score(job, answers, elapsedMs));
  if (elapsedMs > (job.limitSec + 5) * 1000) score *= 0.5;
  return score;
}

module.exports = { GAMES, createJob, scoreJob, rewardFor, gaugePos, SORT_BINS };
