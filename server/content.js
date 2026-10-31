'use strict';

/**
 * Весь «контент» игры в одном месте: предметы, болезни, несчастные случаи,
 * локации и баланс. Чтобы добавить новую болезнь или предмет — допишите
 * запись сюда, остальной код подхватит её автоматически (в том числе
 * админ-панель).
 */

// ---------------------------------------------------------------------------
// Здание
// ---------------------------------------------------------------------------
const BUILDING = {
  name: 'Корпус 7-Б',
  firstResidentialFloor: 101, // с какого этажа заселяем жильцов
  apartmentsPerFloor: 6,
  minFloor: 1,
  maxFloor: 999,
};

// Общие помещения. floor — где они находятся (важно для лестницы и тумана).
const FACILITIES = {
  canteen: { name: 'Столовая №3', floor: 100 },
  medpost: { name: 'Медпункт', floor: 104 },
  factory: { name: 'Цех №4', floor: 96 },
};

// ---------------------------------------------------------------------------
// Баланс. Все скорости — «в минуту реального времени» для игрока онлайн.
// ---------------------------------------------------------------------------
const BALANCE = {
  tickMs: 1000,
  // Офлайн-игроки «спят» дома: всё убывает гораздо медленнее.
  offlineFactor: 0.03,

  hungerPerMin: -3, // сытость падает: 100 → 0 примерно за 33 минуты
  starvationHpPerMin: -6, // урон здоровью при сытости 0
  healthRegenPerMin: 1, // если сыт (>50) и ничем не болен
  energyPassivePerMin: -0.5,
  energyHomeRegenPerMin: 5,
  energySleepRegenPerMin: 20,
  sanityHomeRegenPerMin: 1,
  sanityZeroHpPerMin: -2, // рассудок 0 — начинает страдать здоровье

  // Туман
  fogHpOutsidePerMin: -20,
  fogHpHomeUnsealedPerMin: -8,
  fogSanityOutsidePerMin: -15,
  fogSanityHomeUnsealedPerMin: -5,
  gasMaskFactor: 0.25, // противогаз оставляет 25% урона
  fogSicknessChancePerMin: 0.25, // шанс подхватить «туманную хворь» вне защищённой квартиры

  // Темнота (отключение света)
  darkSanityPerMin: -3,

  // Перемещение
  liftBaseSec: 3,
  liftSecPerFloor: 0.08,
  stairsSecPerFloor: 0.25,
  stairsEnergyPerFloor: 0.4,

  // Работа
  workEnergyCost: 12,
  workHungerCost: 3,

  // Общение: бонус к рассудку за сообщение в общем чате локации (не чаще раза в 20 с)
  chatSanityBonus: 2,
  chatSanityCooldownMs: 20000,

  // Стартовые параметры новосёла: «в начале у них ничего нет»
  start: { health: 100, hunger: 70, energy: 80, sanity: 90, money: 0 },
};

// ---------------------------------------------------------------------------
// Предметы
// ---------------------------------------------------------------------------
// use: что делает предмет при использовании (через «Использовать» в инвентаре)
const ITEMS = {
  bread: { name: 'Хлеб', desc: 'Серый, вчерашний.', use: { hunger: 15 } },
  rusk: { name: 'Сухари', desc: 'Хранятся вечно.', use: { hunger: 8 } },
  stew: { name: 'Тушёнка', desc: 'Банка без этикетки. Наверное, говядина.', use: { hunger: 45, sanity: 3 } },
  kissel: { name: 'Кисель', desc: 'Розовый. Тёплый.', use: { hunger: 5, sanity: 8 } },
  pills: { name: 'Таблетки', desc: 'Лечат почти всё. Почти.', use: { cure: ['flu', 'cough', 'poisoning'] } },
  serum: { name: 'Сыворотка', desc: 'Ампула с мутной жидкостью.', use: { cure: ['fogsick', 'insomnia'], sanity: 10 } },
  bandage: { name: 'Бинт', desc: 'Стерильный (по документам).', use: { health: 15, cure: ['burn', 'bite'], shorten: ['arm', 'leg'] } },
  gasmask: { name: 'Противогаз', desc: 'ГП-5. Снижает вред тумана. Изнашивается.', equip: true },
  flashlight: { name: 'Фонарик', desc: 'Спасает рассудок в темноте.', equip: true },
  spoon: { name: 'Ложка', desc: 'Алюминиевая. Ценная вещь.' },
  fork: { name: 'Вилка', desc: 'Три зубца из четырёх.' },
  bulb: { name: 'Лампочка', desc: '60 Вт. Валюта на чёрном рынке.' },
};

// Меню учреждений: что можно купить за талоны.
// eat: true — съедается на месте (суп). needsSpoon — нужна своя ложка, если в столовой украли приборы.
const SHOPS = {
  canteen: [
    { id: 'soup', name: 'Суп дня', price: 4, eat: true, effect: { hunger: 35 }, needsSpoon: true },
    { id: 'tea', name: 'Чай', price: 1, eat: true, effect: { hunger: 2, sanity: 6 } },
    { item: 'bread', price: 2 },
    { item: 'kissel', price: 2 },
    { item: 'rusk', price: 1 },
    { item: 'stew', price: 7 },
    { item: 'spoon', price: 3, hiddenIfStolen: true },
  ],
  medpost: [
    { id: 'checkup', name: 'Осмотр фельдшера (+20 здоровья)', price: 3, eat: true, effect: { health: 20 } },
    { item: 'pills', price: 5 },
    { item: 'bandage', price: 3 },
    { item: 'serum', price: 9 },
    { item: 'flashlight', price: 8 },
    { item: 'gasmask', price: 15 },
  ],
};

// ---------------------------------------------------------------------------
// Состояния: болезни и травмы. perMin — эффекты в минуту, пока состояние активно.
// durationMin — сколько длится (null — пока не вылечат).
// contagious — шанс в минуту заразить каждого, кто находится в той же локации.
// blocks — что запрещает: 'work' (не может работать), 'stairs' (не может ходить по лестнице)
// ---------------------------------------------------------------------------
const CONDITIONS = {
  flu: {
    name: 'Грипп', kind: 'disease', durationMin: 15, contagious: 0.15,
    perMin: { health: -1.5, energy: -1 }, symptom: 'чихает',
  },
  cough: {
    name: 'Бетонный кашель', kind: 'disease', durationMin: 30, contagious: 0.08,
    perMin: { health: -0.8, sanity: -0.5 }, symptom: 'надсадно кашляет',
  },
  poisoning: {
    name: 'Отравление', kind: 'disease', durationMin: 6,
    perMin: { hunger: -4, health: -1 }, symptom: 'бледный',
  },
  fogsick: {
    name: 'Туманная хворь', kind: 'disease', durationMin: null, contagious: 0.03,
    perMin: { sanity: -3, health: -0.5 }, symptom: 'смотрит сквозь стены',
  },
  insomnia: {
    name: 'Бессонница', kind: 'disease', durationMin: 20,
    perMin: { sanity: -1.5 }, noSleep: true, symptom: 'с красными глазами',
  },
  arm: {
    name: 'Перелом руки', kind: 'injury', durationMin: 15, blocks: ['work'],
    perMin: {}, symptom: 'рука в гипсе',
  },
  leg: {
    name: 'Перелом ноги', kind: 'injury', durationMin: 15, blocks: ['stairs'],
    perMin: { energy: -0.5 }, symptom: 'хромает',
  },
  burn: {
    name: 'Ожог', kind: 'injury', durationMin: 10, perMin: { health: -0.5 }, symptom: 'в бинтах',
  },
  bite: {
    name: 'Крысиный укус', kind: 'injury', durationMin: 8, perMin: { health: -0.7 }, symptom: 'расчёсывает руку',
  },
};

// ---------------------------------------------------------------------------
// Несчастные случаи — шаблоны для админки. Мгновенный эффект + (опционально) состояние.
// ---------------------------------------------------------------------------
const ACCIDENTS = {
  slip: { name: 'Поскользнулся на лестнице', text: 'Ступенька оказалась мокрой. Вы неудачно падаете.', effect: { health: -10 } },
  armBreak: { name: 'Перелом руки', text: 'Тяжёлая дверь щитовой захлопнулась прямо на руку.', effect: { health: -15 }, condition: 'arm' },
  legBreak: { name: 'Перелом ноги', text: 'Ступенька пролёта просто исчезла под ногой.', effect: { health: -20 }, condition: 'leg' },
  shock: { name: 'Удар током', text: 'Голый провод в коридоре. Вспышка. Запах палёного.', effect: { health: -30, sanity: -10 } },
  burn: { name: 'Ожог паром', text: 'Прорвало трубу отопления. Кипяток и пар.', effect: { health: -15 }, condition: 'burn' },
  rat: { name: 'Укус крысы', text: 'Из вентиляции выскочила крыса размером с кошку.', effect: { health: -8, sanity: -5 }, condition: 'bite' },
  garbage: { name: 'Падение в мусоропровод', text: 'Вы наклонились посмотреть, что там гудит. Зря.', effect: { health: -50, sanity: -30 } },
  robbery: { name: 'Ограбление', text: 'В тёмном пролёте кто-то вырвал у вас всё, что было в карманах.', effect: { money: 'all' } },
  liftShaft: { name: 'Падение в шахту лифта', text: 'Двери лифта открылись. Кабины за ними не было.', effect: { kill: true } },
};

// ---------------------------------------------------------------------------
// Места, по которым ходит игрок
// ---------------------------------------------------------------------------
const PLACES = {
  home: { name: 'Квартира' },
  corridor: { name: 'Коридор этажа' },
  canteen: { name: FACILITIES.canteen.name, facility: true },
  medpost: { name: FACILITIES.medpost.name, facility: true },
  factory: { name: FACILITIES.factory.name, facility: true },
  lift: { name: 'Лифт' },
  stairs: { name: 'Лестница' },
};

// Поломки, которые админ может включать/выключать
const BREAKDOWNS = {
  lift: { name: 'Лифт', brokenText: 'Лифт сломан — только пешком по лестнице.' },
  canteen: { name: 'Столовая', brokenText: 'Столовая закрыта: санитарный день.' },
  medpost: { name: 'Медпункт', brokenText: 'Медпункт закрыт: фельдшер пропал.' },
  factory: { name: 'Цех', brokenText: 'Цех стоит: авария на линии.' },
};

// Что «слышат» жильцы с почти нулевым рассудком. Приходит им в чат как будто от соседа.
const HALLUCINATIONS = [
  'ты слышишь, как за стеной кто-то повторяет твоё имя?',
  'не открывай дверь. это не я стучу.',
  'на 0 этаже есть выход. правда. спустись.',
  'лифт сегодня едет вниз бесконечно',
  'они считают квартиры. твоя — следующая.',
  'туман уже внутри. посмотри на свои руки.',
  'зачем ты ешь этот хлеб? он смотрит на тебя.',
  'в мусоропроводе кто-то живёт и он голоден',
];

module.exports = {
  BUILDING, FACILITIES, BALANCE, ITEMS, SHOPS, CONDITIONS, ACCIDENTS, PLACES, BREAKDOWNS, HALLUCINATIONS,
};
