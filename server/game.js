'use strict';

/**
 * Игровой мир гигахрущёвки. Ничего не знает о сети: index.js подписывается
 * на события (emit) и рассылает их по WebSocket.
 *
 * События, которые испускает Game:
 *   'notify'  { to: [playerId...], title, text, style }  — всплывающее уведомление
 *   'chat'    msg                                         — сообщение чата
 *   'log'     entry                                       — запись в журнал админки
 *   'dirty'   [playerId...]                               — этим игрокам надо обновить экран
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const C = require('./content');
const MG = require('./minigames');
const World = require('../public/shared/world.js');

const B = C.BALANCE;
const STAT_KEYS = ['health', 'hunger', 'energy', 'sanity'];
// какие уведомления дублировать пушем тем, кто не в сети; 'urgent' — срочные (телефон звонит громче)
const PUSH_STYLES = { siren: 'urgent', fog: 'urgent', danger: 'urgent', death: 'urgent', knock: 'normal', whisper: 'normal', announce: 'normal' };
const PUSH_TAG_GAP_MS = 10 * 60000;
const PUSH_URGENT_GAP_MS = 30000;
const PUSH_PER_HOUR = 12;
const PEOPLE_SHOWN = 30; // сколько соседей по сцене попадает в вид жильца (остальные — числом)
/** Цена вещей по прилавкам (для лимита подарков новосёла: что сверх цены — подарок). */
function bundleWorth(b) {
  let sum = (b && b.money) || 0;
  for (const [id, n] of Object.entries((b && b.items) || {})) {
    let price = 0;
    for (const list of Object.values(C.SHOPS)) for (const e of list) if (e.item === id) price = Math.max(price, e.price);
    sum += price * n;
  }
  return sum;
}
const STAT_NAMES = { health: 'Здоровье', hunger: 'Сытость', energy: 'Силы', sanity: 'Рассудок' };
const MOVE_PLACES = ['home', 'corridor', 'canteen', 'medpost', 'factory'];

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const toInt = (v, def = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : def;
};
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

/** Настройки карт мира — одинаковые для сервера и браузера (отдаются клиенту при входе). */
const WORLD_CONFIG = {
  firstResidentialFloor: C.BUILDING.firstResidentialFloor,
  facilities: Object.fromEntries(Object.entries(C.FACILITIES).map(([k, v]) => [k, v.floor])),
  facilityNames: Object.fromEntries(Object.entries(C.FACILITIES).map(([k, v]) => [k, v.name])),
};
const SEARCH_COOLDOWN_MS = 5 * 60000;

function sanitizeText(raw, max) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Буквы, которые выглядят одинаково в латинице и кириллице, — к одной (для сравнения имён)
const HOMOGLYPHS = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', ё: 'е', 3: 'з', 0: 'о', 6: 'б', i: 'і', l: 'і', 1: 'і', ї: 'і', є: 'е', ґ: 'г' };
/** «Скелет» имени: без регистра, пробелов, знаков, с одинаковыми буквами-двойниками. */
function nameSkeleton(name) {
  return String(name || '')
    .toLocaleLowerCase('ru')
    .replace(/[\s._\-]/g, '')
    .replace(/[abcehkmoptxyё306il1їєґ]/g, (ch) => HOMOGLYPHS[ch] || ch);
}

function sanitizeName(raw) {
  // только кириллица (с украинскими и белорусскими буквами), латиница, цифры, пробел, точка, дефис:
  // греческие двойники, невидимые «буквы»-заполнители и прочая экзотика позволяли выдать себя за соседа
  const name = sanitizeText(raw, 40).replace(/\s+/g, ' ').trim();
  if (/[^A-Za-zА-Яа-яЁёІіЇїЄєҐґЎў0-9 _.\-]/.test(name)) return null; // чужие буквы — не вырезаем молча, а отказываем
  return /[A-Za-zА-Яа-яЁёІіЇїЄєҐґЎў]/.test(name) && name.length >= 2 && name.length <= 20 ? name : null;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const talons = (n) => `${n} ${plural(n, 'талон', 'талона', 'талонов')}`;

/** «3 ч 12 мин», «17 мин», «меньше минуты» */
function fmtDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'меньше минуты';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function freshState() {
  return {
    version: 1,
    world: {
      tick: 0,
      gameMinutes: 8 * 60, // День 1, 08:00
      paused: false,
      breakdowns: { lift: null, canteen: null, medpost: null, factory: null },
      power: null, // { from, to, until }
      fog: null, // { from, to, warnUntil, until, intensity, arrived }
      cutleryStolen: false,
      shiftsToday: 0, // смен закрыто за игровые сутки — от них зависит завоз
      lastSupplyDay: null,
      supplyNext: 1, // множитель следующего завоза (ЖЭК может устроить недовоз)
      lampsOut: {}, // этаж → номера погасших ламп в коридоре
      hazards: {}, // сцена → опасности на клетках [{ id, kind, x, y, fenced, until }]
      scars: {}, // сцена → следы событий [{ id, kind, x, y, at, text? }], выцветают за B.scarHours
      radio: { queue: [], silenceUntil: null, lastAirMin: 0, lastNewsTs: 0, slot: 0, log: [] },
      rent: null, // талонов в сутки; null — по умолчанию из BALANCE.rent, 0 — квартплаты нет
      lastDay: null, // игровые сутки, для которых уже прошла полночь (порча еды, квартплата)
      baryga: null, // { floor, x, y, purse, purseDay } — барыга на техническом этаже (ставит ЖЭК)
      barygaClients: {}, // жилец → когда последний раз продавал барыге
      plan: null, // план дома на неделю { week, target, done, participants }
      honor: null, // доска почёта прошлой недели { week, workers, generous }
      puppets: {}, // марионетки ЖЭК { id: { id, name, preset, lookId, scene, x, y, d, path } }
      pried: {}, // вскрытые служебные двери: id двери → { by, at }
      climate: [], // микроклимат этажей { id, from, to, kind, until, harm }
      overlays: {}, // перепланировка: сцена → [{ id, kind: wall|rubble|closet, tiles: [[x,y]] }]
      closets: {}, // кладовки: «сцена:x:y» → { items, text, taken: [id] }
      anomalies: { extraFloor: null, wrongDoor: null, stairLoop: null },
    },
    players: {},
    trades: {},
    log: [],
    chatGlobal: [],
    archive: [], // погибшие давно: краткие записи домовой книги
    doors: {}, // кв. → { sealed } — гермодверь принадлежит квартире, а не жильцу (внутри бывают гости)
    doorDrops: {}, // кв. → записки и передачки, ждущие хозяина у гермодвери
    boardNotes: {}, // этаж → листки жильцов на доске объявлений
    noteFeed: [], // лента записок и листков для Пульта
    schedule: [], // планировщик ЖЭК: отложенные и повторяющиеся команды
    accounts: {}, // логин (строчными) → паспорт жильца { login, salt, hash, playerIds, banned }
    assignments: [], // разнарядки ЖЭК на этажи { id, from, to, text, kind, item, amount, until, done: { кв.: ts } }
    petitions: [], // коллективные жалобы { id, floor, text, authorId, signers: [{ id, name, apt }], status, createdAt }
    elders: {}, // этаж → { votes: { голосующий: кандидат } } — старший по этажу
    ious: [], // долговые расписки { id, debtorId, holderId, bundle, dueDay, createdAt, status }
    admins: {}, // личные учётки богов: логин → { login, salt, hash, role, createdAt } (root — пароль из ADMIN_PASSWORD)
    godLog: [], // журнал богов: кто что нажал { ts, who, cmd, args, ok, error }
    scenarios: {}, // свои сценарии ЖЭК { id: { name, steps } } (встроенные — в content.js)
    scenarioRuns: [], // идущие сценарии { id, scenarioId, name, step, nextAt, startedAt }
    palette: { conditions: {}, accidents: {}, items: {} }, // беды и предметы, придуманные в Пульте
    stock: null, // запасы столовой и медпункта на сегодня: { canteen: { ключ: штук } } — заполняется при загрузке
    bannedIps: {}, // адрес → { until, reason }
  };
}

class Game extends EventEmitter {
  /**
   * @param {object|null} state сохранённое состояние (или null для нового мира)
   * @param {object} opts { now: () => ms, random: () => 0..1 } — для тестов
   */
  constructor(state, opts = {}) {
    super();
    this.now = opts.now || (() => Date.now());
    this.random = opts.random || Math.random;
    this.state = Game.normalize(state);
    this.onlineSet = new Set();
    this.lastChatAt = new Map();
    this.localChat = new Map(); // key → последние сообщения (только в памяти)
    this.byToken = new Map();
    this.map = World.create(this.worldConfig());
    this.state.palette = this.state.palette || { conditions: {}, accidents: {}, items: {} };
    this.applyPalette();
    if (!this.state.stock) this.state.stock = this.fullStock(1);
    if (this.world.lastSupplyDay == null) {
      // сегодняшний завоз уже был, если сейчас позже часа завоза
      const day = Math.floor(this.world.gameMinutes / 1440);
      const hour = Math.floor((this.world.gameMinutes % 1440) / 60);
      this.world.lastSupplyDay = hour >= B.supplyHour ? day : day - 1;
    }
    if (this.world.lastDay == null) this.world.lastDay = Math.floor(this.world.gameMinutes / 1440); // первая полночь — впереди
    this.lastKnock = new Map();
    this.knocks = new Map(); // хозяин → кто стучит { guestId, ts }
    this.pushLimits = new Map(); // жилец → { tag: ts, hour: [ts…] } — чтобы не завалить телефон
    this.groupSince = new Map(); // сцена → с какого момента там собралось 3+ жильцов (для режиссёра)
    this.refusals = new Map(); // гость → кто не открыл ему в туман или выставил { apt, owner, ts, kind }
    this.unsealedBy = new Map(); // кв. → гость, который открыл чужую гермодверь
    this.snapshots = []; // снимки мира перед опасными командами (в памяти; сервер хранит их и на диске)
    // Сервер лежал: для мира это пауза. Таймеры (туман, поломки, болезни, «без сознания», расписание)
    // продолжаются с того же места — иначе лежачий умрёт на первом тике, пока помочь было некому.
    const downtime = this.state.savedAt ? this.now() - this.state.savedAt : 0;
    if (downtime > 1000 && !this.world.paused) this.shiftTimers(downtime);
    for (const p of Object.values(this.state.players)) {
      this.byToken.set(p.token, p.id);
      const scene = this.sceneOf(p);
      if (!p.pos || !World.canStand(scene, p.pos.x, p.pos.y)) p.pos = { ...this.map.spawn(scene.key), d: 'down' };
      p.posSeq = p.posSeq || 1;
      // После перезапуска сервера все не в сети. Кто был в сети в момент сохранения — «ушёл» тогда,
      // а не в момент входа: иначе вернувшимся придёт ложная квитанция за всю их сессию.
      if (p.alive && !p.leftAt) this.markAway(p, this.state.savedAt || this.now());
      if (p.homeward && p.homeward.arriveAt !== undefined) p.homeward = { since: p.homeward.since, nextAt: null, step: null };
    }
  }

  static normalize(state) {
    const fresh = freshState();
    if (!state || typeof state !== 'object') return fresh;
    const s = { ...fresh, ...state };
    s.world = { ...fresh.world, ...(state.world || {}) };
    s.world.lampsOut = s.world.lampsOut || {};
    s.world.hazards = s.world.hazards || {};
    s.world.scars = s.world.scars || {};
    s.world.barygaClients = s.world.barygaClients || {};
    s.world.pried = s.world.pried || {};
    s.world.climate = Array.isArray(s.world.climate) ? s.world.climate : [];
    s.world.overlays = s.world.overlays && typeof s.world.overlays === 'object' ? s.world.overlays : {};
    s.world.closets = s.world.closets || {};
    s.world.anomalies = { extraFloor: null, wrongDoor: null, stairLoop: null, ...(s.world.anomalies || {}) };
    s.world.puppets = s.world.puppets && typeof s.world.puppets === 'object' ? s.world.puppets : {};
    s.assignments = Array.isArray(s.assignments) ? s.assignments : [];
    s.petitions = Array.isArray(s.petitions) ? s.petitions : [];
    s.elders = s.elders && typeof s.elders === 'object' ? s.elders : {};
    s.ious = Array.isArray(s.ious) ? s.ious : [];
    s.admins = s.admins && typeof s.admins === 'object' ? s.admins : {};
    s.godLog = Array.isArray(s.godLog) ? s.godLog : [];
    s.scenarios = s.scenarios && typeof s.scenarios === 'object' ? s.scenarios : {};
    s.scenarioRuns = Array.isArray(s.scenarioRuns) ? s.scenarioRuns : [];
    s.world.radio = { ...fresh.world.radio, ...(s.world.radio || {}) };
    s.world.breakdowns = { ...fresh.world.breakdowns, ...((state.world || {}).breakdowns || {}) };
    for (const p of Object.values(s.players || {})) {
      p.inventory = p.inventory || {};
      p.conditions = p.conditions || [];
      p.journal = p.journal || [];
      p.gasmaskCharge = p.gasmaskCharge ?? 100;
      p.flashCharge = p.flashCharge ?? 100;
      p.skills = p.skills || {};
      if (p.job) {
        // смену прервал перезапуск сервера (или откат) — возвращается ровно то, что она стоила
        const cost = p.job.cost || { energy: B.workEnergyCost, hunger: B.workHungerCost };
        p.stats.energy = Math.min(100, (p.stats.energy || 0) + (cost.energy || 0));
        p.stats.hunger = Math.min(100, (p.stats.hunger || 0) + (cost.hunger || 0));
      }
      p.job = null;
      if (p.sealed && p.apartment) s.doors[p.apartment.number] = { sealed: true };
      delete p.sealed;
      if (p.location && p.location.place === 'home' && !p.location.apt && p.apartment) p.location.apt = p.apartment.number;
    }
    return s;
  }

  // =========================================================================
  // Вспомогательное
  // =========================================================================
  get world() {
    return this.state.world;
  }

  players() {
    return Object.values(this.state.players);
  }

  /**
   * Живые жильцы. Список кешируется: его спрашивают сотни раз в секунду (соседи, хозяин квартиры,
   * сцены). Сбрасывается там, где меняется состав дома или жив/мёртв (invalidatePlayers), и на всякий
   * случай в начале каждого тика и команды ЖЭК. Массив общий — не менять его на месте.
   */
  alivePlayers() {
    if (!this._alive) this._alive = this.players().filter((p) => p.alive);
    if (this.checkCache) {
      const fresh = this.players().filter((p) => p.alive);
      if (fresh.length !== this._alive.length || fresh.some((p, i) => p !== this._alive[i])) throw new Error('кеш живых жильцов устарел');
    }
    return this._alive;
  }

  invalidatePlayers() {
    this._alive = null;
    this._owners = null;
    this._deadIn = null;
  }

  /**
   * Индекс «сцена → живые жильцы» на время fn (рассылка видов и позиций). Внутри fn никто не
   * переходит из сцены в сцену, поэтому индекс верен; вне fn — обычный перебор.
   */
  withSceneIndex(fn) {
    if (this._sceneIndex) return fn();
    this._sceneIndex = this.playersByScene();
    try {
      return fn();
    } finally {
      this._sceneIndex = null;
    }
  }

  /** Живые жильцы, разложенные по сценам (и те, кто не в сети). */
  playersByScene() {
    const map = new Map();
    for (const p of this.alivePlayers()) {
      const key = this.locationKey(p);
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    return map;
  }

  /** Все живые в сцене key (в сети и нет). */
  playersAt(key) {
    if (this._sceneIndex) return this._sceneIndex.get(key) || [];
    return this.alivePlayers().filter((q) => this.locationKey(q) === key);
  }

  getPlayer(id) {
    return typeof id === 'string' && Object.hasOwn(this.state.players, id) ? this.state.players[id] : null;
  }

  playerByToken(token) {
    const id = this.byToken.get(String(token || ''));
    return id ? this.getPlayer(id) : null;
  }

  isOnline(id) {
    return this.onlineSet.has(id);
  }

  /** Жилец у себя в квартире. */
  isHome(p) {
    return p.location.place === 'home';
  }

  setOnline(id, online) {
    const p = this.getPlayer(id);
    if (!p) {
      this.onlineSet.delete(id);
      return;
    }
    const now = this.now();
    if (online) {
      const wasAway = !this.onlineSet.has(id);
      this.onlineSet.add(id);
      p.lastSeen = now;
      if (!p.alive || !wasAway) return;
      if (p.homeward) {
        // вернулся по дороге — тело там, где успело дойти
        p.homeward = null;
      }
      if (p.leftAt && now - p.leftAt >= B.receiptMinAbsenceMin * 60000) this.sendReceipt(p, now);
      p.leftAt = null;
      p.absence = null;
      this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
      return;
    }
    this.onlineSet.delete(id);
    p.lastSeen = now;
    if (!p.alive) return;
    this.markAway(p, now);
    this.dirty(this.othersAt(p).map((q) => q.id));
  }

  /** Жилец ушёл из игры в момент at: запомнить, каким он был (для квитанции), и отправить тело домой. */
  markAway(p, at) {
    p.leftAt = at;
    p.absence = { knocks: [], stats: Object.fromEntries(STAT_KEYS.map((k) => [k, Math.round(p.stats[k])])), money: p.money };
    if (p.job) p.job = null;
    if (this.isOwnHome(p)) {
      p.sleeping = !this.hasCondition(p, 'insomnia');
    } else if (!p.homeward) {
      // Выход из игры не спасает: тело идёт домой по тем же правилам, что и живой игрок.
      // Пока идёт — соседи его видят.
      p.homeward = { since: at, nextAt: null, step: null };
    }
  }

  /** Сколько миллисекунд идти пешком от a до b (по прямой — тела не петляют). */
  walkMs(a, b) {
    return a && b ? Math.round((Math.hypot(a.x - b.x, a.y - b.y) / World.SPEED) * 1000) + 500 : 500;
  }

  /**
   * Тело ушедшего жильца бредёт домой — по тем же правилам, что и живой игрок:
   * выходит из помещения к двери, идёт к лифту и едет (лифт сломается — застрянет),
   * по лестнице — только если хватает сил и нога цела. С безопасного этажа в туман не идёт,
   * но если туман уже вокруг — не замирает, а идёт дальше (и получает урон).
   */
  updateHomeward(p, now) {
    const h = p.homeward;
    if (p.travel || p.down) return; // едет (или застрял) — ждём прибытия; без сознания — лежит
    if (this.isOwnHome(p)) {
      p.homeward = null;
      return;
    }
    const here = p.location;
    const scene = this.sceneOf(p);
    const wait = (ms) => {
      h.nextAt = now + ms;
      h.step = null;
    };
    if (h.nextAt && now < h.nextAt) return;
    const homeFloor = p.apartment.floor;

    // 1. Из квартиры/учреждения — в коридор этого этажа
    if (here.place !== 'corridor') {
      const exit = scene.objects.find((o) => o.type === 'exit' || o.type === 'hermodoor');
      if (h.step !== 'exit') {
        // за дверью туман — ждём внутри, но только в квартире: в столовой или цеху внутри не безопаснее
        if (this.inFog(here.floor) && here.place === 'home') return wait(5000);
        if (here.place === 'home' && this.doorSealed(this.currentApt(p))) return wait(10000); // дверь задраена
        h.step = 'exit';
        h.nextAt = now + this.walkMs(p.pos, exit && exit.spot);
        return;
      }
      const entry = here.place === 'home' ? `apt:${this.currentApt(p)}` : 'facility';
      this.relocate(p, { place: 'corridor', floor: here.floor }, entry);
      h.step = null;
      h.nextAt = null;
      return;
    }

    // 2. Свой этаж — к своей двери
    if (here.floor === homeFloor) {
      const door = scene.objects.find((o) => o.type === 'apt' && o.number === p.apartment.number);
      if (h.step !== 'door') {
        h.step = 'door';
        h.nextAt = now + this.walkMs(p.pos, door && door.spot);
        return;
      }
      const witnesses = this.othersAt(p);
      p.homeward = null;
      this.relocate(p, { place: 'home', floor: homeFloor, apt: p.apartment.number }, 'bed');
      p.sleeping = !this.hasCondition(p, 'insomnia');
      this.dirty(witnesses.map((q) => q.id));
      return;
    }

    // 3. Чужой этаж — к лифту (или лестнице) и наверх/вниз. В туман на своём этаже не едет —
    // если только туман не стоит и здесь: тогда стоять на месте хуже, чем идти.
    if (this.inFog(homeFloor) && !this.inFog(here.floor)) return wait(5000);
    const via = this.world.breakdowns.lift ? 'stairs' : 'lift';
    // тело уже раз попало в петлю на лестнице — второй раз не идёт: ждёт лифта или конца аномалии
    if (via === 'stairs' && h.looped && this.world.anomalies.stairLoop) return wait(60000);
    const target = scene.objects.find((o) => o.type === via);
    if (h.step !== via) {
      h.step = via;
      h.nextAt = now + this.walkMs(p.pos, target && target.spot);
      return;
    }
    if (target && target.spot) {
      const from = { x: p.pos.x, y: p.pos.y };
      p.pos = { x: target.spot.x, y: target.spot.y, d: 'up' };
      this.checkHazards(p, now, from); // тело идёт по тем же правилам: опасности на пути бьют и его
      if (p.down || !p.alive) return;
    }
    const res = this.startTravel(p, homeFloor, via);
    if (!res.ok) return wait(30000); // не хватает сил на лестницу, перелом, лифт сломался — ждём
    h.step = null;
    h.nextAt = null;
  }

  /** Наследник получает разряды предшественника на ступень ниже и одну вещь из опечатанной квартиры. */
  inherit(heir, dead) {
    heir.heirOf = dead.id;
    heir.tutorial = { done: C.TUTORIAL.map((t) => t.id), rewarded: true, drill: true }; // памятка — только для совсем новых
    const skills = {};
    for (const g of Object.keys(MG.WORK_GAMES)) {
      const rank = this.rankOf(dead, g);
      if (rank > 1) skills[g] = C.RANKS[rank - 2];
    }
    heir.skills = skills;
    // наследство — одно: вещь забирается из опечатанной квартиры, второй наследник её уже не найдёт
    const items = dead.inheritedBy ? [] : Object.keys(dead.inventory || {}).filter((id) => C.ITEMS[id] && dead.inventory[id] > 0);
    dead.inheritedBy = dead.inheritedBy || heir.id;
    const parts = [];
    if (items.length) {
      const id = items[Math.floor(this.random() * items.length)];
      const charge = this.chargeOf(dead, id);
      this.removeItem(dead, id, 1);
      this.addItem(heir, id, 1, charge);
      parts.push(`из опечатанной квартиры вам досталась вещь: ${C.ITEMS[id].name}`);
    }
    if (Object.keys(skills).length) parts.push('трудовая книжка предшественника — на разряд ниже');
    this.journal(heir, `Вы — наследник ${dead.name}${parts.length ? `: ${parts.join('; ')}` : ''}.`, 'good');
  }

  /** Некролог: что видно на экране смерти. */
  obituary(p) {
    const lived = (p.diedAt || this.now()) - (p.createdAt || this.now());
    return {
      lived: fmtDuration(lived),
      shifts: p.shifts || 0,
      helped: (p.deeds && p.deeds.helped) || 0,
      cause: p.deathCause,
      bestRank: this.bestRank(p),
    };
  }

  /** «Отголосок»: погибший выбирает фразу, её услышит живой сосед с пошатнувшимся рассудком. */
  echo(p, phraseIndex) {
    if (p.alive) return { ok: false, error: 'Вы живы.' };
    if (p.echoUsed) return { ok: false, error: 'Вы уже сказали всё, что могли.' };
    const text = C.ECHO_PHRASES[toInt(phraseIndex, -1)];
    if (!text) return { ok: false, error: 'Нет такой фразы.' };
    p.echoUsed = true;
    this.world.echoes = [...(this.world.echoes || []), { from: p.name, text, ts: this.now() }].slice(-20);
    this.log(`Отголосок ${p.name}: «${text}»`, 'social', p.id);
    return { ok: true, message: 'Ваш голос растворился в стенах. Кто-нибудь его услышит.' };
  }

  /** Отметить шаг памятки новосёла. */
  tutorialStep(p, stepId) {
    const t = p.tutorial;
    if (!t || t.rewarded || t.done.includes(stepId)) return;
    t.done.push(stepId);
    const step = C.TUTORIAL.find((x) => x.id === stepId);
    this.journal(p, `Памятка: «${step ? step.text : stepId}» — выполнено.`, 'good');
    if (C.TUTORIAL.every((x) => t.done.includes(x.id))) {
      t.rewarded = true;
      p.money += B.tutorialReward;
      this.notify([p], { title: 'Подъёмные', text: `Вы освоились в доме. ЖЭК выдал подъёмные: ${talons(B.tutorialReward)}.`, style: 'good' });
      this.log(`${p.name} прошёл памятку новосёла`, 'join', p.id);
    }
    this.dirty([p.id]);
  }

  /** Учебная тревога: один раз, когда новосёл впервые вернулся домой после еды. Без урона. */
  tutorialDrill(p) {
    const t = p.tutorial;
    if (!t || t.drill || !t.done.includes('eat') || !this.isOwnHome(p)) return;
    // настоящая сирена или нет света — не время для учений (и «тумана нет» было бы ложью)
    const f = this.world.fog;
    if ((f && p.location.floor >= f.from && p.location.floor <= f.to) || this.isDark(p.location.floor)) return;
    t.drill = true;
    this.notify([p], {
      title: 'УЧЕБНАЯ ТРЕВОГА',
      text: 'Это проверка, тумана нет. Так звучит настоящая сирена: подойдите к гермодвери внизу комнаты и задрайте её.',
      style: 'siren',
    });
  }

  /** Квитанция ЖЭК «Пока вас не было»: что случилось, пока жилец был не в сети. */
  sendReceipt(p, now) {
    const a = p.absence || { knocks: [] };
    const lines = [`Вас не было: ${fmtDuration(now - p.leftAt)}.`];
    if (p.down) lines.push(`Вы лежите без сознания: ${this.placeTitle(p)}. Осталось ${Math.max(0, Math.ceil((p.down.until - now) / 1000))} с — кто-нибудь поможет?`);
    else if (this.isOwnHome(p)) lines.push('Вы проснулись у себя дома.');
    else if (p.location.place === 'home') lines.push(`Вы очнулись в гостях: ${this.placeTitle(p)}.`);
    else if (p.travel && p.travel.stuck) lines.push('Вы очнулись в застрявшем лифте.');
    else if (p.travel) lines.push(p.travel.via === 'stairs' ? 'Вы очнулись по дороге — на лестнице.' : 'Вы очнулись по дороге — в лифте.');
    else lines.push(`До дома вы так и не дошли: ${this.placeTitle(p)}.`);
    if (a.stats) {
      const parts = STAT_KEYS.map((k) => [STAT_NAMES[k], a.stats[k], Math.round(p.stats[k])]).filter(([, was, now2]) => was !== now2);
      if (parts.length) lines.push(parts.map(([n, was, now2]) => `${n}: ${was} → ${now2}`).join(' · '));
    }
    if (a.money != null && a.money !== p.money) lines.push(`Талоны: ${a.money} → ${p.money}.`);
    if (a.robbedBy && a.robbedBy.length) lines.push(`Пока вы лежали, в ваших карманах рылся: ${[...new Set(a.robbedBy)].join(', ')}.`);
    if (a.knocks && a.knocks.length) {
      const by = new Map();
      for (const k of a.knocks) by.set(`${k.name} (кв. ${k.apt})`, (by.get(`${k.name} (кв. ${k.apt})`) || 0) + 1);
      lines.push(`Стучали в дверь: ${[...by].map(([who, n]) => (n > 1 ? `${who} ×${n}` : who)).join(', ')}.`);
    }
    for (const extra of this.receiptExtras(p, a)) lines.push(extra);
    // Только то, что жильцы и так слышали: радиоточка и публичные записи о соседях.
    // Служебный журнал Пульта (цели событий, сроки поломок, причины смерти) игрокам не показываем.
    const since = p.leftAt;
    const events = this.state.log.filter((e) => e.ts >= since && e.kind === 'event' && e.public).slice(-8);
    if (events.length) lines.push('В доме:', ...events.map((e) => `— ${e.public}`));
    const neighbours = this.state.log.filter(
      (e) => e.ts >= since && e.public && (e.kind === 'death' || e.kind === 'join') && e.playerId !== p.id && e.floor === p.apartment.floor,
    );
    if (neighbours.length) lines.push('На вашем этаже:', ...neighbours.slice(-5).map((e) => `— ${e.public}`));
    this.notify([p], { title: 'Квитанция ЖЭК', text: lines.join('\n'), style: 'receipt', journal: false });
    this.journal(p, `Вы вернулись. Вас не было ${fmtDuration(now - p.leftAt)}.`);
  }

  /** Дополнительные строки квитанции: что подсунули под дверь. */
  receiptExtras(p) {
    const drops = this.state.doorDrops[p.apartment.number] || [];
    if (!drops.length) return [];
    if (this.isOwnHome(p)) return ['Под дверью:', ...this.collectDrops(p, { silent: true })];
    const notes = drops.filter((d) => d.kind === 'note').length;
    const parcels = drops.length - notes;
    const parts = [];
    if (notes) parts.push(`${notes} ${plural(notes, 'записка', 'записки', 'записок')}`);
    if (parcels) parts.push(`${parcels} ${plural(parcels, 'передачка', 'передачки', 'передачек')}`);
    return [`Под вашей дверью ждут: ${parts.join(' и ')}. Заберёте, когда вернётесь домой.`];
  }

  /**
   * Отсчёт для новых таймеров мира. На паузе — от момента паузы: при снятии паузы shiftTimers сдвинет
   * все таймеры на её длину, и созданный на паузе таймер не «съедет» на всю паузу вперёд.
   */
  timerNow() {
    const w = this.world;
    return w.paused && w.pausedAt ? w.pausedAt : this.now();
  }

  gameClock() {
    const m = Math.floor(this.world.gameMinutes);
    const day = Math.floor(m / 1440) + 1;
    const hh = String(Math.floor((m % 1440) / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return { day, time: `${hh}:${mm}`, hour: Math.floor((m % 1440) / 60), label: `День ${day}, ${hh}:${mm}` };
  }

  dirty(ids) {
    if (ids && ids.length) this.emit('dirty', ids);
  }

  /** Запись в журнал Пульта. extra.public — что можно показать жильцам (журнал Пульта им не показываем). */
  log(text, kind = 'info', playerId = null, extra = {}) {
    const who = playerId ? this.getPlayer(playerId) : null;
    const entry = { ts: this.now(), clock: this.gameClock().label, text, kind, playerId, floor: who ? who.apartment.floor : null, ...extra };
    this.state.log.push(entry);
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
    this.emit('log', entry);
  }

  journal(p, text, kind = 'info') {
    p.journal.push({ ts: this.now(), clock: this.gameClock().label, text, kind });
    if (p.journal.length > 40) p.journal.splice(0, p.journal.length - 40);
  }

  /** Уведомление (всплывашка) + запись в личный журнал. Важное уходит пушем тем, кто не в сети. */
  notify(players, { title, text, style = 'info', journal = true, action = null, ask = null, push = true }) {
    const list = players.filter(Boolean);
    for (const p of list) if (journal) this.journal(p, title ? `${title}. ${text}` : text, style);
    this.emit('notify', { to: list.map((p) => p.id), title, text, style, action, ask });
    if (push && PUSH_STYLES[style]) for (const p of list) this.pushOffline(p, { title: title || 'ЖЭК', body: ask ? ask.question : text, tag: style, urgent: PUSH_STYLES[style] === 'urgent' });
    this.dirty(list.map((p) => p.id));
  }

  // =========================================================================
  // Пуш-уведомления: телефон жильца, который сейчас не в игре
  // =========================================================================
  /** Подписка браузера (уже проверенная сервером): не больше трёх устройств на жильца. */
  pushSubscribe(p, sub) {
    if (!sub || !sub.endpoint) return { ok: false, error: 'Пустая подписка.' };
    // одно устройство — один жилец: если в браузере сменился жилец, старому пуши больше не идут
    for (const q of Object.values(this.state.players)) if (q.push && q.id !== p.id) q.push = q.push.filter((s) => s.endpoint !== sub.endpoint);
    p.push = [...(p.push || []).filter((s) => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: sub.keys, at: this.now() }].slice(-3);
    this.dirty([p.id]);
    return { ok: true, message: 'Телефон привязан: ЖЭК сообщит о важном, когда вас нет в игре.' };
  }

  pushUnsubscribe(p, endpoint) {
    const before = (p.push || []).length;
    p.push = (p.push || []).filter((s) => s.endpoint !== String(endpoint || ''));
    if (p.push.length !== before) this.dirty([p.id]);
    return { ok: true, message: 'Уведомления на это устройство отключены.' };
  }

  /** Подписка умерла (служба ответила 404/410) — забыть её у всех. */
  pushGone(endpoint) {
    for (const q of Object.values(this.state.players)) if (q.push && q.push.some((s) => s.endpoint === endpoint)) q.push = q.push.filter((s) => s.endpoint !== endpoint);
  }

  /**
   * Пуш жильцу, которого нет в игре. Лимиты: один пуш на тему за PUSH_TAG_GAP (срочные — чаще),
   * не больше PUSH_PER_HOUR в час. Сама отправка — в server/index.js (событие 'push').
   */
  pushOffline(p, { title, body, tag = 'zhek', urgent = false }) {
    if (!p || !p.push || !p.push.length || this.isOnline(p.id)) return false;
    const now = this.now();
    const lim = this.pushLimits.get(p.id) || { tags: {}, hour: [] };
    lim.hour = lim.hour.filter((t) => now - t < 3600000);
    const gap = urgent ? PUSH_URGENT_GAP_MS : PUSH_TAG_GAP_MS;
    if (now - (lim.tags[tag] || 0) < gap || lim.hour.length >= PUSH_PER_HOUR) return false;
    lim.tags[tag] = now;
    lim.hour.push(now);
    this.pushLimits.set(p.id, lim);
    this.emit('push', { to: p.id, title: String(title).slice(0, 80), body: String(body || '').slice(0, 240), tag, urgent: !!urgent });
    return true;
  }

  systemChat(text) {
    const msg = { id: newId('m'), ts: this.now(), channel: 'global', from: { name: 'Радиоточка', system: true }, text };
    this.pushGlobal(msg);
    this.emit('chat', msg);
  }

  pushGlobal(msg) {
    this.state.chatGlobal.push(msg);
    if (this.state.chatGlobal.length > 100) this.state.chatGlobal.splice(0, this.state.chatGlobal.length - 100);
  }

  // ---- инвентарь ----
  hasItem(p, id, n = 1) {
    return (p.inventory[id] || 0) >= n;
  }

  /**
   * charge — заряд противогаза/фонарика, который приходит вместе с вещью (новая — 100).
   * Если у жильца такой вещи ещё не было, его заряд становится зарядом полученной вещи.
   */
  addItem(p, id, n = 1, charge = 100) {
    if (!C.ITEMS[id] || n <= 0) return;
    const key = CHARGE_KEYS[id];
    const have = p.inventory[id] || 0;
    // заряд у жильца один на все штуки: при слиянии — средний, чтобы передачами его нельзя было размножить
    if (key) p[key] = have > 0 ? Math.round(((p[key] ?? 100) * have + charge * n) / (have + n)) : charge;
    p.inventory[id] = have + n;
  }

  /** Заряд вещи, которую жилец отдаёт (у противогаза и фонарика). */
  chargeOf(p, id) {
    const key = CHARGE_KEYS[id];
    return key ? p[key] ?? 100 : 100;
  }

  removeItem(p, id, n = 1) {
    const have = p.inventory[id] || 0;
    const removed = Math.min(have, n);
    if (have - removed <= 0) delete p.inventory[id];
    else p.inventory[id] = have - removed;
    return removed;
  }

  // ---- состояния ----
  hasCondition(p, id) {
    return p.conditions.some((c) => c.id === id);
  }

  hasBlock(p, what) {
    return p.conditions.some((c) => (C.CONDITIONS[c.id]?.blocks || []).includes(what));
  }

  addCondition(p, id, { silent = false } = {}) {
    const def = C.CONDITIONS[id];
    if (!def || !p.alive) return false;
    const now = this.timerNow();
    const until = def.durationMin ? now + def.durationMin * 60000 : null;
    const existing = p.conditions.find((c) => c.id === id);
    if (existing) {
      existing.until = until; // повторное заражение продлевает
    } else {
      p.conditions.push({ id, since: now, until });
    }
    if (id === 'insomnia') p.sleeping = false;
    if (!silent) this.journal(p, `Вам нехорошо: ${def.name}.`, 'danger');
    return true;
  }

  cureCondition(p, id) {
    const before = p.conditions.length;
    p.conditions = id === 'all' ? [] : p.conditions.filter((c) => c.id !== id);
    return before !== p.conditions.length;
  }

  applyStats(p, deltas) {
    for (const k of STAT_KEYS) if (deltas[k]) p.stats[k] = clamp(p.stats[k] + deltas[k]);
  }

  // ---- география ----
  /** Номер квартиры, в которой жилец сейчас находится (своя или чужая), или null. */
  currentApt(p) {
    return p.location.place === 'home' ? p.location.apt || p.apartment.number : null;
  }

  doorSealed(apt) {
    return !!(apt && this.state.doors[apt] && this.state.doors[apt].sealed);
  }

  setDoorSealed(apt, on) {
    if (on) this.state.doors[apt] = { sealed: true };
    else delete this.state.doors[apt];
  }

  /** Последний погибший жилец квартиры, пока на двери висит «†». */
  lastDeadIn(apt) {
    // квартира → последний погибший в ней (индекс сбрасывается вместе с кешем живых)
    if (!this._deadIn) {
      this._deadIn = new Map();
      for (const q of this.players()) {
        if (q.alive || !q.diedAt) continue;
        const cur = this._deadIn.get(q.apartment.number);
        if (!cur || q.diedAt > cur.diedAt) this._deadIn.set(q.apartment.number, q);
      }
    }
    const q = this._deadIn.get(apt);
    const best = q && !q.alive && this.now() - q.diedAt < B.tombstoneMin * 60000 ? q : null;
    if (this.checkCache) {
      let fresh = null;
      for (const x of this.players()) {
        if (x.alive || x.apartment.number !== apt || !x.diedAt || this.now() - x.diedAt >= B.tombstoneMin * 60000) continue;
        if (!fresh || x.diedAt > fresh.diedAt) fresh = x;
      }
      if (fresh !== best) throw new Error('индекс погибших устарел');
    }
    return best;
  }

  ownerOf(apt) {
    if (!this._owners) {
      // первый живой с этой квартирой — как раньше find по списку
      this._owners = new Map();
      for (const q of this.alivePlayers()) if (!this._owners.has(q.apartment.number)) this._owners.set(q.apartment.number, q);
    }
    if (this.checkCache && (this._owners.get(apt) || null) !== (this.alivePlayers().find((q) => q.apartment.number === apt) || null)) throw new Error('кеш хозяев квартир устарел');
    return this._owners.get(apt) || null;
  }

  locationKey(p) {
    const l = p.location;
    if (l.place === 'home') return `home:${this.currentApt(p)}`;
    if (l.place === 'corridor') return `corridor:${l.floor}`;
    return l.place;
  }

  placeTitle(p) {
    const l = p.location;
    if (l.place === 'home') return `Кв. ${this.currentApt(p)}`;
    if (l.place === 'corridor') return `Коридор ${l.floor} этажа`;
    return C.PLACES[l.place]?.name || l.place;
  }

  othersAt(p) {
    return this.playersAt(this.locationKey(p)).filter((q) => q.id !== p.id && this.isOnline(q.id));
  }

  sceneOf(p) {
    return this.map.scene(this.locationKey(p));
  }

  /** Перенести жильца в другое место (сцену) — он появится у нужного входа. */
  relocate(p, location, entry = 'default') {
    const prevApt = this.currentApt(p);
    p.location = { place: location.place, floor: location.floor };
    if (location.place === 'home') p.location.apt = location.apt || p.apartment.number;
    p.pos = { ...this.map.spawn(this.locationKey(p), entry), d: 'down' };
    p.posSeq = (p.posSeq || 0) + 1;
    p.posAt = this.now();
    p.moveBudget = 1;
    if (this.isOwnHome(p)) {
      p.homeward = null;
    } else if (p.homeward) {
      p.homeward.step = null;
      p.homeward.nextAt = null;
    } else if (p.alive && !this.isOnline(p.id) && !p.travel) {
      // отсутствующего перенесли не домой (например, Пульт) — тело побредёт домой
      p.homeward = { since: this.now(), nextAt: null, step: null };
    }
    // гость ушёл через дверь, которую сам открыл, а хозяин остался внутри — дверь задраивается за ним
    if (prevApt && prevApt !== p.apartment.number && this.currentApt(p) !== prevApt && this.unsealedBy.get(prevApt) === p.id) {
      this.unsealedBy.delete(prevApt);
      const inside = this.alivePlayers().some((q) => q !== p && this.currentApt(q) === prevApt);
      if (inside && !this.doorSealed(prevApt)) {
        this.setDoorSealed(prevApt, true);
        this.journal(p, `Вы вышли и задраили за собой гермодверь кв. ${prevApt}: хозяин остался внутри.`);
      }
    }
    // попал в квартиру (в свою или в гости) — значит, ему всё-таки открыли
    if (location.place === 'home') this.refusals.delete(p.id);
  }

  /** Объект сцены рядом с жильцом, подходящий под условие (или null). */
  nearTo(p, test) {
    return this.sceneOf(p).objects.find((o) => test(o) && World.nearObject(o, p.pos)) || null;
  }

  distance(a, b) {
    return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  }

  /**
   * Клиент сообщает, куда дошёл жилец. Сервер проверяет стены и скорость
   * («бюджет» шагов копится со временем, поэтому пачка сообщений не страшна).
   * Возвращает false, если шаг невозможен — тогда клиенту отправят поправку.
   */
  setPos(p, x, y, dir) {
    if (!p.alive || p.down) return false;
    x = Number(x);
    y = Number(y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const now = this.now();
    const dt = Math.min(2000, Math.max(0, now - (p.posAt || 0)));
    p.posAt = now;
    p.moveBudget = Math.min(2.5, (p.moveBudget || 0) + World.SPEED * 1.5 * (dt / 1000));
    const dist = Math.hypot(x - p.pos.x, y - p.pos.y);
    if (dist > p.moveBudget + 0.3 || !World.canStand(this.sceneOf(p), x, y)) return false;
    p.moveBudget = Math.max(0, p.moveBudget - dist);
    const from = { x: p.pos.x, y: p.pos.y };
    p.pos = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, d: ['up', 'down', 'left', 'right'].includes(dir) ? dir : p.pos.d };
    if (dist > 0.01) {
      p.movedAt = now;
      if (p.sleeping && dist > 0.1) p.sleeping = false;
      this.checkHazards(p, now, from);
    }
    return true;
  }

  /**
   * Наступил на опасность, которую поставил бог (если её не огородили). from — откуда шёл: проверяем
   * весь отрезок пути, иначе опасность можно «перепрыгнуть» одним длинным шагом.
   */
  checkHazards(p, now, from = null) {
    const list = this.world.hazards[this.locationKey(p)];
    if (!list || !list.length) return;
    const a = from || p.pos;
    const b = p.pos;
    const segDist = (hz) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const k = len2 ? Math.max(0, Math.min(1, ((hz.x - a.x) * dx + (hz.y - a.y) * dy) / len2)) : 0;
      return Math.hypot(a.x + dx * k - hz.x, a.y + dy * k - hz.y);
    };
    for (const hz of list) {
      if (hz.fenced || segDist(hz) > 0.45) continue;
      p.hazardHits = p.hazardHits || {};
      if (now - (p.hazardHits[hz.id] || 0) < 10000) continue;
      p.hazardHits[hz.id] = now;
      const def = C.HAZARDS[hz.kind];
      const acc = C.ACCIDENTS[def.accident];
      this.accidentScar(p, def.accident, hz);
      this.notify([p], { title: def.name, text: acc.text, style: 'danger' });
      this.applyEffect(p, { ...acc.effect, condition: acc.condition }, acc.name);
      this.log(`${p.name} наступил: ${def.name} (${this.placeTitle(p)})`, 'accident', p.id);
    }
  }

  /** Огородить опасность рядом — табличка «Осторожно» убережёт тех, кто придёт позже. */
  fenceHazard(p, hazardId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    const list = this.world.hazards[this.locationKey(p)] || [];
    const hz = list.find((x) => x.id === hazardId);
    if (!hz) return { ok: false, error: 'Здесь такого нет.' };
    if (hz.fenced) return { ok: false, error: 'Уже огорожено.' };
    if (Math.hypot(p.pos.x - hz.x, p.pos.y - hz.y) > 1.6) return { ok: false, error: 'Подойдите ближе.' };
    hz.fenced = true;
    hz.fencedBy = p.name;
    this.markDeed(p, 'care');
    this.journal(p, `Вы огородили: ${C.HAZARDS[hz.kind].name}. Теперь никто не наступит.`, 'good');
    this.log(`${p.name} огородил опасность: ${C.HAZARDS[hz.kind].name} (${this.placeTitle(p)})`, 'social', p.id);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
    return { ok: true, message: 'Огорожено. Табличка «Осторожно» висит.' };
  }

  /** Кого видно в сцене: живые жильцы (не в сети — «спят»). list — уже отобранные жильцы сцены. */
  sceneActors(key, list = null) {
    const now = this.now();
    return (list || this.playersAt(key))
      .map((p) => ({
        away: !this.isOnline(p.id),
        id: p.id,
        name: p.name,
        apt: p.apartment.number,
        x: p.pos.x,
        y: p.pos.y,
        d: p.pos.d,
        m: now - (p.movedAt || 0) < 300,
        sick: p.conditions.some((c) => C.CONDITIONS[c.id]?.kind === 'disease'),
        hurt: p.conditions.some((c) => C.CONDITIONS[c.id]?.kind === 'injury'),
        sleep: !!p.sleeping,
        down: !!p.down,
        newbie: this.isNewbie(p),
        mask: this.maskWorks(p) && this.inFog(p.location.floor),
      }))
      .concat(this.npcsAt(key));
  }

  /** Неигровые персонажи сцены (пока — барыга). */
  npcsAt(key) {
    const out = [];
    const b = this.world.baryga;
    if (b && key === `corridor:${b.floor}`) out.push({ id: 'npc:baryga', name: 'Барыга', npc: 'baryga', x: b.x, y: b.y, d: 'down', m: false, apt: '' });
    for (const pp of Object.values(this.world.puppets)) {
      if (pp.scene !== key) continue;
      out.push({ id: pp.id, name: pp.name, npc: 'puppet', preset: pp.preset, lookId: pp.lookId, x: pp.x, y: pp.y, d: pp.d || 'down', m: !!(pp.path && pp.path.length), apt: '' });
    }
    return out;
  }

  // =========================================================================
  // Марионетки ЖЭК: ходят, говорят, стучат — ими управляет бог
  // =========================================================================
  /** Шаг марионеток по пути (вызывается каждые 100 мс из сервера, чтобы ходили плавно). */
  stepPuppets(dtSec) {
    for (const pp of Object.values(this.world.puppets)) {
      if (!pp.path || !pp.path.length) continue;
      let left = World.SPEED * 0.8 * dtSec;
      while (left > 0 && pp.path.length) {
        const t = pp.path[0];
        const dx = t.x - pp.x, dy = t.y - pp.y;
        const d = Math.hypot(dx, dy);
        if (d <= left) {
          pp.x = t.x;
          pp.y = t.y;
          pp.path.shift();
          left -= d;
        } else {
          pp.x += (dx / d) * left;
          pp.y += (dy / d) * left;
          left = 0;
        }
        if (Math.abs(dx) > Math.abs(dy)) pp.d = dx > 0 ? 'right' : 'left';
        else if (dy) pp.d = dy > 0 ? 'down' : 'up';
      }
    }
  }

  requirePuppet(id) {
    const pp = this.world.puppets[id];
    if (!pp) throw new Error('Нет такой марионетки');
    return pp;
  }

  /** Темно ли там, где стоит жилец: нет света на этаже или в коридоре погасла половина ламп. */
  isDarkFor(p) {
    // свой торшер: дома светло, даже когда на этаже нет электричества
    if (p.location.place === 'home' && this.furnitureAt(this.currentApt(p)).torchere) return false;
    if (this.isDark(p.location.floor)) return true;
    if (p.location.place !== 'corridor') return false;
    const out = (this.world.lampsOut[p.location.floor] || []).length;
    return out > 0 && out >= Math.ceil(this.map.scene(`corridor:${p.location.floor}`).lamps.length / 2);
  }

  /** Вкрутить лампочку в погасший плафон коридора. */
  fixLamp(p, index) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (p.location.place !== 'corridor') return { ok: false, error: 'Плафоны — в коридоре.' };
    const floor = p.location.floor;
    const out = this.world.lampsOut[floor] || [];
    const i = toInt(index, -1);
    if (!out.includes(i)) return { ok: false, error: 'Эта лампа и так горит.' };
    const lamp = this.map.scene(`corridor:${floor}`).lamps[i];
    if (!lamp || Math.hypot(p.pos.x - lamp[0], p.pos.y - lamp[1]) > 1.8) return { ok: false, error: 'Подойдите под плафон.' };
    if (!this.hasItem(p, 'bulb')) return { ok: false, error: 'Нужна лампочка.' };
    this.removeItem(p, 'bulb', 1);
    this.world.lampsOut[floor] = out.filter((x) => x !== i);
    if (!this.world.lampsOut[floor].length) delete this.world.lampsOut[floor];
    this.journal(p, `Вы вкрутили лампочку в коридоре ${floor} этажа. Стало светлее.`, 'good');
    const others = this.othersAt(p);
    this.notify(others, { title: 'Светлее', text: `${p.name} вкрутил лампочку в погасший плафон.`, style: 'good', journal: false });
    this.log(`${p.name} вкрутил лампочку в коридоре ${floor} этажа`, 'social', p.id);
    this.markDeed(p, 'care');
    this.dirty([p.id, ...others.map((q) => q.id)]);
    return { ok: true, message: 'Стало светлее.' };
  }

  /** Микроклимат на этаже (последний наложенный) или null. */
  climateAt(floor) {
    const list = this.world.climate;
    for (let i = list.length - 1; i >= 0; i--) if (floor >= list[i].from && floor <= list[i].to) return list[i];
    return null;
  }

  isDark(floor) {
    const pw = this.world.power;
    return !!pw && floor >= pw.from && floor <= pw.to;
  }

  fogPhase() {
    const f = this.world.fog;
    if (!f) return null;
    return this.now() < f.warnUntil ? 'warning' : 'active';
  }

  inFog(floor) {
    const f = this.world.fog;
    return this.fogPhase() === 'active' && floor >= f.from && floor <= f.to;
  }

  facilityStatus(key) {
    const fac = C.FACILITIES[key];
    if (this.world.breakdowns[key]) {
      const b = this.world.breakdowns[key];
      return { open: false, reason: b.reason || C.BREAKDOWNS[key].brokenText };
    }
    if (this.isDark(fac.floor)) return { open: false, reason: 'На этаже нет света — закрыто.' };
    return { open: true, reason: null };
  }

  allocateApartment() {
    // занята — если там живёт живой или внутри кто-то пережидает туман
    const taken = new Set(this.alivePlayers().flatMap((p) => [p.apartment.number, this.currentApt(p)]).filter(Boolean));
    for (let floor = C.BUILDING.firstResidentialFloor; floor <= C.BUILDING.maxFloor; floor++) {
      for (let i = 1; i <= C.BUILDING.apartmentsPerFloor; i++) {
        const number = `${floor}${String(i).padStart(2, '0')}`;
        if (!taken.has(number)) return { floor, number };
      }
    }
    return null; // дом переполнен
  }

  /** Имя занято живым жильцом или зарезервировано за домом/ЖЭК? Сравниваем «скелеты» (см. nameSkeleton). */
  nameTaken(name, exceptId = null) {
    const sk = nameSkeleton(name);
    if (C.RESERVED_NAMES.some((r) => nameSkeleton(r) === sk)) return 'Это имя занято домом. Выберите другое.';
    if (this.alivePlayers().some((q) => q.id !== exceptId && nameSkeleton(q.name) === sk)) return 'Жилец с таким именем уже есть.';
    return null;
  }

  /** Свободное имя на основе base: «Вася (2)», «Вася (3)»… с учётом длины в 20 символов. */
  freeName(base, exceptId = null) {
    if (!this.nameTaken(base, exceptId)) return base;
    for (let i = 2; i < 1000; i++) {
      const suffix = ` (${i})`;
      const candidate = `${base.slice(0, 20 - suffix.length).trim()}${suffix}`;
      if (!this.nameTaken(candidate, exceptId)) return candidate;
    }
    return `${base.slice(0, 12)} ${crypto.randomBytes(3).toString('hex')}`;
  }

  // =========================================================================
  // Регистрация
  // =========================================================================
  /** Проверить имя нового жильца, ничего не создавая. */
  checkNewName(rawName) {
    const name = sanitizeName(rawName);
    if (!name) return { ok: false, error: 'Имя — от 2 до 20 букв или цифр.' };
    const taken = this.nameTaken(name);
    if (taken) return { ok: false, error: taken };
    return { ok: true, name };
  }

  /** Последний погибший жилец этого паспорта (предшественник для наследства). */
  lastDeadOf(account) {
    const key = this.accountKey(account.login);
    return this.players()
      .filter((q) => !q.alive && q.account === key)
      .sort((a, b) => (b.diedAt || 0) - (a.diedAt || 0))[0] || null;
  }

  /** Сколько секунд ещё ждать новой жизни после смерти предшественника (0 — можно). */
  rebirthWait(predecessor) {
    if (!predecessor || predecessor.alive || !predecessor.diedAt) return 0;
    return Math.max(0, Math.ceil((predecessor.diedAt + B.rebirthDelayMin * 60000 - this.now()) / 1000));
  }

  register(rawName, { account = null, predecessor = null } = {}) {
    const check = this.checkNewName(rawName);
    if (!check.ok) return check;
    const name = check.name;
    const heirOf = predecessor || (account ? this.lastDeadOf(account) : null);
    const wait = this.rebirthWait(heirOf);
    if (wait > 0) return { ok: false, error: `Дом ещё не принял вашу смерть. Новый ордер — через ${fmtDuration(wait * 1000)}.` };
    if (account && this.accountPlayer(account)) return { ok: false, error: 'У этого паспорта уже есть живой жилец.' };
    const apartment = this.allocateApartment();
    if (!apartment) return { ok: false, error: 'Дом переполнен: свободных квартир нет.' };
    const id = newId('p');
    const token = crypto.randomBytes(24).toString('hex');
    const now = this.now();
    const p = {
      id,
      token,
      name,
      createdAt: now,
      lastSeen: now,
      apartment,
      alive: true,
      deathCause: null,
      diedAt: null,
      stats: { health: B.start.health, hunger: B.start.hunger, energy: B.start.energy, sanity: B.start.sanity },
      money: B.start.money,
      inventory: {},
      gasmaskCharge: 100,
      location: { place: 'home', floor: apartment.floor, apt: apartment.number },
      pos: { ...this.map.spawn(`home:${apartment.number}`, 'default'), d: 'up' },
      posSeq: 1,
      travel: null,
      sleeping: false,
      conditions: [],
      job: null,
      shifts: 0,
      journal: [],
      lastHarm: null,
      deeds: { helped: 0 },
      tutorial: { done: [], rewarded: false, drill: false },
      settledDay: Math.floor(this.world.gameMinutes / 1440),
    };
    this.state.players[id] = p;
    this.invalidatePlayers();
    this.byToken.set(token, id);
    if (account) this.linkAccount(p, account);
    if (heirOf) this.inherit(p, heirOf);
    if (heirOf && heirOf.push && heirOf.push.length) {
      p.push = heirOf.push;
      heirOf.push = [];
    }
    this.journal(p, `Ордер на заселение получен. Ваша квартира — №${apartment.number}, ${apartment.floor} этаж. Голые стены, кровать и радиоточка.`);
    this.journal(p, `Еда стоит талонов. Талоны дают за смену в цеху (${C.FACILITIES.factory.floor} этаж). Столовая — на ${C.FACILITIES.canteen.floor} этаже.`);
    this.log(`Заселился новый жилец: ${name}, кв. ${apartment.number}`, 'join', id, { public: `заселился ${name} в кв. ${apartment.number}` });
    this.systemChat(`В квартиру ${apartment.number} заселился новый жилец — ${name}.`);
    return { ok: true, player: p, token };
  }

  // =========================================================================
  // Паспорта жильцов (аккаунты): логин и пароль, вход с любого устройства
  // =========================================================================
  static hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 32).toString('hex');
  }

  /** То же, но не держит сервер: scrypt считается в пуле потоков. */
  static hashPasswordAsync(password, salt) {
    return new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
  }

  accountKey(login) {
    return String(login || '').trim().toLocaleLowerCase('ru');
  }

  getAccount(login) {
    return this.state.accounts[this.accountKey(login)] || null;
  }

  createAccount(rawLogin, password) {
    const login = String(rawLogin || '').trim();
    if (!/^[\p{L}\p{N}_.\-]{3,20}$/u.test(login)) return { ok: false, error: 'Логин — от 3 до 20 букв, цифр, точек, дефисов или подчёркиваний.' };
    if (String(password || '').length < 6) return { ok: false, error: 'Пароль — не короче 6 символов.' };
    if (String(password).length > 200) return { ok: false, error: 'Слишком длинный пароль.' };
    const key = this.accountKey(login);
    if (this.state.accounts[key]) return { ok: false, error: 'Такой паспорт уже выдан. Войдите по нему или выберите другой логин.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const account = { login, salt, hash: Game.hashPassword(password, salt), createdAt: this.now(), playerIds: [], banned: null };
    this.state.accounts[key] = account;
    return { ok: true, account };
  }

  verifyLogin(rawLogin, password) {
    const account = this.getAccount(rawLogin);
    const fail = { ok: false, error: 'Неверный логин или пароль.' };
    if (!account || !password) return fail;
    const given = Buffer.from(Game.hashPassword(password, account.salt), 'hex');
    const expected = Buffer.from(account.hash, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return fail;
    return { ok: true, account };
  }

  /** Проверка пароля без блокировки цикла событий (для входа по сети). */
  async verifyLoginAsync(rawLogin, password) {
    const account = this.getAccount(rawLogin);
    const fail = { ok: false, error: 'Неверный логин или пароль.' };
    if (!password || String(password).length > 200) return fail;
    // нет такого паспорта — всё равно считаем хеш, чтобы по времени ответа нельзя было понять, есть ли логин
    const salt = account ? account.salt : '00000000000000000000000000000000';
    const given = Buffer.from(await Game.hashPasswordAsync(password, salt), 'hex');
    if (!account) return fail;
    const fresh = this.getAccount(rawLogin); // пока считали, паспорт могли удалить
    if (!fresh) return fail;
    const expected = Buffer.from(fresh.hash, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return fail;
    return { ok: true, account: fresh };
  }

  linkAccount(p, account) {
    p.account = this.accountKey(account.login);
    if (!account.playerIds.includes(p.id)) account.playerIds.push(p.id);
  }

  /** Живой жилец этого паспорта (или null). */
  accountPlayer(account) {
    const key = this.accountKey(account.login);
    return this.alivePlayers().find((q) => q.account === key) || null;
  }

  /** Привязать паспорт к жильцу, заселённому без него (старые сохранения). */
  claimAccount(p, login, password) {
    if (p.account) return { ok: false, error: 'У вас уже есть паспорт.' };
    const res = this.createAccount(login, password);
    if (!res.ok) return res;
    this.linkAccount(p, res.account);
    this.journal(p, `Паспорт жильца выдан: ${res.account.login}. Теперь можно входить с любого устройства.`, 'good');
    return { ok: true, message: 'Паспорт выдан.' };
  }

  /** Причина блокировки (или null): по паспорту, по самому жильцу или по адресу. */
  banInfo(p, ip) {
    const now = this.now();
    const active = (b) => b && (!b.until || b.until > now);
    const acc = p && p.account ? this.state.accounts[p.account] : null;
    if (acc && active(acc.banned)) return acc.banned;
    if (p && active(p.banned)) return p.banned;
    if (ip && active(this.state.bannedIps[ip])) return this.state.bannedIps[ip];
    return null;
  }

  accountBanInfo(account, ip) {
    const now = this.now();
    const active = (b) => b && (!b.until || b.until > now);
    if (account && active(account.banned)) return account.banned;
    if (ip && active(this.state.bannedIps[ip])) return this.state.bannedIps[ip];
    return null;
  }

  /** Ответ жильца на дилемму ЖЭК. */
  answer(p, askId, option) {
    const ask = (p.asks || []).find((a) => a.id === askId);
    if (!ask || (ask.until && ask.until <= this.now())) {
      p.asks = (p.asks || []).filter((a) => a !== ask);
      return { ok: false, gone: true, error: 'Вопрос уже снят.' };
    }
    const i = toInt(option, -1);
    if (i < 0 || i >= ask.options.length) return { ok: false, error: 'Нет такого ответа.' };
    p.asks = p.asks.filter((a) => a !== ask);
    this.journal(p, `Вы ответили ЖЭК: «${ask.options[i]}».`);
    this.log(`Дилемма «${ask.question}» — ${p.name} ответил: «${ask.options[i]}»`, 'answer', p.id);
    return { ok: true };
  }

  /** Жалоба на сообщение в чате — уходит в журнал Пульта. */
  report(p, msgId) {
    const now = this.now();
    if (now - (p.lastReportAt || 0) < 10000) return { ok: false, error: 'Не так часто.' };
    let msg = this.state.chatGlobal.find((m) => m.id === msgId);
    if (!msg) for (const list of this.localChat.values()) msg = msg || list.find((m) => m.id === msgId);
    if (!msg || !msg.from || !msg.from.id) return { ok: false, error: 'Сообщение не найдено.' };
    if (msg.from.id === p.id) return { ok: false, error: 'На себя не жалуются.' };
    msg.reportedBy = msg.reportedBy || [];
    if (msg.reportedBy.includes(p.id)) return { ok: false, error: 'Вы уже жаловались на это сообщение.' };
    msg.reportedBy.push(p.id);
    p.lastReportAt = now;
    this.log(`Жалоба от ${p.name} на ${msg.from.name} (${msg.channel === 'global' ? 'весь дом' : msg.where || 'рядом'}): «${msg.text}»`, 'report', msg.from.id);
    return { ok: true, message: 'Жалоба передана в ЖЭК.' };
  }

  mutedFor(p) {
    return p.mutedUntil && p.mutedUntil > this.now() ? Math.ceil((p.mutedUntil - this.now()) / 60000) : 0;
  }

  // =========================================================================
  // Тик мира
  // =========================================================================
  tick() {
    this.invalidatePlayers(); // страховка: если где-то забыли сбросить кеш, он живёт не дольше секунды
    const w = this.world;
    if (w.paused) return;
    const now = this.now();
    w.tick++;
    w.gameMinutes += B.tickMs / 1000; // 1 реальная секунда = 1 игровая минута
    this.updateWorldTimers(now);

    const dt = B.tickMs / 60000; // доля минуты
    const alive = this.alivePlayers();
    const groups = new Map();
    for (const p of alive) {
      const key = this.locationKey(p);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const p of alive) this.tickPlayer(p, now, dt, groups);
    // режиссёр: где жильцы собрались вместе и как давно
    for (const [key, list] of groups) {
      const n = list.filter((p) => this.isOnline(p.id)).length;
      if (n >= 3) {
        if (!this.groupSince.has(key)) this.groupSince.set(key, now);
      } else this.groupSince.delete(key);
    }
    for (const key of [...this.groupSince.keys()]) if (!groups.has(key)) this.groupSince.delete(key);
  }

  /** Всё, что нужно Глазку ЖЭК, чтобы нарисовать сцену так, как её видят жильцы. */
  sceneSnapshot(key) {
    let scene;
    try {
      scene = this.map.scene(key);
    } catch {
      return null;
    }
    const floor = scene.floor;
    const fog = this.world.fog && this.fogPhase() === 'active' && floor != null && floor >= this.world.fog.from && floor <= this.world.fog.to;
    const apt = key.startsWith('home:') ? key.slice(5) : null;
    const residents = {};
    if (scene.kind === 'corridor') {
      for (const o of scene.objects.filter((x) => x.type === 'apt')) {
        const r = this.ownerOf(o.number);
        if (r) residents[o.number] = { number: o.number, name: r.name, online: this.isOnline(r.id) };
        else {
          const dead = this.lastDeadIn(o.number);
          if (dead) residents[o.number] = { number: o.number, name: `† ${dead.name}`, dead: true };
        }
      }
    }
    return {
      key,
      title: this.sceneTitle(key),
      actors: this.sceneActors(key),
      hazards: (this.world.hazards[key] || []).map((hz) => ({ id: hz.id, kind: hz.kind, x: hz.x, y: hz.y, fenced: !!hz.fenced })),
      scars: this.scarsView(key),
      climate: floor != null && this.climateAt(floor) ? this.climateAt(floor).kind : null,
      lampsOut: scene.kind === 'corridor' ? this.world.lampsOut[floor] || [] : [],
      dark: floor != null && this.isDark(floor),
      fog: fog ? (apt ? (this.doorSealed(apt) ? 'window' : 'leak') : 'outside') : null,
      sealed: apt ? this.doorSealed(apt) : false,
      liftBroken: !!this.world.breakdowns.lift,
      residents,
      gameMinutes: Math.floor(this.world.gameMinutes) % 1440,
    };
  }

  /** Название сцены по ключу (для подсказок режиссёра). */
  sceneTitle(key) {
    const [kind, arg] = String(key).split(':');
    if (kind === 'corridor') return `Коридор ${arg} этажа`;
    if (kind === 'home') return `Кв. ${arg}`;
    return C.PLACES[kind]?.name || kind;
  }

  /**
   * Режиссёр-подсказчик для Пульта: что сейчас интересного в доме и шкала напряжения.
   * Сам ничего не делает — только подсказывает богу.
   */
  director() {
    const now = this.now();
    const alive = this.alivePlayers();
    const online = alive.filter((p) => this.isOnline(p.id));
    const hints = [];
    for (const [key, since] of this.groupSince) {
      const min = Math.floor((now - since) / 60000);
      if (min < 5) continue;
      const n = online.filter((p) => this.locationKey(p) === key).length;
      hints.push({ id: `group:${key}`, level: 'info', text: `${this.sceneTitle(key)}: ${n} жильцов вместе уже ${min} мин.`, scene: key });
    }
    for (const p of alive) {
      if (p.down) {
        hints.push({ id: `down:${p.id}`, level: 'danger', text: `${p.name} без сознания — ${Math.max(0, Math.ceil((p.down.until - now) / 1000))} с. Поможет ли кто-нибудь?`, playerId: p.id });
        continue;
      }
      const harms = (p.harmLog || []).filter((t) => now - t < 3600 * 1000).length;
      if (harms >= 3) hints.push({ id: `harm:${p.id}`, level: 'warn', text: `${p.name}: бед от ЖЭК за час — ${harms}. Не слишком ли часто одному?`, playerId: p.id });
      if (this.isOnline(p.id) && p.stats.health < 25 && !this.othersAt(p).length) {
        hints.push({ id: `low:${p.id}`, level: 'warn', text: `У ${p.name} ${Math.round(p.stats.health)} здоровья, рядом никого.`, playerId: p.id });
      }
      if (this.isOnline(p.id) && p.tutorial && !p.tutorial.rewarded && now - p.createdAt > 10 * 60000 && p.tutorial.done.length < 3) {
        hints.push({ id: `newbie:${p.id}`, level: 'info', text: `Новосёл ${p.name} уже ${Math.floor((now - p.createdAt) / 60000)} мин не может освоиться (шагов памятки: ${p.tutorial.done.length}).`, playerId: p.id });
      }
    }
    const empty = [];
    for (const [shop, items] of Object.entries(this.state.stock || {})) {
      for (const [key, n] of Object.entries(items)) if (n <= 0) empty.push(C.ITEMS[key]?.name || this.shopEntries(shop).find((e) => e.key === key)?.name || key);
    }
    for (const pet of this.state.petitions.filter((x) => x.status === 'sent')) {
      hints.push({ id: `petition:${pet.id}`, level: 'warn', text: `Коллективное заявление с ${pet.floor} этажа (${pet.signers.length} подп.): «${pet.text.slice(0, 80)}». Ждут ответа ЖЭК.` });
    }
    if (empty.length) hints.push({ id: `stock:${empty.join(',')}`, level: 'info', text: `Кончилось: ${empty.join(', ')}. Завоз в 0${B.supplyHour}:00.` });
    const events = this.state.log.filter((e) => ['event', 'accident', 'death', 'disease'].includes(e.kind));
    const last = events[events.length - 1];
    if (online.length && (!last || now - last.ts > 15 * 60000)) {
      hints.push({ id: 'quiet', level: 'info', text: `В доме тихо${last ? `: последнее событие ${Math.floor((now - last.ts) / 60000)} мин назад` : ''}. Жильцов в сети: ${online.length}.` });
    }
    const recent = events.filter((e) => now - e.ts < 15 * 60000).length;
    const deaths = this.state.log.filter((e) => e.kind === 'death' && now - e.ts < 30 * 60000).length;
    const downs = alive.filter((p) => p.down).length;
    const tension = Math.max(0, Math.min(100, recent * 12 + deaths * 20 + downs * 15 + (this.world.fog ? 30 : 0) + (this.world.power ? 10 : 0)));
    return { tension, hints };
  }

  updateWorldTimers(now) {
    const w = this.world;
    this.runSchedule(now);
    this.supplyCheck();
    for (const key of Object.keys(w.breakdowns)) {
      const b = w.breakdowns[key];
      if (b && b.until && now >= b.until) this.setBreakdown(key, false, {});
    }
    if (w.power && w.power.until && now >= w.power.until) this.restorePower();
    if (w.fog) {
      if (!w.fog.arrived && now >= w.fog.warnUntil) this.fogArrive();
      if (w.fog && now >= w.fog.until) this.endFog();
    }
    for (const t of Object.values(this.state.trades)) {
      if (now - t.createdAt > 3 * 60000) delete this.state.trades[t.id];
    }
    if (this.world.tick % 60 === 0) {
      this.archiveDead(now);
      this.expireBoardNotes(now);
      this.evictOrphanGuests();
    }
    for (const [key, list] of Object.entries(this.world.hazards)) {
      const left = list.filter((hz) => !hz.until || hz.until > now);
      if (left.length) this.world.hazards[key] = left;
      else delete this.world.hazards[key];
    }
    if (this.world.tick % 30 === 0) {
      const ttl = B.scarHours * 3600 * 1000;
      for (const [key, list] of Object.entries(this.world.scars)) {
        const left = list.filter((sc) => now - sc.at < ttl);
        if (left.length) this.world.scars[key] = left;
        else delete this.world.scars[key];
      }
    }
    this.radioTick(now);
    this.dayCheck(now);
    if (this.state.assignments.length) this.closeAssignments(now);
    if (this.world.tick % 30 === 0 && this.state.petitions.length) this.expirePetitions(now);
    if (this.world.climate.length) this.world.climate = this.world.climate.filter((c) => !c.until || c.until > now);
    this.elderWarnings(now);
    if (this.state.scenarioRuns.length) this.runScenarios(now);
  }

  // =========================================================================
  // Шрамы дома: следы событий на полу, выцветают за B.scarHours
  // =========================================================================
  scar(key, kind, x, y, extra = {}) {
    if (!key || x == null || y == null) return null;
    const list = this.world.scars[key] || [];
    // одно пятно на одном месте не плодим (кроме записей погибших)
    if (kind !== 'lastword' && list.some((sc) => sc.kind === kind && Math.hypot(sc.x - x, sc.y - y) < 0.6)) return null;
    const sc = { id: newId('s'), kind, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, at: this.now(), ...extra };
    list.push(sc);
    this.world.scars[key] = list.slice(-40);
    return sc;
  }

  /** Место для листка рядом с телом: не на подходах к дверям и предметам и не на другом листке. */
  freeScarSpot(key, pos) {
    const sc = this.map.scene(key);
    const taken = (this.world.scars[key] || []).filter((x) => x.kind === 'lastword');
    const cand = [[0.7, 0.3], [-0.7, 0.3], [0.7, -0.3], [-0.7, -0.3], [0, 0.8], [1.2, 0], [-1.2, 0]].map(([dx, dy]) => ({ x: pos.x + dx, y: pos.y + dy }));
    const ok = (c) =>
      World.canStand(sc, c.x, c.y, 0.1) &&
      !sc.objects.some((o) => o.spot && Math.hypot(o.spot.x - c.x, o.spot.y - c.y) < 1.2) &&
      !taken.some((x) => Math.hypot(x.x - c.x, x.y - c.y) < 0.6);
    return cand.find(ok) || cand[0];
  }

  /** Следы сцены для отрисовки: fade — насколько выцвел (0 — свежий, 1 — почти исчез). */
  scarsView(key) {
    const ttl = B.scarHours * 3600 * 1000;
    const now = this.now();
    // fade округляем: иначе Глазок слал бы кадр каждые 100 мс без видимых изменений
    return (this.world.scars[key] || []).map((sc) => ({ id: sc.id, kind: sc.kind, x: sc.x, y: sc.y, fade: Math.round(Math.min(1, Math.max(0, (now - sc.at) / ttl)) * 50) / 50, ...(sc.text ? { text: sc.text, by: sc.by } : {}) }));
  }

  /** След от несчастного случая там, где стоит жилец. */
  accidentScar(p, accidentId, at = null) {
    const acc = C.ACCIDENTS[accidentId];
    if (!acc || !acc.scar || p.travel) return;
    const pos = at || p.pos;
    if (pos) this.scar(this.locationKey(p), acc.scar, pos.x, pos.y);
  }

  /** После тумана на этажах остаётся серый налёт. */
  fogScars(f) {
    const last = Math.min(f.to, f.from + 40);
    for (let floor = f.from; floor <= last; floor++) {
      if (this.map.floorKind(floor) !== 'residential') continue;
      const key = `corridor:${floor}`;
      let sc;
      try {
        sc = this.map.scene(key);
      } catch {
        continue;
      }
      for (let i = 0; i < 3; i++) {
        const x = 1 + Math.floor(this.random() * (sc.w - 2)) + 0.5;
        const y = 1 + Math.floor(this.random() * (sc.h - 2)) + 0.5;
        if (!World.isSolidTile(sc, Math.floor(x), Math.floor(y))) this.scar(key, 'film', x, y);
      }
    }
  }

  // =========================================================================
  // Домовая книга: молва
  // =========================================================================
  /** Запомнить поступок: из них складывается молва (выцветает за B.rumorHours). */
  /** Поступок в молву. to — кому (подарок, помощь): одному и тому же засчитывается раз за rumorHours. */
  markDeed(p, kind, to = null) {
    if (!p || !C.DEEDS[kind]) return;
    const now = this.now();
    const ttl0 = B.rumorHours * 3600 * 1000;
    if (to && (p.deedLog || []).some((d) => d.k === kind && d.to === to && now - d.ts < ttl0)) return; // взаимные подарки по сухарю молву не накручивают
    p.deeds = p.deeds || { helped: 0 };
    if (C.DEEDS[kind].good) p.deeds.helped++;
    p.deedTotals = p.deedTotals || {};
    p.deedTotals[kind] = (p.deedTotals[kind] || 0) + 1;
    const ttl = B.rumorHours * 3600 * 1000;
    p.deedLog = [...(p.deedLog || []).filter((d) => now - d.ts < ttl), to ? { k: kind, ts: now, to } : { k: kind, ts: now }].slice(-80);
  }

  /** Вес поступков за последние сутки (свежие — тяжелее). */
  deedWeights(p) {
    const now = this.now();
    const ttl = B.rumorHours * 3600 * 1000;
    const w = {};
    for (const d of p.deedLog || []) {
      const k = 1 - (now - d.ts) / ttl;
      if (k > 0) w[d.k] = (w[d.k] || 0) + k;
    }
    return w;
  }

  /** Что говорят о жильце соседи: 1–2 самые заметные черты. */
  rumor(p) {
    return Object.entries(this.deedWeights(p))
      .filter(([, v]) => v >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => C.DEEDS[k].trait);
  }

  /** Насколько жилец хорош для соседей за сутки (для целей «самые щедрые» / «самые скупые»). */
  goodness(p) {
    const w = this.deedWeights(p);
    return Object.entries(w).reduce((sum, [k, v]) => sum + (C.DEEDS[k].good ? v : -v), 0);
  }

  // =========================================================================
  // Разнарядка ЖЭК на этаж
  // =========================================================================
  /** Разнарядки, которые касаются квартиры жильца (по этажу квартиры, а не по тому, где он стоит). */
  assignmentsFor(floor) {
    return this.state.assignments.filter((a) => !a.closed && floor >= a.from && floor <= a.to);
  }

  assignmentView(a, p) {
    const floorApts = this.assignmentResidents(a).map((q) => q.apartment.number);
    const what = a.kind === 'money' ? talons(a.amount) : a.kind === 'shifts' ? `${a.amount} ${plural(a.amount, 'смена', 'смены', 'смен')} в цеху` : `${C.ITEMS[a.item]?.name || a.item} ×${a.amount}`;
    const mine = p ? a.done[p.apartment.number] : null;
    return {
      id: a.id,
      text: a.text,
      what,
      kind: a.kind,
      floors: a.from === a.to ? `${a.from}` : `${a.from}–${a.to}`,
      leftMin: Math.max(0, Math.ceil((a.until - this.now()) / 60000)),
      done: Object.keys(a.done).sort(),
      total: floorApts.length,
      mine: !!mine,
      mineApplies: p ? p.apartment.floor >= a.from && p.apartment.floor <= a.to : false,
      progress: p && a.kind === 'shifts' ? (a.progress || {})[p.apartment.number] || 0 : null,
    };
  }

  /** Кого касается разнарядка: живущие на её этажах, кто сдал или бывал в игре за сутки. */
  assignmentResidents(a) {
    const all = this.alivePlayers().filter((q) => q.apartment.floor >= a.from && q.apartment.floor <= a.to);
    const active = new Set(this.activeResidents(24 * 3600 * 1000, all).map((q) => q.id));
    return all.filter((q) => active.has(q.id) || a.done[q.apartment.number]);
  }

  /** Сдать по разнарядке: у доски, за свою квартиру. Смены засчитываются сами. */
  submitAssignment(p, id) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.nearTo(p, (o) => o.type === 'board')) return { ok: false, error: 'Сдают у доски объявлений.' };
    const a = this.state.assignments.find((x) => x.id === id && !x.closed);
    if (!a) return { ok: false, error: 'Такой разнарядки нет.' };
    const apt = p.apartment.number;
    if (p.apartment.floor < a.from || p.apartment.floor > a.to) return { ok: false, error: 'Эта разнарядка не на ваш этаж.' };
    if (a.done[apt]) return { ok: false, error: 'Ваша квартира уже сдала.' };
    if (a.kind === 'shifts') return { ok: false, error: 'Смены засчитываются сами — идите в цех.' };
    if (a.kind === 'money') {
      if (p.money < a.amount) return { ok: false, error: `Нужно ${talons(a.amount)}.` };
      p.money -= a.amount;
    } else {
      if ((p.inventory[a.item] || 0) < a.amount) return { ok: false, error: `Нужно: ${C.ITEMS[a.item]?.name} ×${a.amount}.` };
      this.removeItem(p, a.item, a.amount);
    }
    this.completeAssignment(a, p);
    return { ok: true, message: 'Сдано. Квартира отмечена в списке.' };
  }

  completeAssignment(a, p) {
    a.done[p.apartment.number] = this.now();
    this.markDeed(p, 'assignment');
    this.journal(p, `Разнарядка «${a.text}»: ваша квартира сдала.`, 'good');
    this.log(`Разнарядка «${a.text}»: сдала кв. ${p.apartment.number} (${p.name})`, 'social', p.id);
    this.dirty([p.id]);
  }

  /** Отработанная смена засчитывается в разнарядки «смены в цеху». */
  assignmentShift(p) {
    for (const a of this.assignmentsFor(p.apartment.floor)) {
      if (a.kind !== 'shifts' || a.done[p.apartment.number]) continue;
      a.progress = a.progress || {};
      a.progress[p.apartment.number] = (a.progress[p.apartment.number] || 0) + 1;
      if (a.progress[p.apartment.number] >= a.amount) this.completeAssignment(a, p);
    }
  }

  /** Срок вышел: итог на доску и в Пульт. Мир сам никого не наказывает — решает ЖЭК. */
  closeAssignments(now) {
    for (const a of this.state.assignments) {
      if (a.closed || now < a.until) continue;
      a.closed = true;
      a.closedAt = now;
      const residents = this.assignmentResidents(a);
      a.failed = residents.filter((q) => !a.done[q.apartment.number]).map((q) => q.apartment.number);
      const done = Object.keys(a.done).length;
      this.log(`Разнарядка «${a.text}» закрыта: сдали ${done} из ${done + a.failed.length}${a.failed.length ? `; не сдали: ${a.failed.join(', ')}` : ''}`, 'event', null, { public: `разнарядка «${a.text}»: сдали ${done} из ${done + a.failed.length} квартир` });
      this.notify(residents, { title: 'Разнарядка закрыта', text: `«${a.text}»: сдали ${done} из ${done + a.failed.length} квартир. Решение — за ЖЭК.`, style: 'announce' });
    }
    // закрытые больше суток назад — в архив (нужны только для целей «сдавшие/не сдавшие»)
    this.state.assignments = this.state.assignments.filter((a) => !a.closed || now - a.closedAt < 24 * 3600 * 1000).slice(-30);
  }

  // =========================================================================
  // Полночь: порча еды и квартплата
  // =========================================================================
  dayCheck(now) {
    const day = Math.floor(this.world.gameMinutes / 1440);
    if (this.world.lastDay == null) this.world.lastDay = day;
    if (day <= this.world.lastDay) return;
    this.world.lastDay = day;
    this.spoilFood(day);
    this.chargeRent(now);
    this.planCheck();
  }

  // =========================================================================
  // План дома и Доска почёта
  // =========================================================================
  planWeek() {
    return Math.floor((this.gameDay() - 1) / 7);
  }

  /** Неделя кончилась — подвести итог и выдать новый план. */
  planCheck() {
    const w = this.world;
    const week = this.planWeek();
    if (w.plan && w.plan.week === week) return;
    if (w.plan) this.closePlan(w.plan);
    // план — по тем, кто бывал в доме за игровую неделю, а не по всем, кто когда-то заселился
    w.plan = { week, target: Math.max(20, this.activeResidents(7 * 24 * 60000).length * B.planShiftsPerResident), done: 0, participants: {} };
  }

  planShift(p) {
    this.planCheck();
    const plan = this.world.plan;
    plan.done++;
    plan.participants[p.id] = (plan.participants[p.id] || 0) + 1;
  }

  closePlan(plan) {
    const alive = this.alivePlayers();
    const workers = alive
      .filter((q) => plan.participants[q.id])
      .sort((a, b) => plan.participants[b.id] - plan.participants[a.id])
      .slice(0, 3)
      .map((q) => ({ name: q.name, apt: q.apartment.number, shifts: plan.participants[q.id] }));
    const generous = alive
      .filter((q) => this.goodness(q) > 0)
      .sort((a, b) => this.goodness(b) - this.goodness(a))
      .slice(0, 3)
      .map((q) => ({ name: q.name, apt: q.apartment.number }));
    this.world.honor = { week: plan.week + 1, workers, generous, done: plan.done, target: plan.target };
    if (plan.done >= plan.target) {
      const winners = alive.filter((q) => plan.participants[q.id]);
      for (const q of winners) {
        q.money += B.planBonus;
        this.journal(q, `План дома за неделю выполнен (${plan.done} из ${plan.target}). Премия участникам: ${talons(B.planBonus)}.`, 'good');
      }
      this.systemChat(`План дома выполнен: ${plan.done} смен из ${plan.target}. Участникам — премия. Ударники: ${workers.map((x) => x.name).join(', ') || '—'}.`);
      this.log(`План недели выполнен (${plan.done}/${plan.target}), премия ${winners.length} жильцам`, 'event', null, { public: `план дома выполнен: ${plan.done} смен из ${plan.target}` });
    } else {
      this.systemChat(`План дома сорван: ${plan.done} смен из ${plan.target}. Премии не будет.`);
      this.log(`План недели сорван (${plan.done}/${plan.target})`, 'event', null, { public: `план дома сорван: ${plan.done} смен из ${plan.target}` });
    }
  }

  /** Доска нарядов в цеху: план недели и доска почёта. */
  readPlan(p) {
    if (!this.nearTo(p, (o) => o.type === 'jobboard')) return { ok: false, error: 'Подойдите к доске нарядов.' };
    this.planCheck();
    const plan = this.world.plan;
    const daysLeft = 7 - ((this.gameDay() - 1) % 7);
    const top = Object.entries(plan.participants)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, n]) => ({ name: (this.getPlayer(id) || {}).name || '—', shifts: n }));
    return { ok: true, plan: { week: plan.week + 1, target: plan.target, done: plan.done, mine: plan.participants[p.id] || 0, daysLeft, bonus: B.planBonus, top }, honor: this.world.honor };
  }

  // =========================================================================
  // Подработка за паёк
  // =========================================================================
  /** Окно подработки в этом месте сейчас: открыто ли, в какие часы, работали ли уже в это окно. */
  sideJobHere(p) {
    for (const [kind, def] of Object.entries(C.SIDE_JOBS)) {
      if (def.place !== p.location.place) continue;
      const hour = this.gameClock().hour;
      const idx = def.hours.findIndex(([a, b]) => hour >= a && hour < b);
      const key = `${this.gameDay()}:${idx}`;
      return {
        kind,
        name: def.name,
        open: idx >= 0,
        hours: def.hours.map(([a, b]) => `${String(a).padStart(2, '0')}:00–${String(b).padStart(2, '0')}:00`).join(', '),
        done: idx >= 0 && (p.sideDone || {})[kind] === key,
        key,
      };
    }
    return null;
  }

  sideJobStart(p, kind) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (this.world.paused) return { ok: false, error: 'Время в доме остановилось.' };
    const def = C.SIDE_JOBS[kind];
    const here = this.sideJobHere(p);
    if (!def || !here || here.kind !== kind) return { ok: false, error: 'Здесь такой подработки нет.' };
    if (!here.open) return { ok: false, error: `Подработка — в часы: ${here.hours}.` };
    if (here.done) return { ok: false, error: 'В эти часы вы уже подрабатывали.' };
    const status = this.facilityStatus(def.place);
    if (!status.open) return { ok: false, error: status.reason };
    if (!this.nearTo(p, (o) => o.type === def.object)) return { ok: false, error: 'Подойдите поближе.' };
    if (p.job) return { ok: false, error: 'Вы уже на смене.' };
    if (this.hasBlock(p, 'work')) return { ok: false, error: 'С такой травмой не допустят.' };
    const cost = Math.ceil(B.workEnergyCost / 2);
    if (p.stats.energy < cost) return { ok: false, error: 'Нет сил. Поспите.' };
    const job = MG.createJob(kind);
    job.id = newId('j');
    job.startedAt = this.now();
    job.side = here.key;
    job.cost = { energy: cost, hunger: 0 };
    p.job = job;
    p.sleeping = false;
    p.sideDone = { ...(p.sideDone || {}), [kind]: here.key };
    this.applyStats(p, { energy: -cost });
    return { ok: true, job: { id: job.id, game: job.game, data: job.publicData } };
  }

  /** Конец подработки: оплата натурой. Больной на раздаче заражает тех, кто обедает рядом. */
  sideJobFinish(p, job, score) {
    const def = C.SIDE_JOBS[job.game];
    let pay = null;
    for (const [need, items] of def.pay) if (score >= need) pay = items;
    if (pay) for (const [id, n] of Object.entries(pay)) this.addItem(p, id, n);
    const what = pay ? Object.entries(pay).map(([id, n]) => `${C.ITEMS[id].name}${n > 1 ? ` ×${n}` : ''}`).join(', ') : null;
    if (job.game === 'serve') {
      for (const c of p.conditions) {
        const cond = C.CONDITIONS[c.id];
        if (!cond || !cond.contagious) continue;
        for (const q of this.othersAt(p)) if (this.random() < Math.min(0.9, cond.contagious * 3)) this.addCondition(q, c.id);
      }
    }
    const pct = Math.round(score * 100);
    const text = pay ? `${def.name}: качество ${pct}%. Расчёт натурой: ${what}.` : `${def.name}: качество ${pct}%. Заведующая ничего не дала.`;
    this.journal(p, text, pay ? 'good' : 'warn');
    this.log(`${p.name}: подработка «${def.name}» ${pct}%${what ? ` → ${what}` : ''}`, 'trade', p.id);
    return { ok: true, result: { score, reward: 0, text } };
  }

  // =========================================================================
  // Барыга на техническом этаже (ставит и убирает ЖЭК)
  // =========================================================================
  barygaPrice(itemId) {
    const def = C.ITEMS[itemId];
    if (!def) return null;
    let price = def.paper ? 1 : C.BARYGA_PRICES[itemId];
    if (!price) return null;
    if (this.world.fog) price *= 1.5; // в туман всё дороже
    if (this.world.cutleryStolen && (itemId === 'fork' || itemId === 'spoon')) price *= 2;
    return Math.ceil(price);
  }

  barygaNear(p) {
    const b = this.world.baryga;
    return !!(b && p.location.place === 'corridor' && p.location.floor === b.floor && Math.hypot(p.pos.x - b.x, p.pos.y - b.y) <= 2.2);
  }

  barygaPurse() {
    const b = this.world.baryga;
    if (b.purseDay !== this.gameDay()) {
      b.purseDay = this.gameDay();
      b.purse = B.barygaPurse;
    }
    return b.purse;
  }

  barygaOffer(p) {
    if (!this.barygaNear(p)) return { ok: false, error: 'Тут никого нет.' };
    const items = Object.entries(p.inventory)
      .map(([id, n]) => ({ id, name: C.ITEMS[id]?.name || id, have: n, price: this.barygaPrice(id) }))
      .filter((x) => x.price);
    const b = this.world.baryga;
    const sells = Object.entries(C.BARYGA_SELLS).map(([id, price]) => ({ id, name: C.ITEMS[id].name, desc: C.ITEMS[id].desc, price, left: !(b.soldDay && b.soldDay[id] === this.gameDay()) }));
    return { ok: true, purse: this.barygaPurse(), items, sells, wants: Object.keys(C.BARYGA_PRICES).map((id) => `${C.ITEMS[id].name} — ${this.barygaPrice(id)} ₸`).concat(['бумаги — 1 ₸']) };
  }

  barygaSell(p, itemId, count = 1) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.barygaNear(p)) return { ok: false, error: 'Тут никого нет.' };
    const price = this.barygaPrice(itemId);
    if (!price) return { ok: false, error: '«Это не возьму».' };
    const n = Math.max(1, Math.min(10, toInt(count, 1)));
    if ((p.inventory[itemId] || 0) < n) return { ok: false, error: 'У вас столько нет.' };
    const total = price * n;
    if (this.barygaPurse() < total) return { ok: false, error: '«Денег нет. Приходи завтра».' };
    this.removeItem(p, itemId, n);
    p.money += total;
    this.world.baryga.purse -= total;
    this.world.barygaClients[p.id] = this.now();
    this.log(`${p.name} продал барыге: ${C.ITEMS[itemId].name} ×${n} за ${talons(total)}`, 'trade', p.id);
    return { ok: true, message: `Барыга отсчитал ${talons(total)}. «Никому не говори».` };
  }

  /** Свободная клетка поближе к середине коридора — там стоит барыга. */
  barygaSpot(floor) {
    const sc = this.map.scene(`corridor:${floor}`);
    const cx = Math.floor(sc.w / 2);
    for (let r = 0; r < sc.w; r++) {
      for (const x of [cx + r, cx - r]) {
        for (let y = sc.h - 2; y >= 1; y--) {
          if (!World.isSolidTile(sc, x, y) && !sc.objects.some((o) => o.spot && Math.hypot(o.spot.x - (x + 0.5), o.spot.y - (y + 0.5)) < 1)) return { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
    return { x: 2.5, y: sc.h - 2.5 };
  }

  // =========================================================================
  // Квартплата, авоська, честная экономика
  // =========================================================================
  rentAmount() {
    return this.world.rent == null ? B.rent : this.world.rent;
  }

  /** Хлеб черствеет за ночь, кисель киснет. В авоське за окном — медленнее. */
  spoilFood(day) {
    for (const p of this.alivePlayers()) {
      const changed = [];
      for (const [from, to] of Object.entries(C.SPOIL)) {
        const n = p.inventory[from] || 0;
        if (!n) continue;
        this.removeItem(p, from, n);
        this.addItem(p, to, n);
        changed.push(`${C.ITEMS[from].name} → ${C.ITEMS[to].name.toLowerCase()} ×${n}`);
      }
      if (p.window && day % B.windowSpoilEvery === 0) {
        for (const [from, to] of Object.entries(C.SPOIL)) {
          const n = p.window[from] || 0;
          if (!n) continue;
          delete p.window[from];
          p.window[to] = (p.window[to] || 0) + n;
        }
      }
      if (changed.length) this.journal(p, `За ночь еда испортилась: ${changed.join(', ')}.`, 'warn');
    }
  }

  /** Квартплата в полночь. С тех, кто был в доме за сутки; новосёлов не трогаем. Не хватило — долг. */
  chargeRent(now) {
    const rent = this.rentAmount();
    if (!rent) return;
    for (const p of this.alivePlayers()) {
      if (this.isNewbie(p)) continue;
      // за сутки, в которые заселился, не платят (наследник тоже начинает с нуля)
      if (p.settledDay != null && p.settledDay >= this.world.lastDay - 1) continue;
      const active = this.isOnline(p.id) || now - (p.lastSeen || 0) < 30 * 60000;
      if (!active) continue;
      const due = rent + (p.rentDebt || 0);
      const pay = Math.min(p.money, due);
      p.money -= pay;
      p.rentDebt = due - pay;
      this.journal(p, p.rentDebt ? `Квартплата: списано ${talons(pay)}, долг за квартиру — ${talons(p.rentDebt)}. Висит на доске этажа.` : `Квартплата: списано ${talons(pay)}.`, p.rentDebt ? 'warn' : 'info');
      if (p.rentDebt) this.log(`${p.name}: долг за квартиру ${talons(p.rentDebt)}`, 'trade', p.id);
      this.dirty([p.id]);
    }
  }

  /** Погасить долг за квартиру у доски. */
  payRent(p) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.nearTo(p, (o) => o.type === 'board')) return { ok: false, error: 'Платят у доски объявлений (там ящик ЖЭК).' };
    if (!p.rentDebt) return { ok: false, error: 'Долга за квартиру нет.' };
    const pay = Math.min(p.money, p.rentDebt);
    if (!pay) return { ok: false, error: 'Нечем платить.' };
    p.money -= pay;
    p.rentDebt -= pay;
    this.journal(p, `Вы погасили долг за квартиру: ${talons(pay)}${p.rentDebt ? `, осталось ${talons(p.rentDebt)}` : ''}.`, 'good');
    return { ok: true, message: p.rentDebt ? `Внесено ${talons(pay)}. Осталось ${talons(p.rentDebt)}.` : 'Долг погашен.' };
  }

  // ---- авоська за окном ----
  windowPut(p, itemId, count = 1) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.isOwnHome(p) || !this.nearTo(p, (o) => o.type === 'window')) return { ok: false, error: 'Авоська — за окном вашей квартиры.' };
    const n = Math.max(1, toInt(count, 1));
    if (!C.ITEMS[itemId] || (p.inventory[itemId] || 0) < n) return { ok: false, error: 'У вас этого нет.' };
    if (!(C.ITEMS[itemId].use && C.ITEMS[itemId].use.hunger)) return { ok: false, error: 'В авоську за окном кладут еду.' };
    p.window = p.window || {};
    const inside = Object.values(p.window).reduce((a, b) => a + b, 0);
    if (inside + n > B.windowCapacity) return { ok: false, error: `В авоську влезает ${B.windowCapacity} штук.` };
    this.removeItem(p, itemId, n);
    p.window[itemId] = (p.window[itemId] || 0) + n;
    return { ok: true, message: `За окном: ${C.ITEMS[itemId].name} ×${p.window[itemId]}.` };
  }

  windowTake(p, itemId, count = 1) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.isOwnHome(p) || !this.nearTo(p, (o) => o.type === 'window')) return { ok: false, error: 'Авоська — за окном вашей квартиры.' };
    const have = (p.window || {})[itemId] || 0;
    const n = Math.min(have, Math.max(1, toInt(count, 1)));
    if (!n) return { ok: false, error: 'В авоське этого нет.' };
    p.window[itemId] -= n;
    if (!p.window[itemId]) delete p.window[itemId];
    this.addItem(p, itemId, n);
    return { ok: true, message: `Взяли: ${C.ITEMS[itemId].name} ×${n}.` };
  }

  /** Туман на этаже: еда в авоське за окном покрывается налётом. Только от тумана, который наслал бог. */
  fogWindows(f) {
    for (const p of this.alivePlayers()) {
      if (!p.window || p.apartment.floor < f.from || p.apartment.floor > f.to) continue;
      let n = 0;
      for (const [from, to] of Object.entries(C.FOGGED)) {
        if (!p.window[from]) continue;
        n += p.window[from];
        p.window[to] = (p.window[to] || 0) + p.window[from];
        delete p.window[from];
      }
      if (n) this.journal(p, 'Пока шёл туман, хлеб в авоське за окном покрылся серым налётом.', 'warn');
    }
  }

  // ---- честная экономика ----
  /** Один адрес у двух жильцов — пометка в журнале обменов (и счётчик для флажка «подозрительный»). */
  sameAddress(p, q) {
    if (!p.lastIp || p.lastIp !== q.lastIp) return '';
    p.sameIpGifts = (p.sameIpGifts || 0) + 1;
    return ' · один адрес';
  }

  /** Новосёл не может раздаривать талоны без меры: иначе новых жильцов заводят как «ферму». */
  newbieGiftCheck(p, money) {
    if (!money || !this.isNewbie(p)) return null;
    const day = this.gameDay();
    if (!p.newbieGifts || p.newbieGifts.day !== day) p.newbieGifts = { day, money: 0 };
    if (p.newbieGifts.money + money > B.newbieGiftLimit) return `Новосёл может отдать не больше ${talons(B.newbieGiftLimit)} в сутки. ЖЭК присматривает.`;
    p.newbieGifts.money += money;
    return null;
  }

  // =========================================================================
  // Вылазки на технические этажи: подсобки за служебными дверями
  // =========================================================================
  /** Служебная дверь рядом (объект 'locked' в коридоре технического этажа). */
  stashDoor(p) {
    if (p.location.place !== 'corridor' || this.map.floorKind(p.location.floor) !== 'technical') return null;
    const o = this.nearTo(p, (x) => x.type === 'locked');
    return o ? { o, id: `${p.location.floor}:${Math.round(o.x)}` } : null;
  }

  /** Что лежит в подсобке: у каждой двери своё, навсегда. */
  stashLoot(doorId) {
    const t = C.STASH_LOOT[World.hash(doorId) % C.STASH_LOOT.length];
    return t === 'paper' ? C.LORE[World.hash(`${doorId}p`) % C.LORE.length].id : t;
  }

  /** Вскрыть (монтировкой) или обшарить подсобку. Безопасно — но ЖЭК всё видит. */
  searchStash(p) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    const d = this.stashDoor(p);
    if (!d) return { ok: false, error: 'Подойдите к служебной двери на техническом этаже.' };
    const now = this.now();
    p.techVisits = [...(p.techVisits || []).filter((x) => now - x.ts < 3600 * 1000), { floor: p.location.floor, ts: now }].slice(-20);
    if (!this.world.pried[d.id]) {
      if (!this.hasItem(p, 'crowbar')) return { ok: false, error: 'Заперто. Без монтировки не открыть.' };
      this.world.pried[d.id] = { by: p.name, at: now };
      this.log(`${p.name} вскрыл подсобку на ${p.location.floor} этаже`, 'social', p.id);
    }
    // перезарядка общая на жильца (как у мусоропровода): одна монтировка — не конвейер по всем подсобкам
    const last = typeof p.stashAt === 'number' ? p.stashAt : 0;
    const wait = last + B.stashCooldownMin * 60000 - now;
    if (wait > 0) return { ok: false, error: `Вы уже лазили по подсобкам. Сил на новую вылазку — через ${Math.ceil(wait / 60000)} мин.` };
    p.stashAt = now;
    // подсобку, которую уже обчистили сегодня, до завтрашнего дня никто не найдёт полной
    const pried = this.world.pried[d.id];
    if (pried.lootDay === this.gameDay()) {
      this.log(`${p.name} обшарил подсобку на ${p.location.floor} этаже — уже пусто`, 'social', p.id);
      return { ok: true, message: 'Здесь до вас уже всё вынесли. Следы на пыли свежие.' };
    }
    if (this.random() < B.stashEmptyChance) {
      this.log(`${p.name} обшарил подсобку на ${p.location.floor} этаже — пусто`, 'social', p.id);
      return { ok: true, message: 'Пыль, ржавые трубы, чей-то старый ватник. Пусто.' };
    }
    const item = this.stashLoot(d.id);
    pried.lootDay = this.gameDay();
    this.addItem(p, item, 1);
    this.journal(p, `В подсобке на ${p.location.floor} этаже нашлось: ${C.ITEMS[item].name}.`, 'good');
    this.log(`${p.name} обшарил подсобку на ${p.location.floor} этаже: ${C.ITEMS[item].name}`, 'social', p.id);
    return { ok: true, message: `В подсобке нашлось: ${C.ITEMS[item].name}.` };
  }

  /** Барыга продаёт монтировку и мебель — каждой вещи по одной в сутки. */
  barygaBuy(p, itemId = 'crowbar') {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.barygaNear(p)) return { ok: false, error: 'Тут никого нет.' };
    const price = C.BARYGA_SELLS[itemId];
    if (!price) return { ok: false, error: '«Такого не держу».' };
    const b = this.world.baryga;
    b.soldDay = b.soldDay || {};
    if (b.soldDay[itemId] === this.gameDay()) return { ok: false, error: '«Кончилось. Завтра».' };
    if (p.money < price) return { ok: false, error: `«${price} талонов, и не меньше».` };
    p.money -= price;
    b.purse = (b.purse || 0) + price;
    b.soldDay[itemId] = this.gameDay();
    this.addItem(p, itemId, 1);
    this.world.barygaClients[p.id] = this.now();
    this.log(`${p.name} купил у барыги: ${C.ITEMS[itemId].name}`, 'trade', p.id);
    return { ok: true, message: '«Держи. Ты это не у меня взял».' };
  }

  // =========================================================================
  // Обустройство квартиры: мебель бережёт от одного события ЖЭК
  // =========================================================================
  /** Мебель квартиры (у хозяина). Гости тоже под её защитой. */
  furnitureAt(apt) {
    const owner = apt ? this.ownerOf(apt) : null;
    return (owner && owner.furniture) || {};
  }

  /** Поставить мебель у себя дома. */
  installFurniture(p, itemId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.isOwnHome(p)) return { ok: false, error: 'Мебель ставят у себя дома.' };
    p.furniture = p.furniture || {};
    if (p.furniture[itemId]) return { ok: false, error: 'Такое уже стоит.' };
    this.removeItem(p, itemId, 1);
    p.furniture[itemId] = true;
    this.journal(p, `Дома теперь есть: ${C.ITEMS[itemId].name}.`, 'good');
    this.log(`${p.name} поставил дома: ${C.ITEMS[itemId].name}`, 'social', p.id);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
    return { ok: true, message: `Поставлено: ${C.ITEMS[itemId].name}.` };
  }

  /** Убрать мебель обратно в карманы (например, чтобы продать или отдать). */
  removeFurniture(p, itemId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.isOwnHome(p)) return { ok: false, error: 'Только у себя дома.' };
    if (!(p.furniture || {})[itemId]) return { ok: false, error: 'Такого нет.' };
    if (itemId === 'stash_box' && Object.keys(p.stash || {}).length) return { ok: false, error: 'Сначала освободите тайник.' };
    delete p.furniture[itemId];
    this.addItem(p, itemId, 1);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
    return { ok: true, message: `${C.ITEMS[itemId].name} — снова в карманах.` };
  }

  /** Шкаф-тайник: положить и взять. Вещи в нём не крадут и не портятся. */
  stashMove(p, itemId, count, put) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.isOwnHome(p) || !(p.furniture || {}).stash_box) return { ok: false, error: 'Тайник — в вашей квартире, если он есть.' };
    if (!this.nearTo(p, (o) => o.type === 'wardrobe')) return { ok: false, error: 'Подойдите к шкафу.' };
    const n = Math.max(1, toInt(count, 1));
    p.stash = p.stash || {};
    if (put) {
      if (!C.ITEMS[itemId] || (p.inventory[itemId] || 0) < n) return { ok: false, error: 'У вас этого нет.' };
      if (CHARGE_KEYS[itemId] || C.ITEMS[itemId].furniture) return { ok: false, error: 'Это в тайник не влезет.' };
      if (Object.values(p.stash).reduce((a, b) => a + b, 0) + n > B.stashCapacity) return { ok: false, error: `В тайник влезает ${B.stashCapacity} вещей.` };
      this.removeItem(p, itemId, n);
      p.stash[itemId] = (p.stash[itemId] || 0) + n;
      return { ok: true };
    }
    const have = p.stash[itemId] || 0;
    if (!have) return { ok: false, error: 'В тайнике этого нет.' };
    const k = Math.min(have, n);
    p.stash[itemId] -= k;
    if (!p.stash[itemId]) delete p.stash[itemId];
    this.addItem(p, itemId, k);
    return { ok: true };
  }

  // =========================================================================
  // Аварийные наряды: жильцы чинят то, что ЖЭК разрешил чинить
  // =========================================================================
  /** Что можно чинить рядом с жильцом: ключ поломки или null. */
  repairHere(p) {
    const w = this.world;
    const near = (type) => this.nearTo(p, (o) => o.type === type);
    let key = null;
    if (p.location.place === 'corridor' && near('lift')) key = 'lift';
    else if (p.location.place === 'canteen' && near('counter')) key = 'canteen';
    else if (p.location.place === 'medpost' && near('window_med')) key = 'medpost';
    else if (p.location.place === 'factory' && near('station')) key = 'factory';
    const b = key && w.breakdowns[key];
    if (!b || !b.repairable || !b.until) return null;
    return key;
  }

  repairStart(p) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (this.world.paused) return { ok: false, error: 'Время в доме остановилось.' };
    const key = this.repairHere(p);
    if (!key) return { ok: false, error: 'Тут нечего чинить (или ЖЭК не разрешает).' };
    if (p.job) return { ok: false, error: 'Вы уже заняты.' };
    if (this.hasBlock(p, 'work')) return { ok: false, error: 'С такой травмой к ремонту не допустят.' };
    const now = this.now();
    if (now - (p.repairAt || 0) < B.repairCooldownSec * 1000) return { ok: false, error: 'Отдышитесь — и снова за дело.' };
    if (p.stats.energy < B.workEnergyCost) return { ok: false, error: 'Нет сил. Поспите.' };
    p.repairAt = now;
    const job = MG.createJob('gauge', 2);
    job.id = newId('j');
    job.startedAt = now;
    job.repair = key;
    job.cost = { energy: B.workEnergyCost, hunger: 0 };
    job.since = this.world.breakdowns[key].since; // наряд — на эту поломку; ЖЭК переставит — наряд отменится
    job.publicData = { ...job.publicData, title: `Аварийный наряд: ${C.BREAKDOWNS[key].name}`, rules: 'Стравите давление в аварийной магистрали: жмите «Сброс», когда стрелка в зелёной зоне.' };
    p.job = job;
    p.sleeping = false;
    this.applyStats(p, { energy: -B.workEnergyCost });
    return { ok: true, job: { id: job.id, game: job.game, data: job.publicData } };
  }

  repairFinish(p, job, score) {
    const b = this.world.breakdowns[job.repair];
    const name = C.BREAKDOWNS[job.repair].name;
    if (!b || !b.until) return { ok: true, result: { score, reward: 0, text: `${name}: уже починили без вас.` } };
    if (!b.repairable || (job.since != null && b.since !== job.since)) return { ok: true, result: { score, reward: 0, text: `${name}: наряд отменён — ЖЭК распорядился иначе.` } };
    if (score < 0.5) return { ok: true, result: { score, reward: 0, text: `${name}: не вышло — качество ${Math.round(score * 100)}%. Попробуйте ещё раз.` } };
    b.until -= B.repairMinutes * 60000;
    p.money += B.repairReward;
    this.markDeed(p, 'care');
    this.log(`${p.name} на аварийном наряде: ${name} — поломка короче на ${B.repairMinutes} мин`, 'social', p.id);
    const fixed = b.until <= this.timerNow(); // на паузе часы поломки стоят
    if (fixed) this.setBreakdown(job.repair, false, {});
    const text = fixed ? `${name}: починено! Премия ${talons(B.repairReward)}.` : `${name}: дело пошло, до починки на ${B.repairMinutes} мин меньше. Премия ${talons(B.repairReward)}.`;
    this.journal(p, text, 'good');
    return { ok: true, result: { score, reward: B.repairReward, text } };
  }

  // =========================================================================
  // Сценарии-цепочки: «подождать — сделать — проверить»
  // =========================================================================
  scenarioDef(id) {
    return Object.hasOwn(this.state.scenarios, id) ? this.state.scenarios[id] : Object.hasOwn(C.SCENARIOS, id) ? C.SCENARIOS[id] : null;
  }

  /** Подходит ли жилец под фильтр шага. */
  matchFilter(p, f = {}) {
    if (f.stat && STAT_KEYS.includes(f.stat)) {
      const v = Number(p.stats[f.stat]);
      if (f.op === '<' ? !(v < Number(f.value)) : !(v > Number(f.value))) return false;
    }
    if (f.condition && !this.hasCondition(p, f.condition)) return false;
    if (f.item && ((p.inventory[f.item] || 0) > 0) !== (f.has !== false)) return false;
    if (f.sealed != null && this.doorSealed(p.apartment.number) !== !!f.sealed) return false;
    if (f.atHome != null && this.isOwnHome(p) !== !!f.atHome) return false;
    if (f.online != null && this.isOnline(p.id) !== !!f.online) return false;
    return true;
  }

  /** Кого касается шаг: его цель (или цель из аргументов команды), отфильтрованная условием. */
  stepTargets(step) {
    const target = step.target || (step.args && step.args.target) || { type: 'all' };
    const list = this.resolveTargets(target);
    return step.filter ? list.filter((p) => this.matchFilter(p, step.filter)) : list;
  }

  runScenarios(now) {
    if (this.world.paused) return;
    for (const run of this.state.scenarioRuns.slice()) {
      if (now < run.nextAt) continue;
      // у идущего сценария своя копия шагов: удаление или правка в библиотеке его не ломает
      const def = run.def || this.scenarioDef(run.scenarioId);
      if (!def || !Array.isArray(def.steps)) {
        this.state.scenarioRuns = this.state.scenarioRuns.filter((x) => x !== run);
        this.log(`Сценарий «${run.name}» снят: его описание больше не найти`, 'schedule');
        continue;
      }
      try {
        this.stepScenario(run, def, now);
      } catch (err) {
        // ошибка одного сценария не должна останавливать мир
        this.state.scenarioRuns = this.state.scenarioRuns.filter((x) => x !== run);
        this.log(`Сценарий «${run.name}» снят из-за ошибки: ${err.message}`, 'schedule');
      }
    }
  }

  /** Шаги одного идущего сценария, пока не встретится ожидание. */
  stepScenario(run, def, now) {
    const who = { who: `сценарий: ${run.name}`, role: 'god' };
    let guard = 0;
    while (run.step < def.steps.length && guard++ < 20) {
      const step = def.steps[run.step];
      if (step.kind === 'wait') {
        run.step++;
        run.nextAt = now + Math.max(0, Number(step.minutes) || 0) * 60000;
        if (run.nextAt > now) break;
        continue;
      }
      if (step.kind === 'stopIfNone') {
        if (!this.stepTargets(step).length) {
          this.log(`Сценарий «${run.name}» остановлен на шаге ${run.step + 1}: никто не подходит под условие`, 'schedule');
          run.step = def.steps.length;
          break;
        }
        run.step++;
        continue;
      }
      // do: команда Пульта; с фильтром — только подходящим жильцам
      const args = JSON.parse(JSON.stringify(step.args || {}));
      if (step.filter || step.target) {
        const ids = this.stepTargets(step).map((p) => p.id);
        args.target = { type: 'ids', ids };
      }
      const res = this.admin(step.cmd, args, who);
      this.log(`Сценарий «${run.name}», шаг ${run.step + 1}: ${step.cmd}${res.ok ? (res.message ? ` — ${res.message}` : '') : ` — не вышло: ${res.error}`}`, 'schedule');
      run.step++;
    }
    if (run.step >= def.steps.length) {
      this.state.scenarioRuns = this.state.scenarioRuns.filter((x) => x !== run);
      this.log(`Сценарий «${run.name}» завершён`, 'schedule');
    }
  }

  /** Проверить сценарий из Пульта: шаги, команды, фильтры. Бросает понятную ошибку. */
  cleanScenario(raw = {}) {
    const name = sanitizeText(raw.name, 60);
    if (!name) throw new Error('Нужно название сценария');
    const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 30) : [];
    if (!steps.length) throw new Error('В сценарии нет шагов');
    const cleanFilter = (f) => {
      if (!f || typeof f !== 'object') return undefined;
      const out = {};
      if (STAT_KEYS.includes(f.stat)) Object.assign(out, { stat: f.stat, op: f.op === '>' ? '>' : '<', value: toInt(f.value, 50) });
      if (typeof f.condition === 'string' && Object.hasOwn(C.CONDITIONS, f.condition)) out.condition = f.condition;
      if (typeof f.item === 'string' && Object.hasOwn(C.ITEMS, f.item)) Object.assign(out, { item: f.item, has: f.has !== false });
      for (const k of ['sealed', 'atHome', 'online']) if (f[k] != null) out[k] = !!f[k];
      return Object.keys(out).length ? out : undefined;
    };
    const cleanTarget = (t) => (t && typeof t === 'object' && typeof t.type === 'string' ? JSON.parse(JSON.stringify(t)) : undefined);
    return {
      name,
      steps: steps.map((st, i) => {
        if (!st || typeof st !== 'object') throw new Error(`Шаг ${i + 1}: пусто`);
        if (st.kind === 'wait') return { kind: 'wait', minutes: Math.max(0, Math.min(1440, Number(st.minutes) || 0)) };
        if (st.kind === 'stopIfNone') return { kind: 'stopIfNone', target: cleanTarget(st.target), filter: cleanFilter(st.filter) };
        if (st.kind !== 'do' || !SCENARIO_CMDS.includes(st.cmd)) throw new Error(`Шаг ${i + 1}: такую команду в сценарий не поставить`);
        return { kind: 'do', cmd: st.cmd, args: st.args && typeof st.args === 'object' ? JSON.parse(JSON.stringify(st.args)) : {}, target: cleanTarget(st.target), filter: cleanFilter(st.filter) };
      }),
    };
  }

  scenarioRunsView() {
    const now = this.now();
    return this.state.scenarioRuns.map((r) => {
      const def = r.def || this.scenarioDef(r.scenarioId);
      return { id: r.id, name: r.name, step: r.step + 1, steps: def ? def.steps.length : 0, inSec: Math.max(0, Math.round((r.nextAt - now) / 1000)) };
    });
  }

  // =========================================================================
  // Перепланировка и аномалии
  // =========================================================================
  /** Конфиг мира с перепланировкой — тот же у сервера, жильцов и Пульта. */
  worldConfig() {
    return { ...WORLD_CONFIG, overlays: this.world.overlays };
  }

  /** Схемы поменялись: пересобрать карту, вытолкнуть тех, кто оказался в стене, разослать всем. */
  rebuildMap(keys = []) {
    this.map = World.create(this.worldConfig());
    for (const p of this.alivePlayers()) {
      if (!keys.includes(this.locationKey(p))) continue;
      const sc = this.sceneOf(p);
      if (!World.canStand(sc, p.pos.x, p.pos.y)) {
        p.pos = { ...this.map.spawn(sc.key), d: 'down' };
        p.posSeq = (p.posSeq || 0) + 1;
      }
    }
    this.emit('world_changed');
  }

  /** Кладовка рядом (новая дверь в стене от ЖЭК). */
  closetSearch(p) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    const o = this.nearTo(p, (x) => x.type === 'closet');
    if (!o) return { ok: false, error: 'Подойдите к кладовке.' };
    const key = `${this.locationKey(p)}:${Math.floor(o.x)}:${Math.floor(o.y)}`;
    const c = this.world.closets[key] || { items: {}, text: '', taken: [] };
    if (c.taken.includes(p.id)) return { ok: false, error: 'Вы здесь уже всё осмотрели.' };
    c.taken.push(p.id);
    this.world.closets[key] = c;
    // вещи забирает первый заглянувший — остальным достаётся пустая полка
    const got = Object.entries(c.items || {}).filter(([id]) => C.ITEMS[id]);
    c.items = {};
    for (const [id, n] of got) this.addItem(p, id, n);
    const what = got.map(([id, n]) => `${C.ITEMS[id].name}${n > 1 ? ` ×${n}` : ''}`).join(', ');
    this.log(`Кладовка (${this.placeTitle(p)}) — заглядывает ${p.name}${what ? `, забирает: ${what}` : ', там пусто'}`, 'social', p.id);
    const text = `${c.text || 'Кладовка, которой вчера здесь не было. Пахнет свежей штукатуркой.'}${what ? ` Внутри: ${what}.` : ' Внутри пусто.'}`;
    this.journal(p, text, what ? 'good' : 'info');
    return { ok: true, message: text };
  }

  /** «Лишний этаж» на табло: лифт везёт туда, где ничего нет, и возвращает обратно. */
  anomalyFloor(p) {
    const a = this.world.anomalies.extraFloor;
    if (!a) return { ok: false, error: 'Такого этажа нет.' };
    if (!this.nearTo(p, (o) => o.type === 'lift')) return { ok: false, error: 'Подойдите к лифту.' };
    if (this.world.breakdowns.lift) return { ok: false, error: 'Лифт не работает.' };
    if (a.harm) this.applyStats(p, { sanity: -8 });
    this.journal(p, `Лифт ехал долго. Двери открылись в бетонную стену, на ней мелом: «${a.label}». Двери закрылись — вы снова на ${p.location.floor} этаже.`, 'whisper');
    this.log(`${p.name} съездил на этаж «${a.label}»`, 'social', p.id);
    return { ok: true, message: `Этаж «${a.label}». Бетон. Вы вернулись.` };
  }

  // =========================================================================
  // Коллективная жалоба в ЖЭК
  // =========================================================================
  petitionsNeeded() {
    return Math.min(B.petitionSignatures, Math.max(2, this.alivePlayers().length));
  }

  createPetition(p, rawText) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (this.mutedFor(p)) return { ok: false, error: `ЖЭК запретил вам писать ещё ${this.mutedFor(p)} мин.` };
    if (!this.nearTo(p, (o) => o.type === 'board')) return { ok: false, error: 'Заявления пишут у доски объявлений.' };
    const text = sanitizeText(rawText, 300);
    if (!text || text.length < 10) return { ok: false, error: 'Опишите, на что жалуетесь (хотя бы пару слов).' };
    if (this.state.petitions.some((x) => x.status === 'open' && x.authorId === p.id)) return { ok: false, error: 'У вас уже есть заявление, которое собирает подписи.' };
    // пока ЖЭК не ответил на ваше отправленное заявление, новое не пишут (иначе очередь забивается)
    if (this.state.petitions.some((x) => x.status === 'sent' && x.authorId === p.id && this.now() - (x.sentAt || x.createdAt) < B.petitionTtlH * 3600 * 1000)) return { ok: false, error: 'Ваше заявление уже у ЖЭК. Дождитесь ответа.' };
    const floor = p.location.floor;
    if (this.state.petitions.filter((x) => x.status === 'open' && x.floor === floor).length >= 3) return { ok: false, error: 'На доске уже три заявления — подпишите одно из них.' };
    const pet = { id: newId('j'), floor, text, authorId: p.id, authorName: p.name, signers: [{ id: p.id, name: p.name, apt: p.apartment.number }], status: 'open', createdAt: this.now() };
    this.state.petitions.push(pet);
    this.log(`${p.name} вывесил коллективное заявление на ${floor} этаже: «${text}»`, 'petition', p.id);
    this.checkPetition(pet);
    return { ok: true, message: `Заявление на доске. Нужно подписей: ${this.petitionsNeeded()}.` };
  }

  signPetition(p, id) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.nearTo(p, (o) => o.type === 'board')) return { ok: false, error: 'Подписывают у доски объявлений.' };
    const pet = this.state.petitions.find((x) => x.id === id);
    if (!pet || pet.floor !== p.location.floor) return { ok: false, error: 'Такого заявления здесь нет.' };
    if (pet.status !== 'open') return { ok: false, error: 'Подписи уже не собирают.' };
    if (pet.signers.some((x) => x.id === p.id)) return { ok: false, error: 'Вы уже подписали.' };
    pet.signers.push({ id: p.id, name: p.name, apt: p.apartment.number });
    this.log(`${p.name} подписал заявление «${pet.text}»`, 'petition', p.id);
    this.checkPetition(pet);
    return { ok: true, message: pet.status === 'sent' ? 'Подписей хватило — заявление ушло в ЖЭК.' : 'Подписано.' };
  }

  checkPetition(pet) {
    if (pet.status !== 'open' || pet.signers.length < this.petitionsNeeded()) return;
    pet.status = 'sent';
    pet.sentAt = this.now();
    const signers = pet.signers.map((x) => this.getPlayer(x.id)).filter((q) => q && q.alive);
    this.notify(signers, { title: 'Заявление ушло в ЖЭК', text: `«${pet.text}». Подписей: ${pet.signers.length}. Ждите ответа.`, style: 'announce' });
    this.log(`Коллективное заявление в ЖЭК (${pet.floor} этаж, подписей ${pet.signers.length}): «${pet.text}» — ${pet.signers.map((x) => x.name).join(', ')}`, 'petition');
  }

  expirePetitions(now) {
    for (const pet of this.state.petitions) if (pet.status === 'open' && now - pet.createdAt > B.petitionTtlH * 3600 * 1000) pet.status = 'expired';
    // открытые и отправленные (ждут ответа ЖЭК) не вытесняются; закрытые — последние 50 за сутки
    const active = (x) => ['open', 'sent'].includes(x.status);
    const closed = new Set(this.state.petitions.filter((x) => !active(x) && now - (x.resolvedAt || x.createdAt) < 24 * 3600 * 1000).slice(-50));
    this.state.petitions = this.state.petitions.filter((x) => active(x) || closed.has(x));
  }

  petitionView(pet, p) {
    return {
      id: pet.id,
      text: pet.text,
      author: pet.authorName,
      signers: pet.signers.map((x) => `${x.name} (${x.apt})`),
      count: pet.signers.length,
      needed: this.petitionsNeeded(),
      status: pet.status,
      reply: pet.reply || null,
      signed: p ? pet.signers.some((x) => x.id === p.id) : false,
    };
  }

  // =========================================================================
  // Старший по этажу
  // =========================================================================
  floorResidents(floor) {
    return this.alivePlayers().filter((q) => q.apartment.floor === floor);
  }

  /**
   * Те, кто бывает в игре: в сети или заходил не раньше windowMs назад. Заброшенные жильцы не
   * умирают сами — без этого они раздували бы план дома, порог старшего и разнарядки.
   */
  activeResidents(windowMs, list = this.alivePlayers(), now = this.now()) {
    return list.filter((q) => this.isOnline(q.id) || now - (q.lastSeen || 0) < windowMs);
  }

  /** Сколько голосов нужно старшему: половина тех, кто живёт на этаже и заходил за сутки. */
  elderNeed(floor) {
    return Math.max(1, Math.ceil(this.activeResidents(24 * 3600 * 1000, this.floorResidents(floor)).length / 2));
  }

  /** Старший — за кого проголосовало не меньше половины жильцов этажа. */
  elderOf(floor) {
    const rec = this.state.elders[floor];
    if (!rec) return null;
    const residents = this.floorResidents(floor);
    const ids = new Set(residents.map((q) => q.id));
    const tally = new Map();
    for (const [voter, cand] of Object.entries(rec.votes || {})) {
      if (!ids.has(voter) || !ids.has(cand)) continue;
      tally.set(cand, (tally.get(cand) || 0) + 1);
    }
    const need = this.elderNeed(floor);
    let best = null;
    for (const [cand, n] of tally) if (n >= need && (!best || n > best.n)) best = { id: cand, n };
    return best ? this.getPlayer(best.id) : null;
  }

  voteElder(p, candidateId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.nearTo(p, (o) => o.type === 'board') || p.location.floor !== p.apartment.floor) return { ok: false, error: 'Голосуют у доски своего этажа.' };
    const c = this.getPlayer(candidateId);
    if (!c || !c.alive || c.apartment.floor !== p.apartment.floor) return { ok: false, error: 'Выбирать можно только жильца своего этажа.' };
    const floor = p.apartment.floor;
    const before = this.elderOf(floor);
    this.state.elders[floor] = this.state.elders[floor] || { votes: {} };
    this.state.elders[floor].votes[p.id] = c.id;
    const after = this.elderOf(floor);
    if (after && (!before || before.id !== after.id)) {
      this.notify(this.floorResidents(floor), { title: 'Старший по этажу', text: `Этаж ${floor} выбрал старшего: ${after.name} (кв. ${after.apartment.number}).`, style: 'announce' });
      this.log(`Старший по ${floor} этажу: ${after.name}`, 'social', after.id);
    }
    return { ok: true, message: `Ваш голос — за ${c.name}.` };
  }

  /** Старшему звонят из ЖЭК: туман из расписания придёт на его этаж через несколько минут. Делиться ли — решает он. */
  elderWarnings(now) {
    for (const e of this.state.schedule) {
      if (e.cmd !== 'fog' || e.elderWarnedAt === e.at || e.at <= now || e.at - now > B.elderLeadMin * 60000) continue;
      e.elderWarnedAt = e.at;
      const a = toInt(e.args && e.args.from, C.BUILDING.firstResidentialFloor);
      const b = toInt(e.args && e.args.to, a);
      const warn = Math.max(0, Number(e.args && e.args.warnSec) || 30);
      for (const floor of Object.keys(this.state.elders).map(Number)) {
        if (floor < Math.min(a, b) || floor > Math.max(a, b)) continue;
        const elder = this.elderOf(floor);
        if (!elder) continue;
        const mins = Math.max(1, Math.round((e.at - now + warn * 1000) / 60000));
        this.notify([elder], { title: 'Звонок из ЖЭК', text: `Только для старшего по этажу: примерно через ${mins} мин на этажи ${Math.min(a, b)}–${Math.max(a, b)} придёт туман. Сирены пока не будет. Сказать ли соседям — решать вам.`, style: 'whisper' });
        this.log(`Старшему ${elder.name} (${floor} этаж) позвонили о тумане заранее`, 'social', elder.id);
      }
    }
  }

  // =========================================================================
  // Долговые расписки
  // =========================================================================
  gameDay() {
    return Math.floor(this.world.gameMinutes / 1440) + 1;
  }

  iouOverdue(iou) {
    return iou.status === 'open' && this.gameDay() > iou.dueDay;
  }

  iouView(iou) {
    const debtor = this.getPlayer(iou.debtorId);
    const holder = this.getPlayer(iou.holderId);
    return {
      id: iou.id,
      debtorId: iou.debtorId,
      debtor: debtor ? `${debtor.name} (кв. ${debtor.apartment.number})` : '?',
      holder: holder ? `${holder.name} (кв. ${holder.apartment.number})` : '?',
      what: this.bundleText(iou.bundle),
      dueDay: iou.dueDay,
      overdue: this.iouOverdue(iou),
    };
  }

  /** Вернуть долг тому, у кого сейчас расписка. Можно откуда угодно — расписку несут ЖЭК-почтой. */
  repayIou(p, id) {
    const iou = this.state.ious.find((x) => x.id === id && x.status === 'open');
    if (!iou || iou.debtorId !== p.id) return { ok: false, error: 'Такой расписки за вами нет.' };
    const holder = this.getPlayer(iou.holderId);
    if (!holder || !holder.alive) return { ok: false, error: 'Держателя расписки больше нет.' };
    if (!this.hasBundle(p, iou.bundle)) return { ok: false, error: 'Нечем отдавать.' };
    this.moveBundle(p, holder, iou.bundle);
    iou.status = 'paid';
    iou.closedAt = this.now();
    const what = this.bundleText(iou.bundle);
    this.journal(p, `Вы вернули долг ${holder.name}: ${what}.`, 'good');
    this.notify([holder], { title: 'Долг возвращён', text: `${p.name} вернул по расписке: ${what}.`, style: 'good' });
    this.log(`${p.name} вернул долг ${holder.name}: ${what}`, 'trade', p.id);
    this.dirty([p.id, holder.id]);
    return { ok: true, message: 'Долг возвращён.' };
  }

  /** Передать (перепродать) расписку соседу рядом: теперь долг отдают ему. */
  transferIou(p, id, toId) {
    const iou = this.state.ious.find((x) => x.id === id && x.status === 'open');
    if (!iou || iou.holderId !== p.id) return { ok: false, error: 'Такой расписки у вас нет.' };
    const q = this.getPlayer(toId);
    if (!q || !q.alive || q.id === p.id || this.locationKey(q) !== this.locationKey(p) || this.distance(p, q) > 3) return { ok: false, error: 'Передать можно только соседу рядом.' };
    if (q.id === iou.debtorId) return { ok: false, error: 'Отдать расписку самому должнику — значит простить долг.' };
    iou.holderId = q.id;
    const debtor = this.getPlayer(iou.debtorId);
    this.journal(p, `Вы передали расписку ${debtor ? debtor.name : ''} жильцу ${q.name}.`);
    this.notify([q], { title: 'Расписка', text: `Вам передали расписку (от ${p.name}): долг ${debtor ? debtor.name : '?'} — ${this.bundleText(iou.bundle)} до дня ${iou.dueDay}.`, style: 'info' });
    if (debtor) this.notify([debtor], { title: 'Ваш долг перепродан', text: `Теперь долг нужно вернуть жильцу ${q.name}: ${this.bundleText(iou.bundle)}.`, style: 'warn' });
    this.log(`${p.name} передал расписку (${debtor ? debtor.name : '?'}) жильцу ${q.name}`, 'trade', p.id);
    this.dirty([p.id, q.id]);
    return { ok: true, message: 'Расписка передана.' };
  }

  forgiveIou(p, id) {
    const iou = this.state.ious.find((x) => x.id === id && x.status === 'open');
    if (!iou || iou.holderId !== p.id) return { ok: false, error: 'Такой расписки у вас нет.' };
    iou.status = 'forgiven';
    iou.closedAt = this.now();
    const debtor = this.getPlayer(iou.debtorId);
    if (debtor) this.notify([debtor], { title: 'Долг прощён', text: `${p.name} простил вам долг: ${this.bundleText(iou.bundle)}.`, style: 'good' });
    this.markDeed(p, 'gift', iou.debtorId);
    this.log(`${p.name} простил долг ${debtor ? debtor.name : '?'}`, 'trade', p.id);
    return { ok: true, message: 'Долг прощён.' };
  }

  /** Погибшие: их расписки закрываются (долги мёртвых не взыскивают, долги перед мёртвыми — тоже). */
  closeIousOf(p) {
    for (const iou of this.state.ious) {
      if (iou.status !== 'open' || (iou.debtorId !== p.id && iou.holderId !== p.id)) continue;
      iou.status = 'void';
      iou.closedAt = this.now();
    }
  }

  /** Стена памяти в столовой: кого уже нет. */
  memorial(p) {
    if (!this.nearTo(p, (o) => o.type === 'memorial')) return { ok: false, error: 'Подойдите к стене памяти.' };
    const recent = this.players()
      .filter((q) => !q.alive && q.diedAt)
      .map((q) => ({ name: q.name, apt: q.apartment.number, createdAt: q.createdAt, diedAt: q.diedAt, shifts: q.shifts || 0, helped: (q.deeds && q.deeds.helped) || 0 }));
    const old = this.state.archive.map((a) => ({ name: a.name, apt: a.apartment, createdAt: a.createdAt, diedAt: a.diedAt, shifts: a.shifts || 0, helped: a.helped || 0 }));
    const list = [...recent, ...old]
      .sort((a, b) => b.diedAt - a.diedAt)
      .slice(0, 40)
      .map((x) => ({ name: x.name, apt: x.apt, lived: fmtDuration((x.diedAt || 0) - (x.createdAt || x.diedAt || 0)), shifts: x.shifts, helped: x.helped, ago: fmtDuration(this.now() - x.diedAt) }));
    return { ok: true, memorial: list, total: recent.length + old.length };
  }

  // =========================================================================
  // Радиоточка со своим эфиром
  // =========================================================================
  /** Слышит ли жилец радиоточку: в сети и в помещении, где она висит. */
  hearsRadio(p) {
    if (!p.alive || p.travel || !this.isOnline(p.id)) return false;
    try {
      return this.map.scene(this.locationKey(p)).objects.some((o) => o.type === 'radio');
    } catch {
      return false;
    }
  }

  radioTick(now) {
    const r = this.world.radio;
    if (r.silenceUntil) {
      if (now < r.silenceUntil) return;
      r.silenceUntil = null;
    }
    const hour = this.gameClock().hour;
    const every = hour >= 22 || hour < 6 ? B.radioEveryMin * 3 : B.radioEveryMin;
    if (this.world.gameMinutes - (r.lastAirMin || 0) < every) return;
    r.lastAirMin = this.world.gameMinutes;
    r.slot = (r.slot || 0) + 1;
    if (r.queue.length) {
      const item = r.queue.shift();
      this.airRadio(item.text, 'zhek');
      return;
    }
    // каждая вторая передача — новости дома (только то, что жильцы и так могли знать)
    if (r.slot % 2 === 0) {
      const fresh = this.state.log.filter((e) => e.public && e.ts > (r.lastNewsTs || 0));
      if (fresh.length) {
        const e = fresh[fresh.length - 1];
        r.lastNewsTs = e.ts;
        this.airRadio(`Новости дома: ${e.public}.`, 'news');
        return;
      }
    }
    this.airRadio(C.RADIO.lines[Math.floor(this.random() * C.RADIO.lines.length)], 'line');
  }

  /** Что услышит конкретный жилец: в сирену и при низком рассудке эфир сбоит. */
  radioFor(p, text) {
    const f = this.world.fog;
    const siren = f && this.fogPhase() === 'warning' && p.location.floor >= f.from && p.location.floor <= f.to;
    const sanity = p.stats.sanity;
    if (sanity < 25 && this.random() < 0.4) {
      const line = C.RADIO.eerie[Math.floor(this.random() * C.RADIO.eerie.length)];
      return { text: line.replace(/\{name\}/g, p.name), garbled: true };
    }
    if (siren || sanity < 40) {
      const rate = siren ? 0.45 : 0.25;
      const words = text.split(' ').map((w) => (this.random() < rate ? '…ш-ш…' : w));
      return { text: words.join(' ').replace(/(…ш-ш… )+…ш-ш…/g, '…ш-ш-ш…'), garbled: true };
    }
    return { text, garbled: false };
  }

  airRadio(rawText, kind = 'line') {
    const text = sanitizeText(rawText, 300);
    if (!text) return 0;
    const r = this.world.radio;
    r.log = [...(r.log || []), { ts: this.now(), clock: this.gameClock().time, text, kind }].slice(-8);
    let n = 0;
    for (const p of this.alivePlayers()) {
      if (!this.hearsRadio(p)) continue;
      const heard = this.radioFor(p, text);
      this.emit('radio', { to: p.id, text: heard.text, garbled: heard.garbled, kind });
      n++;
    }
    return n;
  }

  /** «Слушать» у радиоточки: последние передачи (или тишина). */
  listenRadio(p) {
    if (!this.nearTo(p, (o) => o.type === 'radio')) return { ok: false, error: 'Подойдите к радиоточке.' };
    const r = this.world.radio;
    if (r.silenceUntil && this.now() < r.silenceUntil) return { ok: true, radio: [], silence: C.RADIO.silence };
    const lines = (r.log || []).slice(-5).map((l) => ({ clock: l.clock, ...this.radioFor(p, l.text) }));
    return { ok: true, radio: lines, silence: lines.length ? null : 'Радиоточка потрескивает. Передач пока не было.' };
  }

  /** Полный запас на сутки с множителем factor (null у позиций без ограничений). */
  fullStock(factor) {
    const stock = {};
    for (const [shop, entries] of Object.entries(C.SHOPS)) {
      stock[shop] = {};
      for (const e of entries) if (e.daily != null) stock[shop][e.id || e.item] = Math.round(e.daily * factor);
    }
    return stock;
  }

  /** Завоз в 08:00: чем больше смен закрыли за сутки, тем больше привезут (60–140% нормы). */
  supplyCheck() {
    const w = this.world;
    const day = Math.floor(w.gameMinutes / 1440);
    const hour = Math.floor((w.gameMinutes % 1440) / 60);
    if (w.lastSupplyDay == null) w.lastSupplyDay = hour >= B.supplyHour ? day : day - 1;
    if (hour >= B.supplyHour && w.lastSupplyDay < day) {
      w.lastSupplyDay = day;
      this.deliver();
    }
  }

  deliver(extra = false) {
    const w = this.world;
    // норма — по тем, кто был в доме за прошлые игровые сутки (ушедшие навсегда не делают дефицит вечным)
    const now = this.now();
    const active = this.alivePlayers().filter((q) => this.isOnline(q.id) || now - (q.lastSeen || 0) < 24 * 60000).length;
    const need = Math.max(6, active * B.supplyShiftsPerResident);
    const factor = extra ? 0.5 : (0.6 + 0.8 * Math.min(1, w.shiftsToday / need)) * (w.supplyNext ?? 1);
    const fresh = this.fullStock(factor);
    for (const [shop, items] of Object.entries(fresh)) {
      for (const [key, n] of Object.entries(items)) this.state.stock[shop][key] = extra ? (this.state.stock[shop][key] || 0) + n : n;
    }
    const pct = Math.round(factor * 100);
    if (!extra) {
      this.log(`Завоз: ${pct}% нормы (смен за сутки: ${w.shiftsToday}${w.supplyNext !== 1 ? `, множитель ЖЭК ${w.supplyNext}` : ''})`, 'event', null, {
        public: pct >= 100 ? 'в столовую и медпункт привезли полный завоз' : pct >= 80 ? 'завоз в столовую и медпункт' : 'скудный завоз: в столовой и медпункте многого не хватит',
      });
      w.shiftsToday = 0;
      w.supplyNext = 1;
    }
  }

  /** Подмешать беды и предметы из Пульта к стандартным (content.js). */
  applyPalette() {
    const pal = this.state.palette;
    for (const [id, def] of Object.entries(pal.conditions || {})) C.CONDITIONS[id] = def;
    for (const [id, def] of Object.entries(pal.accidents || {})) C.ACCIDENTS[id] = def;
    for (const [id, def] of Object.entries(pal.items || {})) C.ITEMS[id] = def;
  }

  /** Проверить и привести к порядку описание из Пульта. Бросает ошибку с понятным текстом. */
  cleanPaletteDef(type, raw = {}) {
    const num = (v, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
    };
    const name = sanitizeText(raw.name, 40);
    if (!name) throw new Error('Нужно название');
    const stats = (src, lo, hi) => Object.fromEntries(STAT_KEYS.map((k) => [k, num((src || {})[k], lo, hi)]).filter(([, v]) => v));
    if (type === 'conditions') {
      const dur = num(raw.durationMin, 0, 600);
      return {
        name,
        kind: raw.kind === 'injury' ? 'injury' : 'disease',
        durationMin: dur || null,
        contagious: num(raw.contagious, 0, 1) || undefined,
        perMin: stats(raw.perMin, -20, 20),
        blocks: (Array.isArray(raw.blocks) ? raw.blocks : []).filter((b) => ['work', 'stairs'].includes(b)),
        symptom: sanitizeText(raw.symptom, 40) || undefined,
        custom: true,
      };
    }
    if (type === 'accidents') {
      const condition = raw.condition && Object.hasOwn(C.CONDITIONS, raw.condition) ? raw.condition : undefined;
      return { name, text: sanitizeText(raw.text, 300) || name, effect: { ...stats(raw.effect, -200, 200), ...(raw.kill ? { kill: true } : {}) }, condition, custom: true };
    }
    if (type === 'items') {
      const cure = (Array.isArray(raw.cure) ? raw.cure : []).filter((c) => typeof c === 'string' && Object.hasOwn(C.CONDITIONS, c));
      const use = { ...stats(raw.use, -100, 100), ...(cure.length ? { cure } : {}) };
      return { name, desc: sanitizeText(raw.desc, 120) || '', ...(Object.keys(use).length ? { use } : {}), custom: true };
    }
    throw new Error('Нет такого раздела палитры');
  }

  /** Планировщик ЖЭК: выполнить команды, время которых пришло. */
  runSchedule(now) {
    if (this.inSchedule || this.world.paused) return; // команда из расписания не запускает расписание заново
    this.inSchedule = true;
    try {
      const due = this.state.schedule.filter((e) => now >= e.at).slice(0, 10);
      for (const e of due) {
        // сначала переставить запись, потом выполнять: что бы ни сделала команда, второй раз она не сработает
        if (e.repeatMs) {
          e.at += e.repeatMs;
          if (e.at <= now) e.at = now + e.repeatMs;
        } else {
          this.state.schedule = this.state.schedule.filter((x) => x !== e);
        }
        e.runs = (e.runs || 0) + 1;
        const res = this.admin(e.cmd, JSON.parse(JSON.stringify(e.args || {})), { who: `расписание: ${e.label}`, role: 'god' });
        this.log(`По расписанию: ${e.label}${res.ok ? (res.message ? ` — ${res.message}` : '') : ` — не вышло: ${res.error}`}`, 'schedule');
      }
    } finally {
      this.inSchedule = false;
    }
  }

  /** Сдвинуть все таймеры мира на ms (после паузы: всё должно продолжиться с того же места). */
  shiftTimers(ms) {
    const w = this.world;
    if (w.fog) {
      w.fog.warnUntil += ms;
      w.fog.until += ms;
    }
    if (w.power && w.power.until) w.power.until += ms;
    for (const b of Object.values(w.breakdowns)) if (b && b.until) b.until += ms;
    for (const e of this.state.schedule) e.at += ms;
    for (const list of Object.values(w.hazards)) for (const hz of list) if (hz.until) hz.until += ms;
    for (const a of this.state.assignments) if (!a.closed) a.until += ms;
    for (const c of w.climate || []) if (c.until) c.until += ms;
    for (const r of this.state.scenarioRuns) r.nextAt += ms;
    if (w.radio && w.radio.silenceUntil) w.radio.silenceUntil += ms;
    for (const p of this.players()) this.shiftPlayerTimers(p, ms);
  }

  /**
   * Вещи, которых больше нет в справочнике (убрали из палитры; откат вернул старую), исчезают отовсюду:
   * карманы, авоськи, тайники, кладовки, обмены, передачки, расписки. Иначе виды жильцов падают.
   */
  purgeUnknownItems() {
    const known = (id) => Object.hasOwn(C.ITEMS, id);
    const clean = (bag) => {
      if (bag && typeof bag === 'object') for (const id of Object.keys(bag)) if (!known(id)) delete bag[id];
    };
    for (const p of this.players()) {
      clean(p.inventory);
      clean(p.window);
      clean(p.stash);
      clean(p.furniture);
    }
    for (const c of Object.values(this.world.closets || {})) clean(c.items);
    for (const t of Object.values(this.state.trades)) {
      if (Object.keys(t.give.items || {}).some((id) => !known(id)) || Object.keys(t.want.items || {}).some((id) => !known(id))) delete this.state.trades[t.id];
    }
    for (const drops of Object.values(this.state.doorDrops)) for (const d of drops) if (d.bundle) clean(d.bundle.items);
    // из долга вещь вычёркивается; если в долге ничего не осталось — расписка закрыта
    for (const iou of this.state.ious) {
      if (iou.status !== 'open' || !iou.bundle) continue;
      clean(iou.bundle.items);
      if (!iou.bundle.money && !Object.keys(iou.bundle.items || {}).length) {
        iou.status = 'void';
        iou.closedAt = this.now();
      }
    }
  }

  shiftPlayerTimers(p, ms) {
    for (const c of p.conditions || []) if (c.until) c.until += ms;
    if (p.travel && !p.travel.stuck) {
      p.travel.arriveAt += ms;
      p.travel.startedAt += ms;
    }
    if (p.down) p.down.until += ms;
    if (p.homeward && p.homeward.nextAt) p.homeward.nextAt += ms;
    if (p.job) p.job.startedAt += ms;
  }

  /** Давно погибших уносим из Пульта в архив домовой книги, чтобы снимок для админки не рос бесконечно. */
  archiveDead(now = this.now()) {
    const limit = C.ARCHIVE_DEAD_AFTER_H * 3600 * 1000;
    for (const p of this.players()) {
      if (p.alive || !p.diedAt || now - p.diedAt < limit) continue;
      this.state.archive.push({ id: p.id, name: p.name, apartment: p.apartment.number, createdAt: p.createdAt, diedAt: p.diedAt, deathCause: p.deathCause, shifts: p.shifts || 0, helped: (p.deeds && p.deeds.helped) || 0 });
      if (this.state.archive.length > 5000) this.state.archive.splice(0, this.state.archive.length - 5000);
      delete this.state.players[p.id];
      this.byToken.delete(p.token);
      this.onlineSet.delete(p.id);
      this.invalidatePlayers();
    }
  }

  tickPlayer(p, now, dt, groups) {
    const online = this.isOnline(p.id);
    if (p.travel) this.updateTravel(p, now);
    if (!online && p.homeward) this.updateHomeward(p, now);
    const atHomeNow = p.location.place === 'home';
    // d — нужды и болезни (у отсутствующих медленно), dh — беды бога (туман, темнота)
    const d = dt * (online ? 1 : B.offlineFactor);
    const dh = dt * (online ? 1 : atHomeNow ? B.offlineHazardHome : 1);

    const delta = { health: 0, hunger: 0, energy: 0, sanity: 0 };
    const harm = {};
    const hurt = (cause, amount) => {
      if (amount < 0) harm[cause] = (harm[cause] || 0) - amount;
    };
    const atHome = p.location.place === 'home';
    const floor = p.location.floor;

    delta.hunger += B.hungerPerMin * d;
    if (p.sleeping) delta.energy += B.energySleepRegenPerMin * d;
    else if (atHome) delta.energy += B.energyHomeRegenPerMin * d;
    else delta.energy += B.energyPassivePerMin * d;
    if (atHome) delta.sanity += B.sanityHomeRegenPerMin * d;

    for (const c of p.conditions) {
      const def = C.CONDITIONS[c.id];
      if (!def) continue;
      for (const [k, v] of Object.entries(def.perMin || {})) {
        delta[k] += v * d;
        if (k === 'health') hurt(`Скончался: ${def.name.toLowerCase()}`, v * d);
      }
    }

    const fogged = this.inFog(floor) && !(atHome && this.doorSealed(this.currentApt(p)));
    if (fogged) {
      let factor = this.world.fog.intensity || 1;
      if (atHome && this.furnitureAt(this.currentApt(p)).door_seal) factor *= 0.5; // уплотнитель
      if (this.maskWorks(p)) {
        factor *= B.gasMaskFactor;
        this.wearGasmask(p, dh);
      }
      const hp = (atHome ? B.fogHpHomeUnsealedPerMin : B.fogHpOutsidePerMin) * factor * dh;
      delta.health += hp;
      hurt('Погиб в тумане', hp);
      delta.sanity += (atHome ? B.fogSanityHomeUnsealedPerMin : B.fogSanityOutsidePerMin) * factor * dh;
      if (!this.hasCondition(p, 'fogsick') && this.random() < B.fogSicknessChancePerMin * factor * dh) {
        this.addCondition(p, 'fogsick');
        this.log(`${p.name} подхватил туманную хворь`, 'disease', p.id);
      }
    }

    // микроклимат вредит, только если ЖЭК включил множитель; дома за задраенной дверью — не достаёт
    const clim = this.climateAt(floor);
    const heated = atHome && (clim && (clim.kind === 'cold' || clim.kind === 'damp')) && this.furnitureAt(this.currentApt(p)).heater;
    const climHarm = !!(clim && clim.harm > 0 && !heated && !(atHome && this.doorSealed(this.currentApt(p))));
    if (climHarm) {
      for (const [k, v] of Object.entries(C.CLIMATES[clim.kind].harm)) {
        delta[k] += v * clim.harm * dh;
        if (k === 'health') hurt(`${C.CLIMATES[clim.kind].name} доконал`, v * clim.harm * dh);
      }
    }

    if (this.isDarkFor(p)) {
      if (this.torchWorks(p)) {
        p.flashCharge = Math.max(0, (p.flashCharge ?? 100) - B.flashDrainPerMin * dh);
        if (p.flashCharge <= 0) {
          this.journal(p, 'Фонарик мигнул и погас: села батарейка.', 'warn');
          this.dirty([p.id]);
        }
      } else {
        delta.sanity += B.darkSanityPerMin * dh;
      }
    }

    // Голод сам по себе отсутствующего не убивает: сытость не опускается ниже порога
    if (!online && p.stats.hunger + delta.hunger < B.offlineHungerFloor) delta.hunger = Math.min(0, B.offlineHungerFloor - p.stats.hunger);

    if (p.stats.hunger <= 0 && online) {
      const hp = B.starvationHpPerMin * d;
      delta.health += hp;
      hurt('Умер от голода', hp);
    } else if (p.stats.hunger > 50 && p.conditions.length === 0 && !fogged && !climHarm && !p.down) {
      delta.health += B.healthRegenPerMin * d;
    }
    if (p.stats.sanity <= 0 && online) {
      const hp = B.sanityZeroHpPerMin * d;
      delta.health += hp;
      hurt('Сошёл с ума', hp);
    }

    this.applyStats(p, delta);
    const causes = Object.entries(harm).sort((a, b) => b[1] - a[1]);
    if (causes.length) p.lastHarm = causes[0][0];

    // вне сети болезни и травмы идут медленно — и срок их тоже тянется (иначе их можно «отлежать»)
    if (!online) for (const c of p.conditions) if (c.until) c.until += dt * 60000 * (1 - B.offlineFactor);

    // истечение болезней и травм
    const healed = p.conditions.filter((c) => c.until && now >= c.until);
    if (healed.length) {
      p.conditions = p.conditions.filter((c) => !healed.includes(c));
      for (const c of healed) this.journal(p, `Вы поправились: ${C.CONDITIONS[c.id]?.name || c.id}.`, 'good');
      this.dirty([p.id]);
    }

    // заражение соседей по локации
    const group = groups.get(this.locationKey(p)) || [];
    for (const c of p.conditions) {
      const def = C.CONDITIONS[c.id];
      if (!def?.contagious) continue;
      for (const q of group) {
        if (q === p || !q.alive || this.hasCondition(q, c.id)) continue;
        const k = online && this.isOnline(q.id) ? 1 : B.offlineFactor; // хотя бы один «спит» — заражение медленное
        if (this.random() < def.contagious * dt * k) {
          this.addCondition(q, c.id);
          this.log(`${q.name} заразился от ${p.name}: ${def.name}`, 'disease', q.id);
        }
      }
    }

    if (p.sleeping && p.stats.energy >= 100 && online) {
      p.sleeping = false;
      this.journal(p, 'Вы выспались.', 'good');
    }

    if (online && p.stats.sanity < 20 && this.random() < 0.02) this.hallucinate(p);
    if (online && this.state.doorDrops[p.apartment.number] && this.isOwnHome(p)) this.collectDrops(p);

    if (p.down) {
      if (now >= p.down.until) this.kill(p, p.down.cause);
    } else if (p.stats.health <= 0) {
      this.fall(p, p.lastHarm || 'Умер при невыясненных обстоятельствах');
    }
  }

  /** Противогаз защищает, пока фильтр не забит. */
  maskWorks(p) {
    return this.hasItem(p, 'gasmask') && p.gasmaskCharge > 0;
  }

  /** Фонарик светит, пока не села батарейка. */
  torchWorks(p) {
    return this.hasItem(p, 'flashlight') && (p.flashCharge ?? 100) > 0;
  }

  wearGasmask(p, d) {
    p.gasmaskCharge = Math.max(0, p.gasmaskCharge - B.gasMaskDrainPerMin * d); // фильтра хватает минут на пять тумана
    if (p.gasmaskCharge <= 0) {
      this.journal(p, 'Фильтр противогаза забился — он больше не защищает. Нужен сменный фильтр (медпункт).', 'danger');
      this.dirty([p.id]);
    }
  }

  hallucinate(p) {
    const echoes = this.world.echoes || [];
    if (echoes.length) {
      const e = echoes.shift();
      this.emit('chat', { id: newId('m'), ts: this.now(), channel: 'local', key: this.locationKey(p), to: p.id, hallucination: true, from: { name: `${e.from} †`, apt: '???' }, text: e.text });
      return;
    }
    const voice = C.HALLUCINATION_VOICES[Math.floor(this.random() * C.HALLUCINATION_VOICES.length)];
    const msg = {
      id: newId('m'),
      ts: this.now(),
      channel: 'local',
      key: this.locationKey(p),
      to: p.id, // видит только сам игрок
      hallucination: true,
      from: { name: voice, apt: '???' },
      text: C.HALLUCINATIONS[Math.floor(this.random() * C.HALLUCINATIONS.length)],
    };
    this.emit('chat', msg);
  }

  // =========================================================================
  // Перемещение
  // =========================================================================
  /**
   * Перемещение между сценами. Всё — только «ногами»: надо стоять у нужной двери.
   *   { place: 'home' }                       — войти к себе (у своей двери в коридоре)
   *   { place: 'canteen'|'medpost'|'factory' } — войти в учреждение (у его двери в коридоре)
   *   { place: 'corridor' }                   — выйти в коридор (у двери квартиры/учреждения)
   *   { place: 'corridor', floor, via }       — поехать на лифте (via: 'lift') или пойти по лестнице ('stairs')
   */
  move(p, dest = {}) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (p.down) return { ok: false, error: 'Вы без сознания.' };
    if (p.travel) return { ok: false, error: p.travel.stuck ? 'Вы застряли в лифте.' : 'Вы уже в пути.' };
    const place = dest.place;
    if (!MOVE_PLACES.includes(place)) return { ok: false, error: 'Туда не пройти.' };
    const here = p.location;
    const fail = (error) => ({ ok: false, error });

    let target;
    let entry;
    if (place === 'corridor' && here.place === 'corridor') {
      const floor = toInt(dest.floor, -1);
      if (floor < C.BUILDING.minFloor || floor > C.BUILDING.maxFloor) return fail(`Этажи — с ${C.BUILDING.minFloor} по ${C.BUILDING.maxFloor}.`);
      if (floor === here.floor) return fail('Вы и так на этом этаже.');
      const via = dest.via === 'stairs' ? 'stairs' : 'lift';
      if (!this.nearTo(p, (o) => o.type === via)) return fail(via === 'lift' ? 'Подойдите к лифту.' : 'Подойдите к лестнице.');
      if (via === 'lift' && this.world.breakdowns.lift) return fail('Лифт не работает. Только по лестнице.');
      return this.startTravel(p, floor, via);
    }
    if (place === 'corridor') {
      if (!['home', ...Object.keys(C.FACILITIES)].includes(here.place)) return fail('Отсюда в коридор не выйти.');
      if (!this.nearTo(p, (o) => o.type === 'exit' || o.type === 'hermodoor')) return fail('Подойдите к двери.');
      if (here.place === 'home' && this.doorSealed(this.currentApt(p))) return fail('Гермодверь задраена. Сначала откройте её.');
      target = { place: 'corridor', floor: here.floor };
      entry = here.place === 'home' ? `apt:${this.currentApt(p)}` : 'facility';
    } else if (place === 'home') {
      if (here.place !== 'corridor' || here.floor !== p.apartment.floor) return fail(`Ваша квартира — на ${p.apartment.floor} этаже.`);
      if (!this.nearTo(p, (o) => o.type === 'apt' && o.number === p.apartment.number)) return fail('Подойдите к своей двери.');
      target = { place: 'home', floor: p.apartment.floor, apt: p.apartment.number };
      entry = 'default';
    } else {
      const fac = C.FACILITIES[place];
      if (here.place !== 'corridor' || here.floor !== fac.floor) return fail(`${fac.name} — на ${fac.floor} этаже.`);
      if (!this.nearTo(p, (o) => o.type === 'facility' && o.facility === place)) return fail('Подойдите к двери.');
      target = { place, floor: fac.floor };
      entry = 'default';
      // аномалия «дверь не туда»: дверь учреждения ведёт в другое
      const wd = this.world.anomalies.wrongDoor;
      if (wd && wd.facility === place && C.FACILITIES[wd.to] && wd.to !== place) {
        target = { place: wd.to, floor: C.FACILITIES[wd.to].floor };
        if (wd.harm) this.applyStats(p, { sanity: -5 });
        this.journal(p, `Вы вошли в дверь «${fac.name}»… и оказались в «${C.FACILITIES[wd.to].name}». Табличка на двери та же.`, 'whisper');
        this.log(`${p.name}: дверь не туда (${place} → ${wd.to})`, 'social', p.id);
      }
    }

    const witnesses = this.leaveScene(p);
    this.relocate(p, target, entry);
    if (target.place === 'corridor') this.tutorialStep(p, 'corridor');
    if (target.place === 'factory') this.tutorialStep(p, 'factory');
    if (target.place === 'home') this.tutorialDrill(p);
    this.dirty([...witnesses, ...this.othersAt(p)].map((q) => q.id));
    return { ok: true };
  }

  /** Общее для любого ухода из сцены: просыпаемся, бросаем смену. */
  leaveScene(p) {
    p.sleeping = false;
    if (p.job) {
      p.job = null;
      this.journal(p, 'Вы ушли со смены, не закончив её.', 'warn');
    }
    return this.othersAt(p);
  }

  startTravel(p, floor, via) {
    const from = p.location.floor;
    const diff = Math.abs(floor - from);
    if (via === 'stairs') {
      if (this.hasBlock(p, 'stairs')) return { ok: false, error: 'С переломом ноги по лестнице не пройти. Ждите лифт или лечитесь.' };
      const cost = diff * B.stairsEnergyPerFloor;
      if (p.stats.energy < cost) return { ok: false, error: `Не хватит сил на ${diff} эт. по лестнице (нужно ${Math.ceil(cost)} сил).` };
      p.stats.energy -= cost;
    }
    const witnesses = this.leaveScene(p);
    const sec = via === 'lift' ? B.liftBaseSec + diff * B.liftSecPerFloor : diff * B.stairsSecPerFloor;
    const now = this.timerNow(); // на паузе поездка начнётся, когда время пойдёт
    p.travel = { via, toPlace: 'corridor', toFloor: floor, fromFloor: from, startedAt: now, arriveAt: now + sec * 1000 };
    // аномалия «петля на лестнице»: путь через петлю приводит туда же, откуда вышли
    const loop = this.world.anomalies.stairLoop;
    if (via === 'stairs' && loop && Math.min(from, floor) <= loop.to && Math.max(from, floor) >= loop.from) p.travel.loop = true;
    this.relocate(p, { place: via, floor: from });
    this.dirty([...witnesses, ...this.othersAt(p)].map((q) => q.id));
    return { ok: true };
  }

  updateTravel(p, now) {
    const t = p.travel;
    if (t.frozen) {
      if (p.down) return; // лежит на пролёте
      t.frozen = false;
      t.arriveAt = now + (t.remainingMs || 0);
    }
    if (t.via === 'lift' && this.world.breakdowns.lift) {
      if (!t.stuck) {
        t.stuck = true;
        t.remainingMs = Math.max(0, t.arriveAt - now);
        this.notify([p], { title: 'Лифт встал', text: 'Кабина дёрнулась и замерла между этажами. Свет мигает. Вы застряли.', style: 'warn' });
      }
      return;
    }
    if (t.stuck) {
      t.stuck = false;
      t.arriveAt = now + t.remainingMs;
      this.journal(p, 'Лифт дёрнулся и поехал дальше.', 'good');
    }
    if (now >= t.arriveAt) this.arrive(p);
  }

  arrive(p) {
    const t = p.travel;
    p.travel = null;
    const witnesses = this.othersAt(p);
    if (t.loop && this.world.anomalies.stairLoop) {
      if (this.world.anomalies.stairLoop.harm) this.applyStats(p, { sanity: -6 });
      this.journal(p, `Вы шли и шли по лестнице… и вышли на ${t.fromFloor} этаж — туда же, откуда начали. Силы потрачены.`, 'whisper');
      this.log(`${p.name}: петля на лестнице (${t.fromFloor} → ${t.toFloor})`, 'social', p.id);
      this.relocate(p, { place: 'corridor', floor: t.fromFloor }, 'stairs');
      if (p.homeward) p.homeward.looped = true; // тело ушедшего жильца не ходит по кругу бесконечно
      this.dirty([p.id, ...witnesses.map((q) => q.id), ...this.othersAt(p).map((q) => q.id)]);
      return;
    }
    this.relocate(p, { place: t.toPlace, floor: t.toFloor }, t.via);
    this.dirty([p.id, ...witnesses.map((q) => q.id), ...this.othersAt(p).map((q) => q.id)]);
  }

  // =========================================================================
  // Действия дома
  // =========================================================================
  seal(p, on) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (p.location.place !== 'home') return { ok: false, error: 'Гермодверь есть только в квартире.' };
    if (!this.nearTo(p, (o) => o.type === 'hermodoor')) return { ok: false, error: 'Подойдите к гермодвери.' };
    const apt = this.currentApt(p);
    this.setDoorSealed(apt, !!on);
    // гость открыл чужую дверь — запомним: уходя, он задраит её за собой, если хозяин остался внутри
    if (!on && apt !== p.apartment.number) this.unsealedBy.set(apt, p.id);
    else this.unsealedBy.delete(apt);
    if (on && apt === p.apartment.number) this.tutorialStep(p, 'seal');
    this.journal(p, on ? 'Вы задраили гермодверь.' : 'Вы открыли гермодверь.');
    this.dirty(this.othersAt(p).map((q) => q.id));
    return { ok: true };
  }

  sleep(p, on) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (on) {
      if (p.location.place !== 'home') return { ok: false, error: 'Спать можно только дома.' };
      if (!this.nearTo(p, (o) => o.type === 'bed')) return { ok: false, error: 'Подойдите к кровати.' };
      if (this.hasCondition(p, 'insomnia')) return { ok: false, error: 'Бессонница. Глаза не закрываются.' };
    }
    p.sleeping = !!on;
    return { ok: true };
  }

  /** Можно ли применить предмет к жильцу (чтобы не тратить таблетки на здорового). */
  itemUseful(target, itemId) {
    const u = C.ITEMS[itemId].use;
    if (u.refill === 'gasmask') return this.hasItem(target, 'gasmask') && target.gasmaskCharge < 100;
    if (u.refill === 'flashlight') return this.hasItem(target, 'flashlight') && (target.flashCharge ?? 100) < 100;
    const curable = (u.cure || []).some((id) => this.hasCondition(target, id));
    const shortenable = (u.shorten || []).some((id) => this.hasCondition(target, id));
    const onlyCures = !u.hunger && !u.health && !u.sanity && !u.energy;
    return !onlyCures || curable || shortenable;
  }

  /** Применить предмет к жильцу (себе или соседу). Возвращает список того, что произошло. */
  applyItemUse(target, itemId) {
    const u = C.ITEMS[itemId].use;
    this.applyStats(target, u);
    const parts = [];
    if (u.refill === 'gasmask') {
      target.gasmaskCharge = 100;
      parts.push('противогаз снова защищает');
    }
    if (u.refill === 'flashlight') {
      target.flashCharge = 100;
      parts.push('фонарик снова светит');
    }
    for (const id of (u.cure || []).filter((c) => this.hasCondition(target, c))) {
      this.cureCondition(target, id);
      parts.push(`прошло: ${C.CONDITIONS[id].name}`);
    }
    for (const id of (u.shorten || []).filter((c) => this.hasCondition(target, c))) {
      const c = target.conditions.find((x) => x.id === id);
      if (c && c.until) c.until = this.timerNow() + (c.until - this.timerNow()) / 2;
      parts.push(`${C.CONDITIONS[id].name} заживает быстрее`);
    }
    return parts;
  }

  useItem(p, itemId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (p.down) return { ok: false, error: 'Вы без сознания.' };
    const def = C.ITEMS[itemId];
    if (!def || !this.hasItem(p, itemId)) return { ok: false, error: 'У вас этого нет.' };
    if (def.equip) return { ok: false, error: 'Работает сам, пока лежит у вас в кармане.' };
    if (def.read) return { ok: true, read: { title: def.name, text: def.read } }; // бумага не тратится
    if (def.furniture) return this.installFurniture(p, itemId);
    if (!def.use) return { ok: false, error: 'Это не используется. Зато можно обменять.' };
    if (!this.itemUseful(p, itemId)) {
      if (def.use.refill) return { ok: false, error: def.use.refill === 'gasmask' ? 'Нужен противогаз — или фильтр в нём ещё свежий.' : 'Нужен фонарик — или он и так заряжен.' };
      return { ok: false, error: 'Вам это сейчас не нужно.' };
    }
    p.sleeping = false;
    this.removeItem(p, itemId, 1);
    const parts = this.applyItemUse(p, itemId);
    if (def.use.hunger) this.tutorialStep(p, 'eat');
    this.journal(p, `Использовано: ${def.name}${parts.length ? ` (${parts.join(', ')})` : ''}.`);
    return { ok: true };
  }

  // =========================================================================
  // Без сознания: помочь или обобрать
  // =========================================================================
  /**
   * Здоровье кончилось. Дома жилец умирает, а вне своей квартиры — теряет сознание
   * и лежит B.downSec секунд: соседи могут помочь или обобрать. Не помогли — смерть.
   */
  fall(p, cause) {
    if (!p.alive || p.down) return;
    if (this.isOwnHome(p)) {
      this.kill(p, cause);
      return;
    }
    const now = this.timerNow();
    p.down = { since: now, until: now + B.downSec * 1000, cause, robbedBy: [] };
    p.stats.health = 0;
    p.sleeping = false;
    p.job = null;
    // homeward не трогаем: пока жилец лежит, тело никуда не идёт, а очнувшись — побредёт дальше.
    // Упал в пути — тело оказывается в коридоре ближайшего этажа (у лифта или лестницы): там его видно
    // и можно помочь. В общей «сцене» лифта или лестницы до него не дотянуться.
    if (p.travel) {
      const t = p.travel;
      const total = Math.max(1, t.arriveAt - t.startedAt);
      const k = t.stuck ? Math.min(1, Math.max(0, 1 - (t.remainingMs || 0) / total)) : Math.min(1, Math.max(0, (this.now() - t.startedAt) / total));
      const floor = Math.round(t.fromFloor + (t.toFloor - t.fromFloor) * k);
      const via = t.via;
      p.travel = null;
      this.relocate(p, { place: 'corridor', floor }, via === 'lift' ? 'lift' : 'stairs');
    }
    this.notify([p], { title: 'Вы теряете сознание', text: 'В глазах темнеет. Может быть, кто-нибудь поможет…', style: 'danger' });
    this.log(`${p.name} без сознания: ${cause}`, 'accident', p.id);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
  }

  /** Соседи рядом, до которых можно дотянуться. */
  canTouch(p, target) {
    // лифт и лестница — общая «сцена» для всех этажей: в пути до соседа не дотянуться
    if (!target || p.travel || target.travel) return false;
    return target.alive && target.id !== p.id && this.locationKey(target) === this.locationKey(p) && this.distance(p, target) <= B.touchReach;
  }

  /**
   * Привести в чувство (помощь соседа, лечение от ЖЭК). Отсутствующий жилец, очнувшись не дома,
   * снова побредёт домой.
   */
  wake(p, { by = null, what = '' } = {}) {
    if (!p.down) return;
    const robbers = p.down.robbedBy || [];
    p.down = null;
    p.stats.health = Math.max(10, p.stats.health);
    p.lastHarm = null;
    this.notify([p], {
      title: 'Вы очнулись',
      text: `${by ? `Вас привёл в чувство ${by}${what ? `: ${what}` : ''}.` : 'Вы пришли в себя.'}${robbers.length ? `\nПока вы лежали, в ваших карманах рылся: ${robbers.join(', ')}.` : ''}`,
      style: 'good',
    });
    p.lastRobbedBy = robbers.length ? robbers.slice() : null;
    if (!this.isOnline(p.id) && !this.isOwnHome(p) && !p.homeward) p.homeward = { since: this.now(), nextAt: null, step: null };
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
  }

  /** Использовать свой предмет на соседе: перевязать, дать таблетку, накормить. Лежачий очнётся. */
  aid(p, targetId, itemId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (p.down) return { ok: false, error: 'Вы без сознания.' };
    const t = this.getPlayer(targetId);
    if (!this.canTouch(p, t)) return { ok: false, error: 'Подойдите ближе.' };
    const def = C.ITEMS[itemId];
    if (!def || !def.use || !this.hasItem(p, itemId)) return { ok: false, error: 'Этим не помочь.' };
    if (!t.down && !this.itemUseful(t, itemId)) return { ok: false, error: `${t.name} это сейчас не нужно.` };
    const u = def.use;
    if (t.down && !(u.health || u.hunger || u.sanity || u.cure)) return { ok: false, error: 'Этим в чувство не привести.' };
    const wasDown = !!t.down;
    this.removeItem(p, itemId, 1);
    const parts = this.applyItemUse(t, itemId);
    const what = `${def.name}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    if (wasDown) {
      this.wake(t, { by: p.name, what });
      this.log(`${p.name} привёл в чувство ${t.name}: ${what}`, 'social', p.id);
    } else {
      this.notify([t], { title: 'Помощь', text: `${p.name} дал вам: ${what}.`, style: 'good' });
      this.log(`${p.name} помог ${t.name}: ${what}`, 'social', p.id);
    }
    this.journal(p, `Вы помогли ${t.name}: ${what}.`, 'good');
    this.markDeed(p, wasDown ? 'rescue' : 'aid', wasDown ? null : t.id);
    this.dirty([p.id, t.id, ...this.othersAt(t).map((q) => q.id)]);
    return { ok: true, message: wasDown ? `${t.name} приходит в себя.` : `Вы помогли: ${t.name}.` };
  }

  /** Разряд жильца на станке (1–6) по опыту из трудовой книжки. */
  rankOf(p, gameId) {
    const xp = (p.skills && p.skills[gameId]) || 0;
    let rank = 1;
    C.RANKS.forEach((need, i) => {
      if (xp >= need) rank = i + 1;
    });
    return rank;
  }

  /** Лучший разряд — его видят соседи. */
  bestRank(p) {
    return Math.max(...Object.keys(MG.WORK_GAMES).map((g) => this.rankOf(p, g)));
  }

  /** Новосёл: первые часы его нельзя обокрасть (злые механики сначала бьют по новичкам). */
  isNewbie(p) {
    // наследник — не новосёл: иначе каждая новая жизнь давала бы два часа неуязвимости
    return !p.heirOf && this.now() - (p.createdAt || 0) < B.newbieProtectionH * 3600 * 1000;
  }

  /**
   * Карманник в темноте: без света на этаже можно попробовать обшарить соседа.
   * Удача — забирает до 3 талонов или одну вещь. Вора узнают, если фонарик есть у жертвы
   * или у кого-то рядом. Неудача выдаёт вора всегда.
   */
  pickpocket(p, targetId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    const t = this.getPlayer(targetId);
    if (!this.canTouch(p, t)) return { ok: false, error: 'Подойдите ближе.' };
    if (t.down) return { ok: false, error: 'Он без сознания — тут и так всё видно.' };
    if (this.isNewbie(p)) return { ok: false, error: 'Новосёлу не к лицу. ЖЭК присматривает и за вами.' };
    if (!this.isDark(p.location.floor) || !this.isDarkFor(p) || p.location.place === 'lift' || p.location.place === 'stairs') return { ok: false, error: 'Светло — сразу заметят.' };
    if (this.isNewbie(t)) return { ok: false, error: 'Новосёла трогать — себе дороже: ЖЭК присматривает за новенькими.' };
    const now = this.now();
    if (now - (p.lastPickAt || 0) < B.pickpocketCooldownSec * 1000) return { ok: false, error: 'Слишком подозрительно — подождите.' };
    p.lastPickAt = now;
    const lit = [t, ...this.othersAt(p).filter((q) => q.id !== t.id)].some((q) => this.torchWorks(q));
    if (this.random() >= B.pickpocketChance) {
      this.notify([t], { title: 'Чужая рука', text: `В темноте вы схватили за руку ${p.name}. Он лез к вам в карман.`, style: 'warn' });
      this.log(`${p.name} попался на попытке обшарить ${t.name} в темноте`, 'social', p.id);
      this.markDeed(p, 'theft');
      return { ok: true, message: `${t.name} схватил вас за руку!` };
    }
    let what;
    const units = [];
    for (const [id, n] of Object.entries(t.inventory)) for (let i = 0; i < n; i++) units.push(id);
    if (t.money > 0 && (this.random() < 0.5 || !units.length)) {
      const m = Math.min(3, t.money);
      t.money -= m;
      p.money += m;
      what = talons(m);
    } else if (units.length) {
      const id = units[Math.floor(this.random() * units.length)];
      const charge = this.chargeOf(t, id);
      this.removeItem(t, id, 1);
      this.addItem(p, id, 1, charge);
      what = C.ITEMS[id].name;
    } else {
      return { ok: true, message: 'Карманы пустые. Только крошки.' };
    }
    this.notify([t], { title: 'Карманы', text: lit ? `В свете фонарика видно, кто это был: ${p.name}. Пропало: ${what}.` : `В темноте кто-то обшарил ваши карманы. Пропало: ${what}.`, style: 'warn' });
    this.log(`${p.name} обшарил в темноте ${t.name}: ${what}${lit ? ' (его видели)' : ''}`, 'social', p.id);
    if (lit) this.markDeed(p, 'theft'); // незамеченного вора молва не знает
    this.dirty([p.id, t.id]);
    return { ok: true, message: `Добыча: ${what}.${lit ? ' Кажется, вас видели.' : ''}` };
  }

  /** Обшарить карманы лежащего без сознания: все талоны и до двух вещей. */
  rob(p, targetId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (p.down) return { ok: false, error: 'Вы без сознания.' };
    const t = this.getPlayer(targetId);
    if (!this.canTouch(p, t)) return { ok: false, error: 'Подойдите ближе.' };
    if (this.isNewbie(t)) return { ok: false, error: 'Новосёла трогать — себе дороже: ЖЭК присматривает за новенькими.' };
    if (this.isNewbie(p)) return { ok: false, error: 'Новосёлу не к лицу. ЖЭК присматривает и за вами.' };
    if (!t.down) return { ok: false, error: `${t.name} в сознании — так просто в карманы не залезть.` };
    if (t.down.robbedBy.includes(p.name)) return { ok: false, error: 'Вы уже всё забрали.' };
    const taken = { money: t.money, items: {} };
    const units = [];
    for (const [id, n] of Object.entries(t.inventory)) for (let i = 0; i < n; i++) units.push(id);
    for (let k = 0; k < 2 && units.length; k++) {
      const id = units.splice(Math.floor(this.random() * units.length), 1)[0];
      taken.items[id] = (taken.items[id] || 0) + 1;
    }
    this.moveBundle(t, p, taken);
    t.down.robbedBy.push(p.name);
    this.markDeed(p, 'rob');
    if (t.absence && !this.isOnline(t.id)) t.absence.robbedBy = [...(t.absence.robbedBy || []), p.name];
    const what = this.bundleText(taken);
    this.journal(p, `Вы обшарили карманы ${t.name}: ${what}.`, 'warn');
    this.log(`${p.name} обшарил карманы лежащего ${t.name}: ${what}`, 'social', p.id);
    this.dirty([p.id, t.id]);
    return { ok: true, message: `В карманах нашлось: ${what}.` };
  }

  // =========================================================================
  // Коридор: стук в дверь, мусоропровод, доска объявлений
  // =========================================================================
  knock(p, number) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    const door = this.nearTo(p, (o) => o.type === 'apt' && o.number === String(number));
    if (!door) return { ok: false, error: 'Подойдите к двери.' };
    if (door.number === p.apartment.number) return { ok: false, error: 'Это ваша дверь.' };
    const now = this.now();
    if (now - (this.lastKnock.get(p.id) || 0) < 3000) return { ok: false, error: 'Не так часто.' };
    this.lastKnock.set(p.id, now);
    const owner = this.alivePlayers().find((q) => q.apartment.number === door.number);
    if (owner && this.isOnline(owner.id) && this.isOwnHome(owner)) {
      const symptoms = p.conditions.map((c) => C.CONDITIONS[c.id]?.symptom).filter(Boolean);
      this.knocks.set(owner.id, { guestId: p.id, ts: now });
      // туман на этаже, а хозяин дома — если не откроет, это запомнится
      if (this.world.fog && door && this.fogPhase() && p.location.floor >= this.world.fog.from && p.location.floor <= this.world.fog.to) {
        this.refusals.set(p.id, { apt: door.number, owner: owner.name, ownerId: owner.id, ts: now, kind: 'ignored' });
      }
      this.notify([owner], {
        title: 'Стук в дверь',
        text: `В глазок видно: ${p.name} из кв. ${p.apartment.number}${symptoms.length ? ` — ${symptoms.join(', ')}` : ''}.${this.rumor(p).length ? ` Говорят: ${this.rumor(p).join(', ')}.` : ''}`,
        style: 'knock',
        journal: false,
        action: { label: 'Открыть', act: 'open_door', args: { guest: p.id } },
      });
      return { ok: true, message: 'Вы постучали. За дверью кто-то шевелится.' };
    }
    if (owner && !this.isOnline(owner.id) && owner.absence) {
      owner.absence.knocks.push({ name: p.name, apt: p.apartment.number, ts: now });
      if (owner.absence.knocks.length > 20) owner.absence.knocks.shift();
      this.pushOffline(owner, { title: 'Стук в дверь', body: `В вашу дверь стучит ${p.name} из кв. ${p.apartment.number}.`, tag: 'knock' });
    }
    return { ok: true, message: owner ? 'Тишина. Похоже, хозяина нет дома.' : 'Тишина. Квартира пустует.' };
  }

  searchChute(p) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.nearTo(p, (o) => o.type === 'chute')) return { ok: false, error: 'Подойдите к мусоропроводу.' };
    const now = this.now();
    const wait = (p.searchedAt || 0) + SEARCH_COOLDOWN_MS - now;
    if (wait > 0) return { ok: false, error: `Здесь вы уже рылись. Загляните через ${Math.ceil(wait / 60000)} мин.` };
    p.searchedAt = now;
    const roll = this.random();
    let found = null;
    if (roll < 0.2) found = 'rusk';
    else if (roll < 0.3) found = 'bulb';
    else if (roll < 0.38) found = 'fork';
    else if (roll < 0.38 + B.lorePaperChance) found = C.LORE[Math.floor(this.random() * C.LORE.length)].id;
    else if (roll < 0.40 + B.lorePaperChance) found = 'crowbar';
    if (found) {
      this.addItem(p, found, 1);
      this.journal(p, `В мусоропроводе нашлось: ${C.ITEMS[found].name}.`, 'good');
      return { ok: true, message: `Среди очистков нашлось: ${C.ITEMS[found].name}.` };
    }
    this.journal(p, 'Вы порылись в мусоропроводе. Только запах.');
    return { ok: true, message: 'Ничего, кроме запаха.' };
  }

  readBoard(p) {
    if (!this.nearTo(p, (o) => o.type === 'board')) return { ok: false, error: 'Подойдите к доске объявлений.' };
    const notes = this.state.chatGlobal.filter((m) => m.from?.system).slice(-8).reverse().map((m) => ({ ts: m.ts, from: m.from.name, text: m.text }));
    const pinned = (this.state.boardNotes[p.location.floor] || [])
      .slice()
      .reverse()
      .map((n) => ({ id: n.id, ts: n.ts, name: n.name, apt: n.apt, text: n.text, mine: n.playerId === p.id }));
    // разнарядки этого этажа и разнарядки, которые касаются квартиры читающего
    const list = this.state.assignments.filter((a) => (p.location.floor >= a.from && p.location.floor <= a.to) || (p.apartment.floor >= a.from && p.apartment.floor <= a.to));
    const assignments = list.slice(-6).reverse().map((a) => ({ ...this.assignmentView(a, p), closed: !!a.closed }));
    const floor = p.location.floor;
    const petitions = this.state.petitions.filter((x) => x.floor === floor).slice(-6).reverse().map((x) => this.petitionView(x, p));
    // старший и голосование — только у доски своего этажа
    const own = floor === p.apartment.floor;
    const elder = this.elderOf(floor);
    const votes = (this.state.elders[floor] || {}).votes || {};
    const tally = {};
    for (const c of Object.values(votes)) tally[c] = (tally[c] || 0) + 1;
    const elderInfo = {
      name: elder ? `${elder.name} (кв. ${elder.apartment.number})` : null,
      canVote: own,
      myVote: votes[p.id] || null,
      candidates: own ? this.floorResidents(floor).map((q) => ({ id: q.id, name: q.name, apt: q.apartment.number, votes: tally[q.id] || 0 })) : [],
      need: this.elderNeed(floor),
    };
    // книга должников этажа: просроченные расписки жильцов этого этажа
    const debtors = this.state.ious
      .filter((x) => this.iouOverdue(x) && (this.getPlayer(x.debtorId) || {}).apartment?.floor === floor)
      .map((x) => this.iouView(x));
    const rentDebtors = this.floorResidents(floor).filter((q) => q.rentDebt > 0).map((q) => ({ name: q.name, apt: q.apartment.number, debt: q.rentDebt }));
    return { ok: true, notes, pinned, assignments, petitions, elder: elderInfo, debtors, rentDebtors, myRentDebt: p.rentDebt || 0, rent: this.rentAmount() };
  }

  /** Кто сейчас стучит к хозяину (если стучали недавно и гость всё ещё у двери). */
  knockerFor(owner) {
    const k = this.knocks.get(owner.id);
    if (!k || this.now() - k.ts > 60000) return null;
    const guest = this.getPlayer(k.guestId);
    if (!guest || !guest.alive || !this.isOnline(guest.id)) return null;
    if (this.locationKey(guest) !== `corridor:${owner.apartment.floor}`) return null;
    const door = this.map.scene(`corridor:${owner.apartment.floor}`).objects.find((o) => o.type === 'apt' && o.number === owner.apartment.number);
    if (!door || !World.nearObject(door, guest.pos, World.REACH + 0.5)) return null;
    return guest;
  }

  /** Хозяин открывает дверь тому, кто постучал. */
  openDoor(owner, guestId) {
    if (!owner.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.isOwnHome(owner)) return { ok: false, error: 'Открыть можно только свою дверь — изнутри.' };
    if (!this.nearTo(owner, (o) => o.type === 'hermodoor')) return { ok: false, error: 'Подойдите к гермодвери.' };
    const guest = this.knockerFor(owner);
    if (!guest || guest.id !== guestId) return { ok: false, error: 'За дверью уже никого.' };
    this.knocks.delete(owner.id);
    this.refusals.delete(guest.id);
    const witnesses = this.othersAt(guest);
    guest.sleeping = false;
    this.relocate(guest, { place: 'home', floor: owner.apartment.floor, apt: owner.apartment.number });
    // хозяин стоит у двери — гость проходит на шаг вглубь, чтобы не стоять друг в друге
    for (const [dx, dy] of [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]]) {
      const x = guest.pos.x + dx, y = guest.pos.y + dy;
      if (World.canStand(this.sceneOf(guest), x, y) && Math.hypot(x - owner.pos.x, y - owner.pos.y) > 0.7) {
        guest.pos = { x, y, d: 'up' };
        break;
      }
    }
    this.notify([guest], { title: 'Вас впустили', text: `${owner.name} открыл дверь кв. ${owner.apartment.number}. Вы в гостях.`, style: 'good' });
    this.journal(owner, `Вы впустили ${guest.name} (кв. ${guest.apartment.number}).`, 'good');
    this.markDeed(owner, 'shelter');
    this.log(`${owner.name} впустил к себе ${guest.name}${this.inFog(owner.apartment.floor) || (this.world.fog && this.fogPhase() === 'warning') ? ' — в туман' : ''}`, 'social', owner.id);
    this.dirty([owner.id, ...witnesses.map((q) => q.id)]);
    return { ok: true, message: `${guest.name} у вас в гостях.` };
  }

  /** Хозяин выставляет гостя за дверь. */
  evict(owner, guestId) {
    if (!owner.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!this.isOwnHome(owner)) return { ok: false, error: 'Выставить можно только из своей квартиры.' };
    const guest = this.getPlayer(guestId);
    if (!guest || !guest.alive || guest.id === owner.id || this.locationKey(guest) !== this.locationKey(owner)) return { ok: false, error: 'Этого жильца у вас нет.' };
    const fog = this.inFog(owner.apartment.floor);
    this.relocate(guest, { place: 'corridor', floor: owner.apartment.floor }, `apt:${owner.apartment.number}`);
    guest.sleeping = false;
    if (fog) {
      this.refusals.set(guest.id, { apt: owner.apartment.number, owner: owner.name, ts: this.now(), kind: 'evicted' });
      this.markDeed(owner, 'cold');
    }
    this.notify([guest], { title: 'Вас выставили', text: `${owner.name} выставил вас за дверь кв. ${owner.apartment.number}.${fog ? ' В коридоре туман.' : ''}`, style: fog ? 'danger' : 'warn' });
    this.journal(owner, `Вы выставили ${guest.name} за дверь.`, 'warn');
    this.log(`${owner.name} выставил ${guest.name} за дверь${fog ? ' — в туман' : ''}`, 'social', owner.id);
    this.dirty([owner.id, guest.id, ...this.othersAt(guest).map((q) => q.id)]);
    return { ok: true };
  }

  /** Гостей хозяина, который умер или пропал, выводим в коридор. */
  evictAllGuests(apt, floor) {
    const guests = this.alivePlayers().filter((q) => q.location.place === 'home' && this.currentApt(q) === apt && q.apartment.number !== apt);
    // мир сам никого не наказывает: в туман (и в сирену) гостей за дверь не выставляем — пусть переждут
    const f = this.world.fog;
    if (guests.length && f && floor >= f.from && floor <= f.to) {
      for (const q of guests) {
        this.journal(q, `Хозяина кв. ${apt} больше нет. Пока на этаже туман, можно переждать здесь.`, 'warn');
        this.dirty([q.id]);
      }
      return false;
    }
    for (const q of guests) {
      this.relocate(q, { place: 'corridor', floor }, `apt:${apt}`);
      this.journal(q, `Хозяина кв. ${apt} больше нет. Вы вышли в коридор.`, 'warn');
      this.dirty([q.id]);
    }
    this.setDoorSealed(apt, false); // следующий жилец получит квартиру с открытой дверью
    return true;
  }

  /** Гости в квартирах погибших — выйти, когда туман ушёл. */
  evictOrphanGuests() {
    const done = new Set();
    for (const q of this.alivePlayers()) {
      const apt = this.currentApt(q);
      if (!apt || apt === q.apartment.number || done.has(apt) || this.ownerOf(apt)) continue;
      done.add(apt);
      this.evictAllGuests(apt, Math.floor(Number(apt) / 100));
    }
  }

  /**
   * Передачки и записки погибшему: передачки — назад живым отправителям, записки — в мусоропровод.
   * Иначе их заберёт следующий жилец квартиры.
   */
  returnDrops(apt, deadName, reason = 'dead') {
    const drops = this.state.doorDrops[apt] || [];
    delete this.state.doorDrops[apt];
    for (const d of drops) {
      if (d.kind !== 'parcel') continue;
      const sender = this.getPlayer(d.fromId);
      if (!sender || !sender.alive) continue;
      for (const [id, n] of Object.entries(d.bundle.items)) if (C.ITEMS[id]) this.addItem(sender, id, n, (d.bundle.charges || {})[id] ?? 100);
      sender.money += d.bundle.money;
      this.journal(sender, reason === 'zhek' ? `ЖЭК изъял вашу передачку у двери ${deadName} и вернул вам: ${this.bundleText(d.bundle)}.` : `Передачка для ${deadName} вернулась к вам: ${this.bundleText(d.bundle)}. Адресата больше нет.`, 'warn');
      this.dirty([sender.id]);
    }
  }

  /** Жилец у себя в квартире (а не в гостях). */
  isOwnHome(p) {
    return p.location.place === 'home' && this.currentApt(p) === p.apartment.number;
  }

  /** Лента для Пульта: записки и листки видны ЖЭК, в том числе авторы анонимок. */
  feed(entry) {
    const e = { id: newId('f'), ts: this.now(), adminOnly: true, ...entry };
    this.state.noteFeed.push(e);
    if (this.state.noteFeed.length > 200) this.state.noteFeed.splice(0, this.state.noteFeed.length - 200);
    this.emit('chat', e);
  }

  /** Общие проверки для того, что подсовывают под чужую дверь. */
  doorDropCheck(p, apt) {
    if (!p.alive) return { error: 'Вы мертвы.' };
    const door = this.nearTo(p, (o) => o.type === 'apt' && o.number === String(apt));
    if (!door) return { error: 'Подойдите к двери.' };
    if (door.number === p.apartment.number) return { error: 'Это ваша дверь.' };
    if (!this.alivePlayers().some((q) => q.apartment.number === door.number)) return { error: 'Квартира пустует — передавать некому.' };
    const now = this.now();
    if (now - (p.lastDropAt || 0) < C.NOTES.cooldownMs) return { error: 'Не так часто.' };
    const drops = this.state.doorDrops[door.number] || [];
    if (drops.length >= C.NOTES.perDoor) return { error: 'Под дверью уже не протолкнуть — там куча бумажек и свёртков.' };
    // один жилец не может забить чужую дверь: не больше двух своих бумажек и свёртков
    if (drops.filter((d) => d.fromId === p.id).length >= 2) return { error: 'Под этой дверью уже лежат два ваших свёртка. Подождите, пока хозяин заберёт.' };
    return { door, now };
  }

  addDrop(p, door, drop, now) {
    p.lastDropAt = now;
    if (!this.state.doorDrops[door.number]) this.state.doorDrops[door.number] = [];
    this.state.doorDrops[door.number].push({ id: newId('d'), ts: now, fromId: p.id, fromName: p.name, fromApt: p.apartment.number, ...drop });
    const owner = this.alivePlayers().find((q) => q.apartment.number === door.number);
    if (owner && this.isOnline(owner.id) && this.isOwnHome(owner)) this.collectDrops(owner);
    else if (owner) this.pushOffline(owner, { title: 'Под дверью', body: drop.kind === 'note' ? `Кто-то подсунул записку под дверь кв. ${door.number}.` : `Под дверью кв. ${door.number} оставили свёрток.`, tag: 'door' });
  }

  /** Подсунуть записку под чужую дверь. anon — без подписи (ЖЭК всё равно видит автора). */
  slipNote(p, apt, rawText, anon) {
    if (this.mutedFor(p)) return { ok: false, error: `ЖЭК запретил вам писать ещё ${this.mutedFor(p)} мин.` };
    const check = this.doorDropCheck(p, apt);
    if (check.error) return { ok: false, error: check.error };
    const text = sanitizeText(rawText, C.NOTES.maxLength);
    if (!text) return { ok: false, error: 'Пустая записка.' };
    this.addDrop(p, check.door, { kind: 'note', text, anon: !!anon }, check.now);
    this.journal(p, `Вы подсунули записку под дверь кв. ${check.door.number}.`);
    this.feed({ channel: 'note', to: check.door.number, from: { id: p.id, name: p.name, apt: p.apartment.number }, anon: !!anon, text });
    return { ok: true, message: 'Записка под дверью.' };
  }

  /** Оставить передачку у чужой двери: вещи и талоны забирает хозяин, даже если сейчас его нет. */
  leaveParcel(p, apt, rawBundle, rawText) {
    const check = this.doorDropCheck(p, apt);
    if (check.error) return { ok: false, error: check.error };
    const bundle = this.normalizeBundle(rawBundle);
    if (this.bundleEmpty(bundle)) return { ok: false, error: 'Пустой свёрток.' };
    if (!this.hasBundle(p, bundle)) return { ok: false, error: 'У вас нет того, что вы хотите оставить.' };
    const limit = this.newbieGiftCheck(p, bundle.money);
    if (limit) return { ok: false, error: limit };
    p.money -= bundle.money;
    bundle.charges = {};
    for (const id of Object.keys(bundle.items)) if (CHARGE_KEYS[id]) bundle.charges[id] = this.chargeOf(p, id);
    for (const [id, n] of Object.entries(bundle.items)) this.removeItem(p, id, n);
    // заглушённый жилец передаёт вещи молча — приписка была лазейкой мимо запрета
    const text = this.mutedFor(p) ? '' : sanitizeText(rawText, C.NOTES.maxLength);
    this.addDrop(p, check.door, { kind: 'parcel', bundle, text }, check.now);
    const what = this.bundleText(bundle);
    this.journal(p, `Вы оставили передачку у кв. ${check.door.number}: ${what}.`);
    this.markDeed(p, 'gift', `apt:${check.door.number}`);
    this.log(`${p.name} оставил передачку у кв. ${check.door.number}: ${what}`, 'trade', p.id);
    this.feed({ channel: 'note', to: check.door.number, from: { id: p.id, name: p.name, apt: p.apartment.number }, parcel: what, text });
    return { ok: true, message: 'Свёрток лежит у двери.' };
  }

  /** Хозяин забирает всё, что лежит у его двери. Возвращает строки описания. */
  collectDrops(p, { silent = false } = {}) {
    const drops = this.state.doorDrops[p.apartment.number] || [];
    if (!drops.length) return [];
    delete this.state.doorDrops[p.apartment.number];
    const lines = [];
    for (const d of drops) {
      const who = d.anon ? 'без подписи' : d.byZhek ? `от ${d.fromName}` : `от ${d.fromName} (кв. ${d.fromApt})`;
      if (d.kind === 'note') {
        lines.push(`Записка ${who}: «${d.text}»`);
      } else {
        for (const [id, n] of Object.entries(d.bundle.items)) this.addItem(p, id, n, (d.bundle.charges || {})[id] ?? 100);
        p.money += d.bundle.money;
        lines.push(`Передачка ${who}: ${this.bundleText(d.bundle)}${d.text ? `. Приписка: «${d.text}»` : ''}`);
      }
    }
    for (const l of lines) this.journal(p, l, 'good');
    if (!silent) this.notify([p], { title: 'Под дверью', text: lines.join('\n'), style: 'receipt', journal: false });
    this.dirty([p.id]);
    return lines;
  }

  /** Повесить свой листок на доску объявлений (у жильца — один листок на весь дом). */
  pinNote(p, rawText) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (this.mutedFor(p)) return { ok: false, error: `ЖЭК запретил вам писать ещё ${this.mutedFor(p)} мин.` };
    if (!this.nearTo(p, (o) => o.type === 'board')) return { ok: false, error: 'Подойдите к доске объявлений.' };
    const text = sanitizeText(rawText, C.NOTES.boardMaxLength);
    if (!text) return { ok: false, error: 'Пустой листок.' };
    const now = this.now();
    if (now - (p.lastDropAt || 0) < C.NOTES.cooldownMs) return { ok: false, error: 'Не так часто.' };
    p.lastDropAt = now;
    this.removePlayerNotes(p.id);
    const floor = p.location.floor;
    const board = (this.state.boardNotes[floor] = this.state.boardNotes[floor] || []);
    const note = { id: newId('b'), ts: now, playerId: p.id, name: p.name, apt: p.apartment.number, text };
    board.push(note);
    if (board.length > C.NOTES.perBoard) board.shift();
    this.journal(p, `Вы повесили листок на доску ${floor} этажа.`);
    this.feed({ channel: 'board', floor, noteId: note.id, from: { id: p.id, name: p.name, apt: p.apartment.number }, text });
    return { ok: true, message: 'Листок висит на доске.' };
  }

  unpinNote(p) {
    if (!this.removePlayerNotes(p.id)) return { ok: false, error: 'Вашего листка на досках нет.' };
    return { ok: true, message: 'Листок снят.' };
  }

  removePlayerNotes(playerId) {
    let removed = 0;
    for (const [floor, list] of Object.entries(this.state.boardNotes)) {
      const left = list.filter((n) => n.playerId !== playerId);
      removed += list.length - left.length;
      if (left.length) this.state.boardNotes[floor] = left;
      else delete this.state.boardNotes[floor];
    }
    return removed;
  }

  expireBoardNotes(now = this.now()) {
    const ttl = C.NOTES.boardTtlH * 3600 * 1000;
    for (const [floor, list] of Object.entries(this.state.boardNotes)) {
      const left = list.filter((n) => now - n.ts < ttl);
      if (left.length) this.state.boardNotes[floor] = left;
      else delete this.state.boardNotes[floor];
    }
  }

  // =========================================================================
  // Магазины: столовая и медпункт
  // =========================================================================
  shopEntries(shopId) {
    return (C.SHOPS[shopId] || []).map((e) => {
      const item = e.item ? C.ITEMS[e.item] : null;
      return { key: e.id || e.item, name: e.name || item.name, desc: item?.desc || '', ...e };
    });
  }

  buy(p, shopId, key) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (!C.SHOPS[shopId]) return { ok: false, error: 'Такого места нет.' };
    if (p.location.place !== shopId) return { ok: false, error: 'Вы не там.' };
    if (!this.nearTo(p, (o) => o.shop === shopId)) return { ok: false, error: shopId === 'canteen' ? 'Подойдите к раздаче.' : 'Подойдите к окошку фельдшера.' };
    const status = this.facilityStatus(shopId);
    if (!status.open) return { ok: false, error: status.reason };
    const entry = this.shopEntries(shopId).find((e) => e.key === key);
    if (!entry) return { ok: false, error: 'Этого нет в продаже.' };
    if (entry.hiddenIfStolen && this.world.cutleryStolen) return { ok: false, error: 'Ложек нет. Все украли.' };
    if (entry.needsSpoon && this.world.cutleryStolen && !this.hasItem(p, 'spoon')) {
      return { ok: false, error: 'В столовой украли ложки. Без своей ложки суп не съесть.' };
    }
    const stock = this.state.stock[shopId];
    if (entry.daily != null && !(stock[entry.key] > 0)) return { ok: false, error: `${entry.name} — кончилось. Завоз — в 0${B.supplyHour}:00.` };
    if (p.money < entry.price) return { ok: false, error: `Не хватает талонов (нужно ${entry.price}).` };
    p.money -= entry.price;
    if (entry.daily != null) stock[entry.key] -= 1;
    if (entry.eat) {
      if ((entry.effect || {}).hunger) this.tutorialStep(p, 'eat');
      this.applyStats(p, entry.effect || {});
      this.journal(p, `${entry.name} — за ${talons(entry.price)}.`);
    } else {
      this.addItem(p, entry.item, 1);
      this.journal(p, `Куплено: ${entry.name} за ${talons(entry.price)}.`);
    }
    return { ok: true };
  }

  // =========================================================================
  // Работа (мини-игры)
  // =========================================================================
  workStart(p, gameId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (this.world.paused) return { ok: false, error: 'Время в доме остановилось. Мастер ушёл.' };
    if (p.location.place !== 'factory') return { ok: false, error: 'Работа — в цеху.' };
    const status = this.facilityStatus('factory');
    if (!status.open) return { ok: false, error: status.reason };
    if (p.job) return { ok: false, error: 'Вы уже на смене.' };
    if (!MG.WORK_GAMES[gameId]) return { ok: false, error: 'Такой работы нет.' };
    if (!this.nearTo(p, (o) => o.type === 'station' && o.game === gameId)) return { ok: false, error: 'Подойдите к рабочему месту.' };
    if (this.hasBlock(p, 'work')) return { ok: false, error: 'С такой травмой мастер к станку не допустит.' };
    if (p.stats.energy < B.workEnergyCost) return { ok: false, error: 'Нет сил работать. Поспите.' };
    const hourAgo = this.now() - 3600 * 1000;
    p.shiftLog = (p.shiftLog || []).filter((t) => t > hourAgo);
    if (p.shiftLog.length >= B.shiftsPerHour) {
      const waitMin = Math.ceil((p.shiftLog[0] + 3600 * 1000 - this.now()) / 60000);
      return { ok: false, error: `Мастер: «Норму на этот час вы выработали. Приходите через ${waitMin} мин.»` };
    }
    p.shiftLog.push(this.now());
    const job = MG.createJob(gameId, this.rankOf(p, gameId));
    if (!job) return { ok: false, error: 'Такой работы нет.' };
    job.id = newId('j');
    job.startedAt = this.now();
    job.cost = { energy: B.workEnergyCost, hunger: B.workHungerCost };
    p.job = job;
    p.sleeping = false;
    this.applyStats(p, { energy: -B.workEnergyCost, hunger: -B.workHungerCost });
    return { ok: true, job: { id: job.id, game: job.game, data: job.publicData } };
  }

  workSubmit(p, jobId, rawAnswers) {
    const job = p.job;
    if (!job || job.id !== jobId) return { ok: false, error: 'Смена уже закрыта.' };
    p.job = null;
    const answers = Array.isArray(rawAnswers) ? rawAnswers.slice(0, 50).map((a) => (typeof a === 'number' ? a : String(a).slice(0, 20))) : [];
    const score = MG.scoreJob(job, answers, this.now() - job.startedAt);
    if (job.side) return this.sideJobFinish(p, job, score);
    if (job.repair) return this.repairFinish(p, job, score);
    let reward = MG.rewardFor(score);
    const notes = [];
    const hour = this.gameClock().hour;
    if (reward > 0 && (hour >= 22 || hour < 6)) {
      reward += 1;
      notes.push('ночная надбавка +1');
    }
    if (reward > 0 && p.conditions.some((c) => C.CONDITIONS[c.id]?.kind === 'disease')) {
      reward = Math.max(1, Math.floor(reward * 0.75));
      notes.push('больной работает хуже');
    }
    // трудовая книжка: опыт, разряд, надбавка за разряд
    const rankBefore = this.rankOf(p, job.game);
    p.skills = p.skills || {};
    p.skills[job.game] = (p.skills[job.game] || 0) + Math.round(score * 10);
    const rankAfter = this.rankOf(p, job.game);
    const rankBonus = reward > 0 ? Math.floor((rankBefore - 1) / 2) : 0;
    if (rankBonus) {
      reward += rankBonus;
      notes.push(`надбавка за разряд +${rankBonus}`);
    }
    if (rankAfter > rankBefore) {
      this.journal(p, `Мастер записал в трудовую книжку: ${MG.GAMES[job.game].name} — ${rankAfter} разряд. Платят больше, но и спрос строже.`, 'good');
      this.log(`${p.name}: ${MG.GAMES[job.game].name} — ${rankAfter} разряд`, 'social', p.id);
    }
    if (reward > 0) {
      this.world.shiftsToday = (this.world.shiftsToday || 0) + 1;
      this.assignmentShift(p);
      this.planShift(p);
    }
    this.tutorialStep(p, 'shift');
    p.money += reward;
    p.shifts = (p.shifts || 0) + 1;
    const pct = Math.round(score * 100);
    const text = reward
      ? `Смена «${MG.GAMES[job.game].name}»: качество ${pct}%. Начислено: ${talons(reward)}${notes.length ? ` (${notes.join(', ')})` : ''}.`
      : `Смена «${MG.GAMES[job.game].name}»: качество ${pct}%. Мастер записал брак — талонов нет.`;
    this.journal(p, text, reward ? 'good' : 'warn');
    return { ok: true, result: { score, reward, text } };
  }

  workCancel(p) {
    if (!p.job) return { ok: false, error: 'Вы не на смене.' };
    p.job = null;
    this.journal(p, 'Вы бросили смену. Силы потрачены зря.', 'warn');
    return { ok: true };
  }

  // =========================================================================
  // Чат
  // =========================================================================
  chat(p, channel, rawText) {
    if (!p.alive) return { ok: false, error: 'Мёртвые не разговаривают.' };
    if (this.mutedFor(p)) return { ok: false, error: `Вы сорвали голос. Говорить сможете через ${this.mutedFor(p)} мин.` };
    const text = sanitizeText(rawText, 300);
    if (!text) return { ok: false, error: 'Пустое сообщение.' };
    const now = this.now();
    if (now - (this.lastChatAt.get(p.id) || 0) < 700) return { ok: false, error: 'Не так быстро.' };
    this.lastChatAt.set(p.id, now);
    const msg = { id: newId('m'), ts: now, channel, from: { id: p.id, name: p.name, apt: p.apartment.number }, text };
    // «последние слова» — только сказанное вслух рядом (не в общий чат)
    if (channel !== 'global') p.lastSaid = { text, ts: now, id: msg.id, key: this.locationKey(p) };
    this.tutorialStep(p, 'talk');
    if (channel === 'global') {
      this.pushGlobal(msg);
    } else {
      msg.channel = 'local';
      msg.key = this.locationKey(p);
      msg.where = this.placeTitle(p);
      const list = this.localChat.get(msg.key) || [];
      list.push(msg);
      if (list.length > 30) list.shift();
      this.localChat.set(msg.key, list);
      // живое общение помогает не сойти с ума
      if (this.othersAt(p).length && now - (p.lastChatBonus || 0) > B.chatSanityCooldownMs) {
        p.lastChatBonus = now;
        this.applyStats(p, { sanity: B.chatSanityBonus });
      }
    }
    this.emit('chat', msg);
    return { ok: true };
  }

  chatHistory(p) {
    return { global: this.state.chatGlobal.slice(-50), local: (this.localChat.get(this.locationKey(p)) || []).slice() };
  }

  // =========================================================================
  // Обмен и подарки
  // =========================================================================
  normalizeBundle(raw) {
    const out = { money: Math.max(0, toInt(raw?.money)), items: {} };
    for (const [id, n] of Object.entries(raw?.items || {})) {
      const count = Math.max(0, toInt(n));
      if (C.ITEMS[id] && count > 0) out.items[id] = Math.min(count, 99);
    }
    return out;
  }

  bundleEmpty(b) {
    return !b.money && !Object.keys(b.items).length;
  }

  hasBundle(p, b) {
    if (p.money < b.money) return false;
    return Object.entries(b.items).every(([id, n]) => this.hasItem(p, id, n));
  }

  moveBundle(from, to, b) {
    from.money -= b.money;
    to.money += b.money;
    for (const [id, n] of Object.entries(b.items)) {
      const charge = this.chargeOf(from, id);
      this.removeItem(from, id, n);
      this.addItem(to, id, n, charge); // отработанный противогаз переходит с забитым фильтром
    }
  }

  bundleText(b) {
    const parts = [];
    if (b.money) parts.push(talons(b.money));
    // вещь могли убрать из палитры (или откат вернул старую) — показываем как есть, без падения
    for (const [id, n] of Object.entries(b.items || {})) parts.push(`${C.ITEMS[id]?.name || id}${n > 1 ? ` ×${n}` : ''}`);
    return parts.join(', ') || 'ничего';
  }

  tradeOffer(p, toId, rawGive, rawWant, credit = 0) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    const q = this.getPlayer(toId);
    if (!q || !q.alive || q.id === p.id) return { ok: false, error: 'Некому предлагать.' };
    if (!this.isOnline(q.id) || this.locationKey(q) !== this.locationKey(p)) return { ok: false, error: 'Этого жильца нет рядом.' };
    if (this.distance(p, q) > 3) return { ok: false, error: `Подойдите ближе к ${q.name}.` };
    const give = this.normalizeBundle(rawGive);
    const want = this.normalizeBundle(rawWant);
    if (this.bundleEmpty(give) && this.bundleEmpty(want)) return { ok: false, error: 'Пустой обмен.' };
    if (!this.hasBundle(p, give)) return { ok: false, error: 'У вас нет того, что вы предлагаете.' };

    if (this.bundleEmpty(want)) {
      const limit = this.newbieGiftCheck(p, give.money);
      if (limit) return { ok: false, error: limit };
      this.moveBundle(p, q, give);
      const what = this.bundleText(give);
      this.journal(p, `Вы отдали жильцу ${q.name}: ${what}.`);
      this.notify([q], { title: 'Подарок', text: `${p.name} (кв. ${p.apartment.number}) отдал вам: ${what}.`, style: 'good' });
      this.log(`${p.name} → ${q.name}: подарок (${what})${this.sameAddress(p, q)}`, 'trade', p.id);
      this.markDeed(p, 'gift', q.id);
      return { ok: true, gift: true };
    }

    const mine = Object.values(this.state.trades).filter((t) => t.from === p.id);
    if (mine.length >= 5) return { ok: false, error: 'Слишком много открытых предложений.' };
    // «в долг до дня N»: своё отдаю сейчас, ваше — по расписке
    const days = Math.max(0, Math.min(B.iouMaxDays, toInt(credit, 0)));
    if (days && this.bundleEmpty(give)) return { ok: false, error: 'В долг — это когда вы даёте сейчас, а вам отдают потом.' };
    const t = { id: newId('t'), from: p.id, to: q.id, give, want, createdAt: this.now(), credit: days || null };
    this.state.trades[t.id] = t;
    this.notify([q], {
      title: 'Предложение обмена',
      text: `${p.name} предлагает: ${this.bundleText(give)} — в обмен на: ${this.bundleText(want)}${days ? ` (в долг: отдать до дня ${this.gameDay() + days})` : ''}.`,
      style: 'trade',
      journal: false,
    });
    this.dirty([p.id]);
    return { ok: true, trade: t.id };
  }

  tradeRespond(p, tradeId, accept) {
    const t = this.state.trades[tradeId];
    if (!t || (t.to !== p.id && t.from !== p.id)) return { ok: false, error: 'Предложение уже неактуально.' };
    const a = this.getPlayer(t.from);
    const b = this.getPlayer(t.to);
    if (!accept) {
      delete this.state.trades[t.id];
      const other = p.id === a.id ? b : a;
      this.notify([other], { title: 'Обмен отменён', text: `${p.name} отказался от обмена.`, style: 'warn', journal: false });
      return { ok: true };
    }
    if (t.to !== p.id) return { ok: false, error: 'Принять может только второй участник.' };
    if (!a.alive || !this.isOnline(a.id) || this.locationKey(a) !== this.locationKey(b)) {
      return { ok: false, error: `${a.name} уже ушёл.` };
    }
    if (this.distance(a, b) > 3) return { ok: false, error: `Подойдите ближе к ${a.name}.` };
    if (!this.hasBundle(a, t.give)) return { ok: false, error: `У ${a.name} уже нет обещанного.` };
    // лимит новосёла: талоны сверх цены встречной части — тот же подарок; в долг — подарок целиком
    const overA = t.credit ? t.give.money || 0 : Math.min(t.give.money || 0, bundleWorth(t.give) - bundleWorth(t.want));
    const overB = t.credit ? 0 : Math.min(t.want.money || 0, bundleWorth(t.want) - bundleWorth(t.give));
    const limit = (overA > 0 && this.newbieGiftCheck(a, overA)) || (overB > 0 && this.newbieGiftCheck(b, overB));
    if (limit) return { ok: false, error: limit };
    if (t.credit) {
      // в долг: вещи переходят сейчас, а за b остаётся расписка
      this.moveBundle(a, b, t.give);
      delete this.state.trades[t.id];
      const iou = { id: newId('i'), debtorId: b.id, holderId: a.id, bundle: t.want, dueDay: this.gameDay() + t.credit, createdAt: this.now(), status: 'open' };
      this.state.ious.push(iou);
      const what = this.bundleText(t.want);
      this.journal(a, `В долг жильцу ${b.name}: ${this.bundleText(t.give)}. Расписка: вернуть ${what} до дня ${iou.dueDay}.`, 'good');
      this.journal(b, `Вы взяли в долг у ${a.name}: ${this.bundleText(t.give)}. Вернуть ${what} до дня ${iou.dueDay}.`, 'warn');
      this.notify([a], { title: 'Расписка', text: `Согласие от ${b.name}: долг вам — ${what} до дня ${iou.dueDay}.`, style: 'good', journal: false });
      this.log(`Расписка: ${b.name} должен ${a.name} ${what} до дня ${iou.dueDay} (взял ${this.bundleText(t.give)})${this.sameAddress(a, b)}`, 'trade', a.id);
      this.dirty([a.id, b.id]);
      return { ok: true };
    }
    if (!this.hasBundle(b, t.want)) return { ok: false, error: 'У вас нет того, что просят.' };
    this.moveBundle(a, b, t.give);
    this.moveBundle(b, a, t.want);
    delete this.state.trades[t.id];
    this.journal(a, `Обмен с ${b.name}: отдали ${this.bundleText(t.give)}, получили ${this.bundleText(t.want)}.`, 'good');
    this.journal(b, `Обмен с ${a.name}: отдали ${this.bundleText(t.want)}, получили ${this.bundleText(t.give)}.`, 'good');
    this.notify([a], { title: 'Обмен состоялся', text: `${b.name} принял ваше предложение.`, style: 'good', journal: false });
    this.log(`Обмен ${a.name} ⇄ ${b.name}: ${this.bundleText(t.give)} ⇄ ${this.bundleText(t.want)}${this.sameAddress(a, b)}`, 'trade', a.id);
    return { ok: true };
  }

  // =========================================================================
  // Смерть
  // =========================================================================
  kill(p, cause) {
    if (!p.alive) return;
    const wasTraveling = !!p.travel;
    p.alive = false;
    this.invalidatePlayers();
    p.deathCause = cause;
    p.diedAt = this.now();
    p.travel = null;
    p.job = null;
    p.sleeping = false;
    p.down = null;
    p.stats.health = 0;
    for (const t of Object.values(this.state.trades)) if (t.from === p.id || t.to === p.id) delete this.state.trades[t.id];
    this.journal(p, `Вы погибли. ${cause}.`, 'death');
    this.emit('notify', { to: [p.id], title: 'Вы погибли', text: cause, style: 'death' });
    this.pushOffline(p, { title: 'Вы погибли', body: `${p.name}: ${cause}. Квартира ${p.apartment.number} опечатана.`, tag: 'death', urgent: true });
    this.log(`☠ ${p.name} (кв. ${p.apartment.number}): ${cause}`, 'death', p.id, { public: `умер ${p.name} из кв. ${p.apartment.number}` });
    this.systemChat(`Квартира ${p.apartment.number} опечатана. Жилец ${p.name} больше не выйдет на смену.`);
    const refusal = this.refusals.get(p.id);
    if (refusal && cause === 'Погиб в тумане' && this.now() - refusal.ts < 5 * 60000 + B.downSec * 1000) {
      this.systemChat(
        refusal.kind === 'evicted'
          ? `${p.name} погиб в тумане. Незадолго до этого его выставили за дверь кв. ${refusal.apt}.`
          : `${p.name} погиб в тумане. Он стучал в кв. ${refusal.apt}, но ему не открыли.`,
      );
      this.log(`${p.name} погиб в тумане после того, как ${refusal.kind === 'evicted' ? 'его выставил' : 'ему не открыл'} ${refusal.owner}`, 'social', p.id);
      if (refusal.kind === 'ignored') {
        // молва — тому, кто не открыл, а не новому жильцу этой квартиры
        const o = this.getPlayer(refusal.ownerId);
        if (o && o.alive && o.apartment.number === refusal.apt) this.markDeed(o, 'cold');
      }
    }
    this.refusals.delete(p.id);
    // мел на полу, а рядом — последнее, что жилец успел сказать здесь же (за последние 10 минут)
    if (p.pos && !wasTraveling && !['lift', 'stairs'].includes(p.location.place)) {
      const key = this.locationKey(p);
      this.scar(key, 'chalk', p.pos.x, p.pos.y);
      const ls = p.lastSaid;
      if (ls && ls.key === key && this.now() - ls.ts < 10 * 60000) {
        const spot = this.freeScarSpot(key, p.pos);
        this.scar(key, 'lastword', spot.x, spot.y, { text: ls.text, by: p.name });
      }
    }
    p.lastSaid = null;
    // опасность «под ногами» в квартире погибшего не должна достаться следующему жильцу
    delete this.world.hazards[`home:${p.apartment.number}`];
    this.returnDrops(p.apartment.number, p.name);
    this.closeIousOf(p);
    this.evictAllGuests(p.apartment.number, p.apartment.floor);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
  }

  // =========================================================================
  // ======================  АДМИНКА — «СИМУЛЯТОР БОГА»  ======================
  // =========================================================================

  /**
   * Цель события:
   *   { type: 'all' }                       — все живые
   *   { type: 'online' }                    — все, кто сейчас в игре
   *   { type: 'floors', from, to }          — кто сейчас на этажах from..to
   *   { type: 'place', place }              — кто сейчас в столовой/цеху/…
   *   { type: 'player', id }                — конкретный жилец
   *   { type: 'random', count, online }     — N случайных
   */
  resolveTargets(target = {}) {
    const alive = this.alivePlayers();
    switch (target.type) {
      case 'online':
        return alive.filter((p) => this.isOnline(p.id));
      case 'floors': {
        const from = toInt(target.from);
        const to = toInt(target.to, from);
        return alive.filter((p) => p.location.floor >= Math.min(from, to) && p.location.floor <= Math.max(from, to));
      }
      case 'place':
        return alive.filter((p) => p.location.place === target.place);
      case 'player': {
        const p = this.getPlayer(target.id);
        return p && p.alive ? [p] : [];
      }
      case 'homeFloors': {
        // по этажу квартиры, а не по тому, где жилец сейчас
        const from = toInt(target.from);
        const to = toInt(target.to, from);
        return alive.filter((p) => p.apartment.floor >= Math.min(from, to) && p.apartment.floor <= Math.max(from, to));
      }
      case 'assignmentDone':
      case 'assignmentFailed': {
        const a = this.state.assignments.find((x) => x.id === target.id);
        if (!a) return [];
        const inRange = alive.filter((p) => p.apartment.floor >= a.from && p.apartment.floor <= a.to);
        return inRange.filter((p) => !!a.done[p.apartment.number] === (target.type === 'assignmentDone'));
      }
      case 'ids': {
        const ids = new Set((Array.isArray(target.ids) ? target.ids : []).map(String));
        return alive.filter((p) => ids.has(p.id));
      }
      case 'hasFurniture':
        return alive.filter((p) => (p.furniture || {})[target.item]);
      case 'techVisitors': {
        // кто спускался на технические этажи за последний час
        const since = this.now() - 3600 * 1000;
        return alive.filter((p) => (p.techVisits || []).some((x) => x.ts > since));
      }
      case 'barygaClients': {
        const since = this.now() - 24 * 3600 * 1000;
        return alive.filter((p) => (this.world.barygaClients[p.id] || 0) > since);
      }
      case 'debtors': {
        // долг за квартиру или просроченная расписка
        const ids = new Set(this.state.ious.filter((x) => this.iouOverdue(x)).map((x) => x.debtorId));
        return alive.filter((p) => ids.has(p.id) || p.rentDebt > 0);
      }
      case 'elders':
        return Object.keys(this.state.elders).map((f) => this.elderOf(Number(f))).filter(Boolean);
      case 'petitionSigners': {
        const pet = this.state.petitions.find((x) => x.id === target.id);
        const ids = new Set(pet ? pet.signers.map((x) => x.id) : []);
        return alive.filter((p) => ids.has(p.id));
      }
      case 'generous':
      case 'stingy': {
        // щедрые — по молве за сутки; скупые — кто ничего не делал для соседей, а талоны есть
        const pool = alive.filter((p) => !this.isNewbie(p));
        const n = Math.max(1, toInt(target.count, 3));
        if (target.type === 'generous') return pool.filter((p) => this.goodness(p) > 0).sort((a, b) => this.goodness(b) - this.goodness(a)).slice(0, n);
        return pool.sort((a, b) => this.goodness(a) - this.goodness(b) || b.money - a.money).slice(0, n);
      }
      case 'random': {
        const pool = target.online ? alive.filter((p) => this.isOnline(p.id)) : alive.slice();
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(0, Math.max(1, toInt(target.count, 1)));
      }
      case 'all':
      default:
        return alive;
    }
  }

  /** Применить эффект к жильцу. Возвращает список изменений текстом. */
  /** Отметить, что беда от ЖЭК досталась жильцу (для счётчика «бед за час» в Пульте). */
  markHarm(p) {
    const now = this.now();
    p.harmLog = [...(p.harmLog || []).filter((t) => now - t < 3600 * 1000), now].slice(-50);
  }

  applyEffect(p, effect = {}, cause = 'Несчастный случай') {
    if (Number(effect.health) < 0 || Number(effect.sanity) < 0 || effect.condition || effect.kill || effect.money === 'all' || Number(effect.money) < 0) this.markHarm(p);
    const parts = [];
    for (const k of STAT_KEYS) {
      const v = Number(effect[k]);
      if (!v) continue;
      p.stats[k] = clamp(p.stats[k] + v);
      parts.push(`${STAT_NAMES[k]} ${v > 0 ? '+' : ''}${v}`);
      if (k === 'health' && v < 0) p.lastHarm = cause;
    }
    if (effect.money === 'all') {
      if (p.money) parts.push(`−${talons(p.money)}`);
      p.money = 0;
    } else if (Number(effect.money)) {
      const v = toInt(effect.money);
      p.money = Math.max(0, p.money + v);
      parts.push(`${v > 0 ? '+' : '−'}${talons(Math.abs(v))}`);
    }
    for (const [id, nRaw] of Object.entries(effect.items || {})) {
      const n = toInt(nRaw);
      if (!C.ITEMS[id] || !n) continue;
      if (n > 0) {
        this.addItem(p, id, n);
        parts.push(`${C.ITEMS[id].name} +${n}`);
      } else {
        const removed = this.removeItem(p, id, -n);
        if (removed) parts.push(`${C.ITEMS[id].name} −${removed}`);
      }
    }
    if (effect.cure) {
      this.cureCondition(p, effect.cure);
      parts.push('исцеление');
    }
    if (effect.condition && C.CONDITIONS[effect.condition]) {
      this.addCondition(p, effect.condition, { silent: true });
      parts.push(C.CONDITIONS[effect.condition].name);
    }
    if (effect.kill) this.kill(p, cause);
    else if (p.stats.health <= 0) this.fall(p, cause);
    else if (p.down && (Number(effect.health) > 0 || effect.cure)) this.wake(p); // бог подлечил лежачего — приходит в себя
    this.dirty([p.id]);
    return parts;
  }

  /** Точка входа для всех команд админки. */
  /**
   * Команда Пульта. ctx — кто нажал { who, role }: роль ограничивает команды, всё пишется в журнал богов,
   * а перед опасными командами мир сохраняется в снимок (можно откатить).
   */
  admin(cmd, args = {}, ctx = { who: 'система', role: 'god' }) {
    const fn = ADMIN_COMMANDS[cmd];
    if (!fn) return { ok: false, error: `Неизвестная команда: ${cmd}` };
    const role = ctx.role || 'god';
    if (role !== 'god' && !(ROLE_COMMANDS[role] || []).includes(cmd)) {
      this.godLogDenied(ctx.who, cmd);
      return { ok: false, error: `Роль «${ROLE_NAMES[role] || role}» не может это делать.` };
    }
    // снимок перед опасной командой попадает в кольцо, только если команда удалась: неудачные
    // и отклонённые не вытесняют точки отката
    const danger = this.dangerLabel(cmd, args);
    const pending = danger ? this.makeSnapshot(danger, ctx.who) : null;
    let res;
    this.invalidatePlayers(); // команда ЖЭК может поменять кого угодно — кеш строим заново
    try {
      res = fn.call(this, args, ctx) || { ok: true };
    } catch (err) {
      res = { ok: false, error: err.message };
    } finally {
      this.invalidatePlayers();
    }
    if (pending && res.ok) this.commitSnapshot(pending);
    if (!QUIET_COMMANDS.includes(cmd)) this.godLogAdd(ctx.who, cmd, args, res);
    return res;
  }

  /**
   * Отказ по роли: подряд идущие отказы одного и того же схлопываются в одну запись со счётчиком —
   * спамом запрещённых команд журнал богов не затереть.
   */
  godLogDenied(who, cmd) {
    const last = this.state.godLog[this.state.godLog.length - 1];
    const now = this.now();
    if (last && last.denied && last.who === (who || 'система') && now - last.ts < 10 * 60000) {
      last.count = (last.count || 1) + 1;
      last.ts = now;
      if (!last.cmds.includes(cmd) && last.cmds.length < 10) last.cmds.push(cmd);
      last.args = `запрещённых команд: ${last.count} (${last.cmds.join(', ')})`;
      return;
    }
    this.godLogAdd(who, cmd, {}, { ok: false, error: 'нет прав' });
    const entry = this.state.godLog[this.state.godLog.length - 1];
    entry.denied = true;
    entry.count = 1;
    entry.cmds = [cmd];
  }

  godLogAdd(who, cmd, args, res) {
    let text;
    try {
      // пароли в журнал не пишем
      text = JSON.stringify(args, (k, v) => (/pass/i.test(k) ? '***' : v));
    } catch {
      text = '';
    }
    const entry = { ts: this.now(), clock: this.gameClock().label, who: who || 'система', cmd, args: text.length > 300 ? `${text.slice(0, 300)}…` : text, ok: !!res.ok, error: res.ok ? null : res.error || null };
    this.state.godLog.push(entry);
    if (this.state.godLog.length > 3000) this.state.godLog.splice(0, this.state.godLog.length - 3000);
    this.emit('godlog', entry);
  }

  /** Опасна ли команда — тогда перед ней снимок мира. Возвращает подпись снимка или null. */
  dangerLabel(cmd, a = {}) {
    const t = a.target && a.target.type;
    const mass = t && t !== 'player';
    switch (cmd) {
      case 'kill': return 'перед убийством жильца';
      case 'erase': return 'перед стиранием жильца';
      case 'revive': return 'перед воскрешением';
      case 'custom': return a.effect && a.effect.kill ? 'перед смертельным событием' : mass ? 'перед массовым событием' : null;
      case 'accident':
      case 'infect': return mass && !a.id ? `перед массовым: ${cmd === 'accident' ? 'несчастный случай' : 'болезнь'}` : null;
      case 'fog': return Math.abs(toInt(a.to) - toInt(a.from)) >= 5 || Number(a.intensity) >= 2 ? 'перед большим туманом' : null;
      case 'paletteRemove': return 'перед удалением из палитры';
      case 'barygaRaid': return 'перед облавой';
      case 'petitionResolve': return a.verdict === 'punished' ? 'перед наказанием подписавших' : null;
      default: return null;
    }
  }

  // =========================================================================
  // Снимки мира и откат
  // =========================================================================
  /** Что откатывается: жильцы и мир. Журналы, паспорта и учётки богов — нет. */
  snapshotData() {
    const st = this.state;
    return JSON.stringify({
      players: st.players, world: st.world, doors: st.doors, doorDrops: st.doorDrops, boardNotes: st.boardNotes, trades: st.trades,
      ious: st.ious, assignments: st.assignments, petitions: st.petitions, elders: st.elders, stock: st.stock, archive: st.archive, schedule: st.schedule,
    });
  }

  takeSnapshot(label, who) {
    return this.commitSnapshot(this.makeSnapshot(label, who));
  }

  /** Собрать снимок (ещё не в кольце): перед опасной командой — а сохранить, только если она удалась. */
  makeSnapshot(label, who) {
    return { id: newId('w'), ts: this.now(), clock: this.gameClock().label, label: label || 'снимок', who: who || 'система', data: this.snapshotData() };
  }

  commitSnapshot(snap) {
    this.snapshots.push(snap);
    while (this.snapshots.length > 8) this.snapshots.shift();
    this.emit('snapshot_taken', snap);
    return snap;
  }

  snapshotsMeta() {
    return this.snapshots.map((x) => ({ id: x.id, ts: x.ts, clock: x.clock, label: x.label, who: x.who, size: x.data.length }));
  }

  /** Проверить пароль бога (личная учётка). */
  async verifyAdminAsync(login, password) {
    const key = String(login || '').trim().toLowerCase();
    const acc = Object.hasOwn(this.state.admins, key) ? this.state.admins[key] : null;
    if (!password || String(password).length > 200) return null;
    const given = Buffer.from(await Game.hashPasswordAsync(password, acc ? acc.salt : '00000000000000000000000000000000'), 'hex');
    if (!acc) return null;
    // пока считался пароль, учётку могли удалить или сменить ей пароль — пускаем только по нынешней
    const fresh = Object.hasOwn(this.state.admins, key) ? this.state.admins[key] : null;
    if (!fresh || fresh.hash !== acc.hash) return null;
    const expected = Buffer.from(acc.hash, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? fresh : null;
  }

  requirePlayer(id, { alive = true } = {}) {
    const p = this.getPlayer(id);
    if (!p) throw new Error('Жилец не найден');
    if (alive && !p.alive) throw new Error('Жилец мёртв');
    return p;
  }

  // ---- туман ----
  startFog({ from, to, warnSec = 30, durationMin = 3, intensity = 1 } = {}) {
    if (this.world.fog) this.endFog(true);
    const a = toInt(from, C.BUILDING.firstResidentialFloor);
    const b = toInt(to, a);
    const now = this.timerNow();
    this.world.fog = {
      from: Math.min(a, b),
      to: Math.max(a, b),
      warnUntil: now + Math.max(0, Number(warnSec) || 0) * 1000,
      until: now + Math.max(0, Number(warnSec) || 0) * 1000 + Math.max(0.1, Number(durationMin) || 1) * 60000,
      intensity: Math.max(0.1, Math.min(5, Number(intensity) || 1)),
      arrived: false,
    };
    const f = this.world.fog;
    const onFloors = this.alivePlayers().filter((p) => p.location.floor >= f.from && p.location.floor <= f.to);
    const elsewhere = this.alivePlayers().filter((p) => !onFloors.includes(p));
    this.notify(onFloors, {
      title: 'СИРЕНА',
      text: `Туман идёт на этажи ${f.from}–${f.to}! До прихода ${Math.round(warnSec)} с. Домой, задраить гермодверь!`,
      style: 'siren',
      push: false,
    });
    // кто не в игре — получает пуш о своей двери: зайти и задраить можно успеть
    for (const p of onFloors) {
      const home = p.location.place === 'home' && this.currentApt(p) === p.apartment.number;
      const sealed = home && this.doorSealed(p.apartment.number);
      const inSec = Math.round(warnSec);
      this.pushOffline(p, {
        title: 'СИРЕНА',
        body: sealed
          ? `Туман идёт на ваш ${p.location.floor} этаж${inSec ? ` через ${inSec} с` : ''}. Гермодверь задраена.`
          : home
            ? `На ваш ${p.location.floor} этаж идёт туман${inSec ? ` через ${inSec} с` : ''}, а дверь квартиры открыта!`
            : `Туман идёт на ${p.location.floor} этаж, а вы не дома${inSec ? `: до прихода ${inSec} с` : ''}.`,
        tag: 'fog',
        urgent: !sealed,
      });
    }
    this.notify(elsewhere, { title: 'Сирена', text: `Где-то воет сирена: туман на этажах ${f.from}–${f.to}.`, style: 'warn' });
    this.systemChat(`ВНИМАНИЕ! Туман на этажах ${f.from}–${f.to}. Жильцам немедленно укрыться в квартирах.`);
    this.log(`Объявлен туман: этажи ${f.from}–${f.to}, сила ${f.intensity}, ${durationMin} мин`, 'event', null, { public: `туман на этажах ${f.from}–${f.to}` });
    // сирена 0 с — туман сразу (только приход: расписание и прочие таймеры отсюда не трогаем)
    if (f.warnUntil <= now) this.fogArrive();
    return { ok: true };
  }

  /** Сирена отвыла — туман пришёл. */
  fogArrive() {
    const f = this.world.fog;
    if (!f || f.arrived) return;
    f.arrived = true;
    this.fogWindows(f);
    const victims = this.alivePlayers().filter((p) => p.location.floor >= f.from && p.location.floor <= f.to);
    this.notify(victims, {
      title: 'ТУМАН',
      text: 'Туман пришёл на ваш этаж. Если вы не за закрытой гермодверью — бегите.',
      style: 'fog',
    });
    this.log(`Туман накрыл этажи ${f.from}–${f.to}`, 'event');
  }

  endFog(silent = false) {
    if (!this.world.fog) return { ok: false, error: 'Тумана нет.' };
    const f = this.world.fog;
    this.world.fog = null;
    if (f.arrived) this.fogScars(f);
    if (!silent) this.evictOrphanGuests(); // при замене тумана новым — гости остаются внутри
    if (!silent) {
      this.notify(this.alivePlayers(), { title: 'Отбой', text: `Туман на этажах ${f.from}–${f.to} рассеялся.`, style: 'good' });
      this.systemChat(`Отбой тревоги. Туман на этажах ${f.from}–${f.to} рассеялся.`);
    }
    this.log(`Туман на этажах ${f.from}–${f.to} закончился`, 'event', null, { public: `туман на этажах ${f.from}–${f.to} рассеялся` });
    return { ok: true };
  }

  // ---- поломки ----
  setBreakdown(key, broken, { durationMin, reason } = {}) {
    if (!C.BREAKDOWNS[key]) throw new Error('Нет такого оборудования');
    const def = C.BREAKDOWNS[key];
    if (broken) {
      const until = Number(durationMin) > 0 ? this.timerNow() + Number(durationMin) * 60000 : null;
      const text = sanitizeText(reason, 200) || def.brokenText;
      this.world.breakdowns[key] = { since: this.timerNow(), until, reason: text };
      if (key === 'factory') {
        // срывается только работа в цеху: подработка в столовой и наряд на лифте идут дальше
        const workers = this.alivePlayers().filter((p) => p.job && !p.job.side && (!p.job.repair || p.job.repair === 'factory'));
        for (const p of workers) p.job = null;
        this.notify(workers, { title: 'Авария в цеху', text: 'Линия встала. Смена сорвана.', style: 'warn' });
      }
      this.notify(this.alivePlayers(), { title: `Поломка: ${def.name}`, text, style: 'warn' });
      this.log(`Сломано: ${def.name}${until ? ` (на ${durationMin} мин)` : ''} — ${text}`, 'event', null, { public: `сломано: ${def.name.toLowerCase()}` });
    } else {
      if (!this.world.breakdowns[key]) return { ok: false, error: 'Это и так работает.' };
      this.world.breakdowns[key] = null;
      this.notify(this.alivePlayers(), { title: 'Починили', text: `${def.name} снова работает.`, style: 'good' });
      this.log(`Починено: ${def.name}`, 'event', null, { public: `починили: ${def.name.toLowerCase()}` });
    }
    return { ok: true };
  }

  cutPower({ from, to, durationMin } = {}) {
    const a = toInt(from, C.BUILDING.firstResidentialFloor);
    const b = toInt(to, a);
    const until = Number(durationMin) > 0 ? this.timerNow() + Number(durationMin) * 60000 : null;
    this.world.power = { from: Math.min(a, b), to: Math.max(a, b), until };
    const pw = this.world.power;
    const victims = this.alivePlayers().filter((p) => p.location.floor >= pw.from && p.location.floor <= pw.to);
    this.notify(victims, { title: 'Свет погас', text: 'Лампы мигнули и потухли. Темнота давит на рассудок. Фонарик бы...', style: 'warn' });
    this.log(`Отключён свет на этажах ${pw.from}–${pw.to}`, 'event', null, { public: `нет света на этажах ${pw.from}–${pw.to}` });
    return { ok: true };
  }

  restorePower() {
    const pw = this.world.power;
    if (!pw) return { ok: false, error: 'Свет и так есть.' };
    this.world.power = null;
    const lit = this.alivePlayers().filter((p) => p.location.floor >= pw.from && p.location.floor <= pw.to);
    this.notify(lit, { title: 'Свет дали', text: 'Лампы загудели снова.', style: 'good' });
    this.log(`Свет восстановлен на этажах ${pw.from}–${pw.to}`, 'event', null, { public: `свет на этажах ${pw.from}–${pw.to} дали` });
    return { ok: true };
  }

  // ---- столовые приборы ----
  stealCutlery({ percent = 30 } = {}) {
    this.world.cutleryStolen = true;
    const share = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    const owners = this.alivePlayers().filter((p) => this.hasItem(p, 'spoon') || this.hasItem(p, 'fork'));
    const victims = owners.filter(() => this.random() < share);
    for (const p of victims) {
      this.removeItem(p, 'spoon', 999);
      this.removeItem(p, 'fork', 999);
    }
    this.notify(victims, { title: 'Пропажа', text: 'Вы обнаружили, что ваши ложки и вилки исчезли.', style: 'warn' });
    this.systemChat('В Столовой №3 украдены все столовые приборы. Суп выдаётся только жильцам со своей ложкой.');
    this.log(`Украдены столовые приборы. Пострадали жильцы: ${victims.map((p) => p.name).join(', ') || 'никто'}`, 'event', null, { public: 'в столовой украли ложки' });
    return { ok: true };
  }

  returnCutlery() {
    this.world.cutleryStolen = false;
    this.systemChat('Столовая №3 получила новую партию ложек. Приятного аппетита.');
    this.log('Ложки в столовой вернули', 'event', null, { public: 'в столовую вернули ложки' });
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Команды админки. this — экземпляр Game.
// ---------------------------------------------------------------------------
const PALETTE_TYPES = ['conditions', 'accidents', 'items'];
// Что можно ставить шагом сценария (без опасного: убийства, стирания, отката, учёток)
const SCENARIO_CMDS = ['announce', 'whisper', 'custom', 'fog', 'fogEnd', 'radio', 'radioSilence', 'sound', 'infect', 'accident', 'aid', 'breakdown', 'power', 'hazard', 'hazardClear', 'climate', 'climateClear', 'objectVoice', 'ask', 'lamps', 'supply', 'cutlery', 'assign', 'puppetSay'];

// Вещи с зарядом: заряд хранится у жильца (одна такая вещь на человека имеет смысл), но переходит с вещью
const CHARGE_KEYS = Object.assign(Object.create(null), { gasmask: 'gasmaskCharge', flashlight: 'flashCharge' });

// Роли богов: «модератор» следит за порядком, «наблюдатель» только смотрит. «Бог» может всё.
const ROLE_NAMES = { god: 'бог', moderator: 'модератор', observer: 'наблюдатель' };
const ROLE_COMMANDS = {
  moderator: ['mute', 'unmute', 'ban', 'unban', 'deleteMessage', 'unpin', 'rename', 'dropsClear', 'petitionResolve', 'chat', 'announce', 'whisper', 'plantNote', 'rentForgive'],
  observer: [],
};
// Частые команды-движения не засоряют журнал богов
const QUIET_COMMANDS = ['puppetMove'];

const ADMIN_COMMANDS = {
  pause({ paused }) {
    const w = this.world;
    if (!!paused === !!w.paused) return { ok: true };
    if (paused) {
      w.pausedAt = this.now();
    } else if (w.pausedAt) {
      // всё, что тикало по часам (туман, поломки, болезни, расписание…), продолжается с того же места
      this.shiftTimers(this.now() - w.pausedAt);
      w.pausedAt = null;
    }
    w.paused = !!paused;
    this.log(paused ? 'Мир поставлен на паузу' : 'Мир снят с паузы', 'admin');
  },

  /**
   * Запланировать любую команду Пульта.
   *   mode: 'in'     — через value реальных минут
   *         'at'     — в игровое время value ('ЧЧ:ММ')
   *         'window' — в случайный момент в ближайшие value минут
   *   repeat: 'none' | 'every' (каждые repeatMin минут) | 'daily' (каждые игровые сутки)
   */
  schedule({ cmd, args = {}, label, mode = 'in', value, repeat = 'none', repeatMin }) {
    if (!ADMIN_COMMANDS[cmd] || ['schedule', 'unschedule', 'pause', 'erase', 'restoreHouse', 'restorePlayer', 'adminAdd', 'adminRemove', 'snapshot', 'scenarioSave', 'scenarioDelete'].includes(cmd)) throw new Error('Эту команду нельзя поставить в расписание');
    const now = this.timerNow();
    const gameMinMs = 1000; // каждый тик добавляет tickMs/1000 игровых минут: 1 игровая минута = 1 реальная секунда
    let at;
    if (mode === 'at') {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Время — в виде ЧЧ:ММ, например 02:00');
      const target = Number(m[1]) * 60 + Number(m[2]);
      const cur = Math.floor(this.world.gameMinutes) % 1440;
      const until = (target - cur + 1440) % 1440 || 1440;
      at = now + until * gameMinMs;
    } else {
      const min = Number(value);
      if (!Number.isFinite(min) || min < 0 || min > 7 * 24 * 60) throw new Error('Минуты — от 0 до недели');
      at = now + (mode === 'window' ? this.random() * min : min) * 60000;
    }
    let repeatMs = null;
    if (repeat === 'every') {
      const r = Number(repeatMin);
      if (!Number.isFinite(r) || r < 1) throw new Error('Повтор — не чаще раза в минуту');
      repeatMs = r * 60000;
    } else if (repeat === 'daily') {
      repeatMs = 1440 * gameMinMs;
    }
    const entry = {
      id: newId('s'),
      cmd,
      args: JSON.parse(JSON.stringify(args || {})),
      label: sanitizeText(label, 80) || cmd,
      at: Math.round(at),
      repeatMs,
      createdAt: now,
      runs: 0,
    };
    this.state.schedule.push(entry);
    this.log(`Запланировано: ${entry.label}${repeatMs ? ' (с повтором)' : ''}`, 'admin');
    return { ok: true, message: `Запланировано: ${entry.label} — через ${fmtDuration(entry.at - now)}`, id: entry.id };
  },

  unschedule({ id }) {
    const e = this.state.schedule.find((x) => x.id === id);
    if (!e) throw new Error('Такого в расписании нет');
    this.state.schedule = this.state.schedule.filter((x) => x !== e);
    this.log(`Снято с расписания: ${e.label}`, 'admin');
    return { ok: true, message: 'Снято с расписания' };
  },

  // ---- воздействие на конкретного жильца ----
  setStats({ id, stats = {} }) {
    const p = this.requirePlayer(id);
    for (const k of STAT_KEYS) if (stats[k] !== undefined && stats[k] !== '') p.stats[k] = clamp(Number(stats[k]) || 0);
    if (stats.money !== undefined && stats.money !== '') p.money = Math.max(0, toInt(stats.money));
    if (p.down && p.stats.health > 0) this.wake(p);
    this.log(`Параметры ${p.name} изменены вручную`, 'admin', p.id);
    if (p.stats.health <= 0) this.kill(p, 'Умер при невыясненных обстоятельствах');
    this.dirty([p.id]);
  },

  /** Несчастный случай: { id } — с одним жильцом, или { target } — с группой. */
  accident({ id, target, accident }) {
    const acc = C.ACCIDENTS[accident];
    if (!acc) throw new Error('Нет такого несчастного случая');
    const victims = id ? [this.requirePlayer(id)] : this.resolveTargets(target);
    for (const p of victims) {
      this.accidentScar(p, accident);
      this.notify([p], { title: acc.name, text: acc.text, style: 'danger' });
      const parts = this.applyEffect(p, { ...acc.effect, condition: acc.condition }, acc.name);
      this.log(`Несчастный случай с ${p.name}: ${acc.name} (${parts.join(', ') || '—'})`, 'accident', p.id);
    }
    return { ok: true, message: `Пострадало жильцов: ${victims.length}` };
  },

  infect({ target, condition, silent }) {
    const def = C.CONDITIONS[condition];
    if (!def) throw new Error('Нет такой болезни/травмы');
    const victims = this.resolveTargets(target);
    for (const p of victims) {
      this.markHarm(p);
      this.addCondition(p, condition, { silent: true });
      if (!silent) this.notify([p], { title: 'Самочувствие', text: `Вам нехорошо: ${def.name}.`, style: 'danger' });
    }
    this.log(`${def.name}: ${victims.map((p) => p.name).join(', ') || 'никто'}`, 'disease');
    return { ok: true, message: `Затронуто жильцов: ${victims.length}` };
  },

  cure({ id, condition = 'all' }) {
    const p = this.requirePlayer(id);
    this.cureCondition(p, condition);
    this.journal(p, 'Вам вдруг стало легче.', 'good');
    this.log(`${p.name} исцелён (${condition === 'all' ? 'всё' : C.CONDITIONS[condition]?.name})`, 'admin', p.id);
    this.dirty([p.id]);
  },

  give({ id, item, count = 1, silent }) {
    const p = this.requirePlayer(id);
    const n = toInt(count, 1);
    const parts = this.applyEffect(p, { items: { [item]: n } });
    if (!silent && parts.length) {
      this.notify([p], {
        title: n > 0 ? 'Находка' : 'Пропажа',
        text: n > 0 ? `Вы нашли: ${C.ITEMS[item].name} ×${n}.` : `У вас пропало: ${C.ITEMS[item].name}.`,
        style: n > 0 ? 'good' : 'warn',
      });
    }
    this.log(`${p.name}: ${parts.join(', ')}`, 'admin', p.id);
  },

  money({ id, delta, silent }) {
    const p = this.requirePlayer(id);
    const parts = this.applyEffect(p, { money: toInt(delta) });
    if (!silent && parts.length) this.notify([p], { title: 'Талоны', text: parts.join(', '), style: toInt(delta) > 0 ? 'good' : 'warn' });
    this.log(`${p.name}: ${parts.join(', ')}`, 'admin', p.id);
  },

  kill({ id, cause }) {
    const p = this.requirePlayer(id);
    this.kill(p, sanitizeText(cause, 120) || 'Умер при невыясненных обстоятельствах');
  },

  revive({ id }) {
    const p = this.requirePlayer(id, { alive: false });
    if (p.alive) throw new Error('Жилец и так жив');
    const acc = p.account ? this.state.accounts[p.account] : null;
    const heir = acc ? this.accountPlayer(acc) : null;
    if (heir) throw new Error(`По этому паспорту уже живёт ${heir.name}. Двух живых на одном паспорте не бывает`);
    if (this.alivePlayers().some((q) => q.apartment.number === p.apartment.number)) {
      const apt = this.allocateApartment();
      if (!apt) throw new Error('Дом переполнен — некуда вернуть жильца');
      p.apartment = apt;
    }
    p.name = this.freeName(p.name, p.id);
    p.alive = true;
    this.invalidatePlayers();
    p.deathCause = null;
    p.diedAt = null;
    p.conditions = [];
    p.stats = { health: 50, hunger: 50, energy: 50, sanity: 40 };
    p.travel = null;
    this.relocate(p, { place: 'home', floor: p.apartment.floor, apt: p.apartment.number }, 'bed');
    this.notify([p], { title: 'Вы очнулись', text: `Вы лежите у себя в кв. ${p.apartment.number}. Вы не помните, как здесь оказались.`, style: 'whisper' });
    this.log(`${p.name} воскрешён`, 'admin', p.id);
    this.systemChat(`Жилец ${p.name} снова замечен в коридорах. Не задавайте ему вопросов.`);
  },

  teleport({ id, place, floor }) {
    const p = this.requirePlayer(id);
    if (!MOVE_PLACES.includes(place)) throw new Error('Нет такого места');
    let f = toInt(floor, p.location.floor);
    if (place === 'home') f = p.apartment.floor;
    else if (place !== 'corridor') f = C.FACILITIES[place].floor;
    p.travel = null;
    p.job = null;
    p.sleeping = false;
    this.relocate(p, { place, floor: f, apt: p.apartment.number });
    this.notify([p], { title: 'Провал в памяти', text: `Вы моргнули — и оказались здесь: ${this.placeTitle(p)}.`, style: 'whisper' });
    this.log(`${p.name} перемещён: ${this.placeTitle(p)}`, 'admin', p.id);
  },

  whisper({ target, text, from = 'Голос за стеной' }) {
    const msg = sanitizeText(text, 500);
    if (!msg) throw new Error('Пустое сообщение');
    const victims = this.resolveTargets(target);
    this.notify(victims, { title: sanitizeText(from, 60) || 'Голос', text: msg, style: 'whisper' });
    this.log(`Шёпот (${victims.map((p) => p.name).join(', ')}): ${msg}`, 'admin');
    return { ok: true, message: `Услышали: ${victims.length}` };
  },

  erase({ id }) {
    const p = this.requirePlayer(id, { alive: false });
    delete this.state.players[p.id];
    this.invalidatePlayers();
    this.byToken.delete(p.token);
    this.onlineSet.delete(p.id);
    this.log(`Жилец ${p.name} стёрт из домовой книги`, 'admin');
  },

  /** Дилемма: вопрос жильцам с 2–3 вариантами. Ответы приходят в журнал Пульта (фильтр «Ответы»). */
  ask({ target, question, options, timeoutMin = 5, from = 'ЖЭК' }) {
    const q = sanitizeText(question, 300);
    const opts = (Array.isArray(options) ? options : String(options || '').split('\n')).map((o) => sanitizeText(o, 60)).filter(Boolean).slice(0, 3);
    if (!q || opts.length < 2) throw new Error('Нужен вопрос и хотя бы два варианта ответа');
    const victims = this.resolveTargets(target);
    const now = this.now();
    for (const p of victims) {
      const askObj = { id: newId('a'), question: q, options: opts, from: sanitizeText(from, 40) || 'ЖЭК', until: now + Math.max(1, Number(timeoutMin) || 5) * 60000 };
      p.asks = [...(p.asks || []).filter((a) => a.until > now), askObj].slice(-3);
      this.notify([p], { title: askObj.from, text: q, style: 'ask', journal: true, ask: askObj });
    }
    this.log(`Дилемма «${q}» → ${victims.map((p) => p.name).join(', ') || 'никто'}`, 'admin');
    return { ok: true, message: `Спросили: ${victims.length}` };
  },

  /** Своя палитра: новая болезнь/травма, несчастный случай или предмет — без правки кода и перезапуска. */
  paletteAdd({ type, def }) {
    if (!PALETTE_TYPES.includes(type)) throw new Error('Нет такого раздела палитры');
    const clean = this.cleanPaletteDef(type, def);
    const pal = this.state.palette;
    if (Object.keys(pal[type]).length >= 50) throw new Error('В этом разделе палитры уже 50 записей');
    const id = `x${type[0]}_${crypto.randomBytes(3).toString('hex')}`;
    pal[type][id] = clean;
    this.applyPalette();
    this.emit('content_changed');
    this.log(`Палитра: добавлено «${clean.name}»`, 'admin');
    return { ok: true, message: `Добавлено: ${clean.name}`, id };
  },

  paletteRemove({ type, id }) {
    const pal = this.state.palette;
    if (!PALETTE_TYPES.includes(type) || !Object.hasOwn(pal[type] || {}, id)) throw new Error('В палитре такого нет');
    const name = pal[type][id].name;
    delete pal[type][id];
    if (type === 'conditions') {
      delete C.CONDITIONS[id];
      for (const p of this.players()) p.conditions = p.conditions.filter((c) => c.id !== id);
    }
    if (type === 'accidents') delete C.ACCIDENTS[id];
    if (type === 'items') {
      delete C.ITEMS[id];
      this.purgeUnknownItems();
    }
    if (type === 'conditions') {
      for (const it of Object.values(C.ITEMS)) if (it.use && it.use.cure) it.use.cure = it.use.cure.filter((c) => c !== id);
      for (const a of Object.values(C.ACCIDENTS)) if (a.condition === id) delete a.condition;
    }
    this.emit('content_changed');
    this.log(`Палитра: удалено «${name}»`, 'admin');
    return { ok: true, message: `Удалено: ${name}` };
  },

  /**
   * Опасность на клетке сцены. scene — ключ сцены ('corridor:101', 'canteen', 'home:10101') или
   * playerId — тогда сцена жильца и клетка рядом с ним. Без x/y — случайная свободная клетка.
   */
  hazard({ scene, playerId, kind = 'steam', x, y, minutes = 0 }) {
    if (!C.HAZARDS[kind]) throw new Error('Нет такой опасности');
    let key = scene;
    let near = null;
    if (playerId) {
      const p = this.requirePlayer(playerId);
      key = this.locationKey(p);
      near = p.pos;
    }
    if (!key) throw new Error('Где ставить? Укажите сцену или жильца');
    let sc;
    try {
      sc = this.map.scene(key);
    } catch {
      throw new Error('Нет такой сцены');
    }
    let pos = null;
    if (x != null && x !== '' && y != null && y !== '') {
      // клик в Глазке: ровно в эту клетку, а не куда попало
      const cx = Math.floor(Number(x)) + 0.5, cy = Math.floor(Number(y)) + 0.5;
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || World.isSolidTile(sc, Math.floor(cx), Math.floor(cy))) throw new Error('Туда не поставить: стена или мебель');
      const there = (this.world.hazards[key] || []).find((h) => h.x === cx && h.y === cy);
      if (there) throw new Error(`Здесь уже: ${C.HAZARDS[there.kind].name}`);
      pos = { x: cx, y: cy };
    }
    if (!pos) {
      const free = [];
      for (let ty = 0; ty < sc.h; ty++) {
        for (let tx = 0; tx < sc.w; tx++) {
          if (World.isSolidTile(sc, tx, ty)) continue;
          const c = { x: tx + 0.5, y: ty + 0.5 };
          // не на подходах к дверям и предметам — чтобы не перекрыть проход
          if (sc.objects.some((o) => o.spot && Math.hypot(o.spot.x - c.x, o.spot.y - c.y) < 0.9)) continue;
          if (near && Math.hypot(near.x - c.x, near.y - c.y) > 3) continue;
          if (near && Math.hypot(near.x - c.x, near.y - c.y) < 1) continue;
          if ((this.world.hazards[key] || []).some((h) => h.x === c.x && h.y === c.y)) continue; // одна опасность — одна клетка
          free.push(c);
        }
      }
      if (!free.length) throw new Error('Некуда поставить');
      pos = free[Math.floor(this.random() * free.length)];
    }
    const hz = { id: newId('h'), kind, x: pos.x, y: pos.y, fenced: false, until: Number(minutes) > 0 ? this.timerNow() + Number(minutes) * 60000 : null };
    this.world.hazards[key] = [...(this.world.hazards[key] || []), hz].slice(-20);
    this.log(`Опасность «${C.HAZARDS[kind].name}» — ${key}`, 'event');
    return { ok: true, message: `${C.HAZARDS[kind].name}: ${key}`, id: hz.id };
  },

  /** Радиоточка: сказать в эфир сейчас или поставить в очередь (уйдёт в ближайшую передачу). */
  radio({ text, now = false }) {
    const clean = sanitizeText(text, 300);
    if (!clean) throw new Error('Пустая передача');
    const r = this.world.radio;
    if (now) {
      if (r.silenceUntil && this.now() < r.silenceUntil) throw new Error('В эфире тишина — сначала верните эфир');
      const n = this.airRadio(clean, 'zhek');
      this.log(`Радиоточка (в эфир): «${clean}»`, 'admin');
      return { ok: true, message: `В эфире. Слышат у радиоточек: ${n}` };
    }
    if (r.queue.length >= 20) throw new Error('Очередь эфира полна (20)');
    r.queue.push({ id: newId('r'), text: clean });
    this.log(`Радиоточка (в очередь): «${clean}»`, 'admin');
    return { ok: true, message: 'Поставлено в очередь эфира' };
  },

  radioRemove({ id }) {
    const r = this.world.radio;
    r.queue = r.queue.filter((x) => x.id !== id);
    return { ok: true };
  },

  /** «Тишина в эфире» — предвестник. minutes 0 — вернуть эфир. */
  radioSilence({ minutes = 10 }) {
    const min = Math.max(0, Math.min(1440, Number(minutes) || 0));
    this.world.radio.silenceUntil = min > 0 ? this.timerNow() + min * 60000 : null;
    this.log(min > 0 ? `Тишина в эфире на ${min} мин` : 'Эфир радиоточки возвращён', 'admin');
    return { ok: true, message: min > 0 ? `Радиоточки замолчали на ${min} мин` : 'Эфир вернулся' };
  },

  /** Подбросить жильцу записку под дверь — от кого угодно или без подписи. */
  plantNote({ id, text, from }) {
    const p = this.requirePlayer(id);
    const clean = sanitizeText(text, C.NOTES.maxLength);
    if (!clean) throw new Error('Пустая записка');
    const sign = sanitizeText(from, 40);
    if (sign && this.alivePlayers().some((q) => nameSkeleton(q.name) === nameSkeleton(sign))) throw new Error('Нельзя подписывать записку именем живого жильца');
    const apt = p.apartment.number;
    if (!this.state.doorDrops[apt]) this.state.doorDrops[apt] = [];
    this.state.doorDrops[apt].push({ id: newId('d'), ts: this.now(), fromId: null, fromName: sign || '', fromApt: '—', kind: 'note', text: clean, anon: !sign, byZhek: true });
    if (this.isOnline(p.id) && this.isOwnHome(p)) this.collectDrops(p);
    else this.pushOffline(p, { title: 'Под дверью', body: `Кто-то подсунул записку под дверь кв. ${apt}.`, tag: 'door' });
    this.log(`Записка под дверь ${p.name}${sign ? ` от «${sign}»` : ' без подписи'}: «${clean}»`, 'admin', p.id);
    return { ok: true, message: this.isOwnHome(p) ? 'Записка у жильца' : 'Записка ждёт под дверью' };
  },

  /**
   * Марионетка: preset 'walker' (обходчик), 'controller' (контролёр), 'double' (двойник жильца playerId)
   * или своё имя. Появляется в сцене scene (или там, где жилец playerId).
   */
  puppetCreate({ name, preset = 'walker', scene, playerId, x, y }) {
    if (Object.keys(this.world.puppets).length >= 12) throw new Error('Марионеток слишком много (12)');
    let key = scene;
    let lookId = null;
    let label = sanitizeText(name, 20);
    if (preset === 'double') {
      const q = this.requirePlayer(playerId);
      lookId = q.id;
      label = label || q.name;
      key = key || this.locationKey(q);
    } else if (playerId) {
      key = key || this.locationKey(this.requirePlayer(playerId));
    }
    if (!label) label = preset === 'controller' ? 'Контролёр' : preset === 'walker' ? 'Обходчик' : 'Незнакомец';
    if (!key) throw new Error('Где поставить? Укажите помещение или жильца');
    let sc;
    try {
      sc = this.map.scene(key);
    } catch {
      throw new Error('Нет такого помещения');
    }
    let pos = x != null && y != null && World.canStand(sc, Number(x), Number(y), 0.2) ? { x: Number(x), y: Number(y) } : null;
    if (!pos) pos = this.map.spawn(key, 'default');
    const id = newId('pp');
    this.world.puppets[id] = { id, name: label, preset: ['walker', 'controller', 'double'].includes(preset) ? preset : 'custom', lookId, scene: key, x: pos.x, y: pos.y, d: 'down', path: [] };
    this.log(`Марионетка «${label}» — ${this.sceneTitle(key)}`, 'admin');
    return { ok: true, message: `${label}: ${this.sceneTitle(key)}`, puppetId: id };
  },

  /** Повести марионетку к клетке (по проходам), или перенести в другое помещение (scene). */
  puppetMove({ id, x, y, scene }) {
    const pp = this.requirePuppet(id);
    if (scene && scene !== pp.scene) {
      try {
        this.map.scene(scene);
      } catch {
        throw new Error('Нет такого помещения');
      }
      const spawn = this.map.spawn(scene, 'default');
      Object.assign(pp, { scene, x: spawn.x, y: spawn.y, path: [] });
      return { ok: true, message: `${pp.name}: ${this.sceneTitle(scene)}` };
    }
    const sc = this.map.scene(pp.scene);
    const path = World.findPath(sc, pp, { x: Number(x), y: Number(y) });
    if (!path) throw new Error('Туда не пройти');
    pp.path = path.slice(0, 200);
    return { ok: true };
  },

  /** Марионетка говорит: облачко над ней и строка в «Здесь» у тех, кто рядом. */
  puppetSay({ id, text }) {
    const pp = this.requirePuppet(id);
    const clean = sanitizeText(text, 200);
    if (!clean) throw new Error('Пустая реплика');
    const msg = { id: newId('m'), ts: this.now(), channel: 'local', key: pp.scene, where: this.sceneTitle(pp.scene), from: { id: pp.id, name: pp.name, apt: '—', puppet: true }, text: clean };
    const list = this.localChat.get(pp.scene) || [];
    list.push(msg);
    if (list.length > 30) list.shift();
    this.localChat.set(pp.scene, list);
    this.emit('chat', msg);
    this.log(`${pp.name} (марионетка): «${clean}»`, 'admin');
    return { ok: true };
  },

  /** Марионетка стучит в квартиру: хозяин увидит в глазок её имя. Открыть ей нельзя — она не войдёт. */
  puppetKnock({ id, apt }) {
    const pp = this.requirePuppet(id);
    const owner = this.ownerOf(String(apt));
    if (!owner) throw new Error('Квартира пустует');
    const floor = owner.apartment.floor;
    const sc = this.map.scene(`corridor:${floor}`);
    const door = sc.objects.find((o) => o.type === 'apt' && o.number === owner.apartment.number);
    Object.assign(pp, { scene: `corridor:${floor}`, x: door.spot.x, y: door.spot.y, d: 'up', path: [] });
    if (this.isOwnHome(owner) && this.isOnline(owner.id)) {
      this.notify([owner], { title: 'Стук в дверь', text: `В глазок видно: ${pp.name}. Стоит и ждёт. Не уходит.`, style: 'knock', journal: false });
    } else if (owner.absence) {
      owner.absence.knocks.push({ name: pp.name, apt: '—', ts: this.now() });
    }
    this.log(`${pp.name} (марионетка) стучит в кв. ${owner.apartment.number}`, 'admin');
    return { ok: true, message: `Стук в кв. ${owner.apartment.number}` };
  },

  puppetRemove({ id }) {
    if (id) delete this.world.puppets[id];
    else this.world.puppets = {};
    return { ok: true, message: 'Марионетка исчезла' };
  },

  /** Одержимые вещи: мусоропровод или доска «говорят» голосом ЖЭК на этаже. */
  objectVoice({ floor, object = 'chute', text, as }) {
    const f = toInt(floor, C.BUILDING.firstResidentialFloor);
    const clean = sanitizeText(text, 200);
    if (!clean) throw new Error('Пустой текст');
    if (object === 'board') {
      // листок на доске от любого имени (жильцы не знают, что это ЖЭК)
      const sign = sanitizeText(as, 30) || 'без подписи';
      const notes = this.state.boardNotes[f] || [];
      notes.push({ id: newId('b'), ts: this.now(), playerId: null, name: sign, apt: '—', text: clean, byZhek: true });
      this.state.boardNotes[f] = notes.slice(-C.NOTES.perBoard);
      this.log(`Листок на доске ${f} этажа от «${sign}»: «${clean}»`, 'admin');
      return { ok: true, message: 'Листок на доске' };
    }
    const key = `corridor:${f}`;
    const listeners = this.alivePlayers().filter((p) => this.locationKey(p) === key && this.isOnline(p.id));
    for (const p of listeners) this.emit('object_say', { to: p.id, object: 'chute', text: clean });
    this.log(`Мусоропровод ${f} этажа: «${clean}»`, 'admin');
    return { ok: true, message: `Услышали: ${listeners.length}` };
  },

  /** Откатить весь дом к снимку. Перед этим текущий мир тоже сохраняется — откат можно отменить. */
  restoreHouse({ snapshotId }, ctx = {}) {
    const snap = this.snapshots.find((x) => x.id === snapshotId);
    if (!snap) throw new Error('Нет такого снимка');
    this.takeSnapshot('перед откатом дома', ctx.who);
    const now = this.now();
    const wasPaused = !!this.world.paused;
    const data = JSON.parse(snap.data);
    const fresh = Game.normalize({ ...this.state, ...data });
    Object.assign(this.state, fresh);
    this.invalidatePlayers();
    // таймеры снимка (туман, поломки, «без сознания», расписание…) продолжаются с того места, где
    // были в снимке, а не догоняют прошедшее с тех пор время; пауза — та, что сейчас
    const w = this.world;
    this.shiftTimers(now - (w.paused && w.pausedAt ? w.pausedAt : snap.ts));
    w.paused = wasPaused;
    w.pausedAt = wasPaused ? now : null;
    this.purgeUnknownItems(); // палитра в снимок не входит: вещи, которых уже нет, убираем
    this.applyPalette();
    this.rebuildMap(); // перепланировка тоже откатилась
    this.byToken = new Map(Object.values(this.state.players).map((p) => [p.token, p.id]));
    for (const p of Object.values(this.state.players)) {
      const scene = this.sceneOf(p);
      if (!p.pos || !World.canStand(scene, p.pos.x, p.pos.y)) p.pos = { ...this.map.spawn(scene.key), d: 'down' };
    }
    this.log(`Дом откачен к снимку «${snap.label}» (${snap.clock})`, 'admin');
    this.emit('restored');
    return { ok: true, message: `Дом откачен к ${snap.clock}` };
  },

  /** Вернуть одного жильца к снимку (жив, здоровье, карманы, место). Паспорт и токен — текущие. */
  restorePlayer({ snapshotId, id }, ctx = {}) {
    const snap = this.snapshots.find((x) => x.id === snapshotId);
    if (!snap) throw new Error('Нет такого снимка');
    const cur = this.getPlayer(id);
    if (!cur) throw new Error('Жилец не найден');
    const data = JSON.parse(snap.data);
    const old = data.players && Object.hasOwn(data.players, id) ? data.players[id] : null;
    if (!old) throw new Error('В этом снимке такого жильца ещё не было');
    // двух живых на одном паспорте не бывает (как и при воскрешении)
    const acc = cur.account && this.state.accounts[cur.account];
    const heir = old.alive && acc ? this.accountPlayer(acc) : null;
    if (heir && heir.id !== id) throw new Error(`По этому паспорту уже живёт ${heir.name}. Двух живых на одном паспорте не бывает`);
    if (old.alive && !cur.alive && this.alivePlayers().some((q) => q.id !== id && q.apartment.number === old.apartment.number)) throw new Error('Его квартиру уже заняли — сначала освободите');
    this.takeSnapshot(`перед откатом жильца ${cur.name}`, ctx.who);
    // наследство уже забрали — второй раз его не взять (иначе вещь удвоится)
    const keep = { token: cur.token, account: cur.account, journal: cur.journal, inheritedBy: cur.inheritedBy || old.inheritedBy };
    this.state.players[id] = Object.assign(old, keep);
    this.invalidatePlayers();
    const p = this.state.players[id];
    p.job = null;
    // «без сознания», болезни, поездка — с того места, где были в снимке
    const sw = data.world || {};
    this.shiftPlayerTimers(p, this.timerNow() - (sw.paused && sw.pausedAt ? sw.pausedAt : snap.ts));
    this.purgeUnknownItems();
    const scene = this.sceneOf(p);
    if (!p.pos || !World.canStand(scene, p.pos.x, p.pos.y)) p.pos = { ...this.map.spawn(scene.key), d: 'down' };
    this.journal(p, 'Вы вдруг оказались там, где были раньше. Будто время для вас отмоталось назад.', 'whisper');
    this.log(`${p.name} откачен к снимку «${snap.label}» (${snap.clock})`, 'admin', p.id);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
    return { ok: true, message: `${p.name} — как было в ${snap.clock}` };
  },

  /** Личная учётка бога. role: god | moderator | observer. */
  adminAdd({ login, password, role = 'moderator' }) {
    const key = String(login || '').trim().toLowerCase();
    if (!/^[a-zа-яё0-9_.-]{3,20}$/i.test(key) || key === 'root' || key in Object.prototype) throw new Error('Логин — 3–20 букв или цифр (не root)');
    if (String(password || '').length < 8) throw new Error('Пароль — не короче 8 символов');
    if (!ROLE_NAMES[role]) throw new Error('Роль — бог, модератор или наблюдатель');
    const salt = crypto.randomBytes(16).toString('hex');
    const existed = Object.hasOwn(this.state.admins, key);
    this.state.admins[key] = { login: key, salt, hash: Game.hashPassword(password, salt), role, createdAt: this.now() };
    // сменили роль или пароль — открытые Пульты этой учётки закрываются, войти заново по новым правам
    if (existed) this.emit('admin_removed', key);
    return { ok: true, message: `Учётка ${key}: ${ROLE_NAMES[role]}` };
  },

  adminRemove({ login }) {
    const key = String(login || '').trim().toLowerCase();
    if (!Object.hasOwn(this.state.admins, key)) throw new Error('Нет такой учётки');
    delete this.state.admins[key];
    this.emit('admin_removed', key);
    return { ok: true, message: `Учётка ${key} удалена` };
  },

  /** Снимок вручную — перед задуманным. */
  snapshot({ label }, ctx = {}) {
    const snap = this.takeSnapshot(sanitizeText(label, 60) || 'снимок вручную', ctx.who);
    return { ok: true, message: `Снимок: ${snap.clock}` };
  },

  /** Микроклимат на этажах: холод, сырость, жара, сквозняк. harm 0 — только вид и звук; 0.5–2 — вред в минуту. */
  climate({ from, to, kind = 'cold', minutes = 0, harm = 0 }) {
    if (!C.CLIMATES[kind]) throw new Error('Нет такой погоды');
    const a = toInt(from, C.BUILDING.firstResidentialFloor);
    const b = toInt(to, a);
    const min = Math.max(0, Math.min(7 * 1440, Number(minutes) || 0));
    const c = { id: newId('c'), from: Math.min(a, b), to: Math.max(a, b), kind, until: min ? this.timerNow() + min * 60000 : null, harm: Math.max(0, Math.min(3, Number(harm) || 0)) };
    this.world.climate = [...this.world.climate.filter((x) => !(x.from === c.from && x.to === c.to)), c].slice(-20);
    const affected = this.alivePlayers().filter((p) => p.location.floor >= c.from && p.location.floor <= c.to);
    this.notify(affected, { title: C.CLIMATES[kind].name, text: C.CLIMATES[kind].text, style: 'info' });
    this.log(`Микроклимат: ${C.CLIMATES[kind].name} на этажах ${c.from}–${c.to}${c.harm ? `, вред ×${c.harm}` : ''}`, 'event', null, { public: `${C.CLIMATES[kind].name.toLowerCase()} на этажах ${c.from}–${c.to}` });
    return { ok: true, message: `${C.CLIMATES[kind].name}: ${c.from}–${c.to}` };
  },

  climateClear({ id }) {
    this.world.climate = id ? this.world.climate.filter((x) => x.id !== id) : [];
    return { ok: true, message: 'Погода в доме обычная' };
  },

  /** «Звук в доме»: удары, скрежет, плач за стеной, шаги сверху, шёпот — у выбранных жильцов. */
  sound({ target, kind = 'bang' }) {
    if (!C.HOUSE_SOUNDS[kind]) throw new Error('Нет такого звука');
    const list = this.resolveTargets(target).filter((p) => this.isOnline(p.id));
    for (const p of list) this.emit('sound', { to: p.id, kind, text: C.HOUSE_SOUNDS[kind] });
    this.log(`Звук в доме «${kind}»: ${list.map((p) => p.name).join(', ') || 'никто не услышал'}`, 'admin');
    return { ok: true, message: `Услышали: ${list.length}` };
  },

  /** Сохранить свой сценарий в библиотеку (id — новый или существующий свой). */
  scenarioSave({ id, def }) {
    const clean = this.cleanScenario(def);
    const key = id && Object.hasOwn(this.state.scenarios, id) ? id : newId('sc');
    if (!Object.hasOwn(this.state.scenarios, key) && Object.keys(this.state.scenarios).length >= 50) throw new Error('В библиотеке уже 50 сценариев');
    this.state.scenarios[key] = clean;
    this.emit('content_changed'); // шаги своих сценариев Пульт берёт из описания
    return { ok: true, message: `Сценарий «${clean.name}» сохранён`, scenarioId: key };
  },

  scenarioDelete({ id }) {
    if (!Object.hasOwn(this.state.scenarios, id)) throw new Error('Такого своего сценария нет');
    delete this.state.scenarios[id];
    this.emit('content_changed');
    const running = this.state.scenarioRuns.filter((r) => r.scenarioId === id).length;
    return { ok: true, message: running ? `Сценарий удалён из библиотеки; идущий (${running}) доиграет — остановить можно в списке идущих` : 'Сценарий удалён' };
  },

  /** Запустить сценарий из библиотеки (или разовый — def без сохранения). */
  scenarioStart({ id, def }) {
    let scen = id ? this.scenarioDef(id) : null;
    if (!scen && def) scen = this.cleanScenario(def);
    if (!scen) throw new Error('Нет такого сценария');
    if (this.state.scenarioRuns.length >= 10) throw new Error('Уже идёт 10 сценариев');
    // копия шагов — в сам запуск: удалить или поправить сценарий в библиотеке, пока он идёт, можно
    const run = { id: newId('sr'), scenarioId: id || null, def: JSON.parse(JSON.stringify(scen)), name: scen.name, step: 0, nextAt: this.timerNow(), startedAt: this.now() };
    this.state.scenarioRuns.push(run);
    this.log(`Запущен сценарий «${scen.name}»`, 'schedule');
    this.runScenarios(this.now());
    return { ok: true, message: `Сценарий «${scen.name}» пошёл` };
  },

  scenarioStop({ id }) {
    const before = this.state.scenarioRuns.length;
    this.state.scenarioRuns = this.state.scenarioRuns.filter((r) => r.id !== id);
    if (before === this.state.scenarioRuns.length) throw new Error('Такого идущего сценария нет');
    return { ok: true, message: 'Сценарий остановлен' };
  },

  /**
   * Перепланировка сцены: wall — замуровать объект (дверь, мусоропровод, доску) под клеткой x,y;
   * rubble — завал на клетке пола (только если все двери, лифт и лестница остаются достижимы);
   * closet — кладовка в стене над полом, с вещами items для каждого, кто заглянет.
   */
  replan({ scene, kind, x, y, items, text }) {
    let sc;
    try {
      sc = this.map.scene(scene);
    } catch {
      throw new Error('Нет такого помещения');
    }
    const tx = Math.floor(Number(x)), ty = Math.floor(Number(y));
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || tx < 0 || ty < 0 || tx >= sc.w || ty >= sc.h) throw new Error('Клетка вне помещения');
    const ov = { id: newId('o'), kind, tiles: [] };
    if (kind === 'wall') {
      const o = sc.objects.find((q) => tx >= q.x && tx < q.x + q.w && ty >= q.y - (q.wall && !q.bottom ? 1 : 0) && ty < q.y + q.h);
      if (!o) throw new Error('Здесь нечего замуровывать — кликните по двери или предмету на стене');
      if (['lift', 'stairs', 'exit', 'hermodoor'].includes(o.type)) throw new Error('Лифт, лестницу и выходы не замуровать: люди окажутся заперты');
      for (let i = 0; i < o.w; i++) for (let j = 0; j < o.h; j++) ov.tiles.push([o.x + i, o.y + j]);
      ov.label = o.type === 'apt' ? `кв. ${o.number}` : o.label || o.type;
    } else if (kind === 'rubble') {
      if (World.isSolidTile(sc, tx, ty)) throw new Error('Завал — только на полу');
      if (sc.objects.some((o) => o.spot && Math.floor(o.spot.x) === tx && Math.floor(o.spot.y) === ty)) throw new Error('Не загораживайте подход к двери или предмету');
      ov.tiles.push([tx, ty]);
    } else if (kind === 'closet') {
      if (!World.isSolidTile(sc, tx, ty) || sc.objects.some((o) => tx >= o.x && tx < o.x + o.w && ty >= o.y && ty < o.y + o.h)) throw new Error('Кладовка — в пустой стене');
      if (World.isSolidTile(sc, tx, ty + 1)) throw new Error('Под кладовкой должен быть пол');
      // соседние кладовки склеились бы в одну, и вещи второй пропали бы
      if (sc.objects.some((o) => o.type === 'closet' && ty >= o.y && ty < o.y + o.h && (tx === o.x - 1 || tx === o.x + o.w))) throw new Error('Вплотную к другой кладовке нельзя — отступите на клетку');
      ov.tiles.push([tx, ty]);
      const clean = {};
      for (const [id, n] of Object.entries(items || {})) if (Object.hasOwn(C.ITEMS, id) && toInt(n) > 0) clean[id] = Math.min(9, toInt(n));
      this.world.closets[`${scene}:${tx}:${ty}`] = { items: clean, text: sanitizeText(text, 200), taken: [] };
    } else {
      throw new Error('Что сделать: замуровать, завал или кладовка');
    }
    const list = this.world.overlays[scene] || [];
    this.world.overlays[scene] = [...list, ov];
    this.map = World.create(this.worldConfig());
    const after = this.map.scene(scene);
    const lost = World.unreachableObjects(after, this.map.spawn(scene, 'default'));
    if (kind === 'rubble' && lost.length) {
      this.world.overlays[scene] = list;
      this.map = World.create(this.worldConfig());
      throw new Error(`Так завал отрежет: ${lost.map((o) => o.label || o.type).slice(0, 3).join(', ')}`);
    }
    if (!this.world.overlays[scene].length) delete this.world.overlays[scene];
    this.rebuildMap([scene]);
    this.log(`Перепланировка «${this.sceneTitle(scene)}»: ${kind === 'wall' ? `замуровано — ${ov.label}` : kind === 'rubble' ? 'завал' : 'новая кладовка'}`, 'event', null, { public: kind === 'wall' ? `в ${this.sceneTitle(scene).toLowerCase()} замуровали дверь` : null });
    return { ok: true, message: kind === 'wall' ? `Замуровано: ${ov.label}` : kind === 'rubble' ? 'Завал' : 'Кладовка готова' };
  },

  /** Убрать накладку (или все в помещении). */
  replanClear({ scene, id }) {
    const keys = scene ? [scene] : Object.keys(this.world.overlays);
    for (const k of keys) {
      const left = id ? (this.world.overlays[k] || []).filter((o) => o.id !== id) : [];
      if (left.length) this.world.overlays[k] = left;
      else delete this.world.overlays[k];
    }
    this.rebuildMap(keys);
    return { ok: true, message: 'Как было' };
  },

  /**
   * Аномалии: extraFloor { label } — лишний этаж на табло лифта; wrongDoor { facility, to } — дверь
   * учреждения ведёт в другое; stairLoop { from, to } — петля на лестнице. harm — тратить ли рассудок.
   */
  anomaly({ kind, label, facility, to, from, harm, off }) {
    const a = this.world.anomalies;
    if (!['extraFloor', 'wrongDoor', 'stairLoop'].includes(kind)) throw new Error('Нет такой аномалии');
    if (off) {
      a[kind] = null;
      return { ok: true, message: 'Аномалия исчезла' };
    }
    if (kind === 'extraFloor') a.extraFloor = { label: sanitizeText(label, 12) || '100½', harm: !!harm };
    if (kind === 'wrongDoor') {
      if (!C.FACILITIES[facility] || !C.FACILITIES[to] || facility === to) throw new Error('Выберите два разных учреждения');
      a.wrongDoor = { facility, to, harm: !!harm };
    }
    if (kind === 'stairLoop') {
      const f1 = toInt(from, 101);
      const f2 = toInt(to, f1);
      a.stairLoop = { from: Math.min(f1, f2), to: Math.max(f1, f2), harm: !!harm };
    }
    this.log(`Аномалия: ${kind}`, 'admin');
    return { ok: true, message: 'Аномалия в доме' };
  },

  /** Поставить барыгу на технический этаж. */
  barygaPlace({ floor }) {
    const f = toInt(floor, 99);
    if (this.map.floorKind(f) !== 'technical') throw new Error('Барыга торгует только на техническом этаже (ниже жилых, кроме столовой, медпункта и цеха)');
    const spot = this.barygaSpot(f);
    this.world.baryga = { floor: f, x: spot.x, y: spot.y, purse: B.barygaPurse, purseDay: this.gameDay() };
    this.log(`Барыга появился на ${f} этаже`, 'admin');
    return { ok: true, message: `Барыга на ${f} этаже` };
  },

  barygaRemove() {
    this.world.baryga = null;
    return { ok: true, message: 'Барыга ушёл' };
  },

  /** Облава: барыгу уводят, свидетели на этаже это видят; кто ему продавал за сутки — цель «Клиенты барыги». */
  barygaRaid() {
    const b = this.world.baryga;
    if (!b) throw new Error('Барыги нет');
    const witnesses = this.alivePlayers().filter((p) => p.location.place === 'corridor' && p.location.floor === b.floor);
    this.notify(witnesses, { title: 'Облава', text: 'Люди в серых плащах увели барыгу. Говорят, у него была тетрадка с именами.', style: 'danger' });
    this.world.baryga = null;
    this.log('Облава на барыгу', 'event', null, { public: `облава на техническом этаже ${b.floor}` });
    return { ok: true, message: `Облава. Клиентов за сутки: ${this.resolveTargets({ type: 'barygaClients' }).length}` };
  },

  /** Квартплата: сколько талонов в сутки (0 — отменить). */
  rentSet({ amount }) {
    const n = Math.max(0, Math.min(50, toInt(amount, B.rent)));
    this.world.rent = n;
    this.log(n ? `Квартплата: ${talons(n)} в сутки` : 'Квартплата отменена', 'event', null, { public: n ? `квартплата — ${talons(n)} в сутки` : 'квартплату отменили' });
    return { ok: true, message: n ? `Квартплата ${talons(n)} в сутки` : 'Квартплата отменена' };
  },

  /** Простить долг за квартиру (одному или всем). */
  rentForgive({ id }) {
    const list = id ? [this.requirePlayer(id)] : this.alivePlayers();
    let n = 0;
    for (const p of list) if (p.rentDebt) {
      p.rentDebt = 0;
      n++;
      this.journal(p, 'ЖЭК списал ваш долг за квартиру.', 'good');
    }
    return { ok: true, message: `Долги прощены: ${n}` };
  },

  /** Ответ ЖЭК на коллективное заявление: выполнить, оставить без ответа или наказать подписавших. */
  petitionResolve({ id, verdict, reply }) {
    const pet = this.state.petitions.find((x) => x.id === id);
    if (!pet || !['open', 'sent'].includes(pet.status)) throw new Error('Такого заявления нет или по нему уже решили');
    if (!['done', 'ignored', 'punished'].includes(verdict)) throw new Error('Решение — выполнить, игнорировать или наказать');
    pet.status = verdict;
    pet.resolvedAt = this.now();
    pet.reply = sanitizeText(reply, 200) || null;
    const signers = pet.signers.map((x) => this.getPlayer(x.id)).filter((q) => q && q.alive);
    if (verdict === 'done') {
      this.notify(signers, { title: 'Ответ ЖЭК', text: `По заявлению «${pet.text}»: меры приняты.${pet.reply ? ` ${pet.reply}` : ''}`, style: 'good' });
    } else if (verdict === 'punished') {
      for (const q of signers) {
        this.notify([q], { title: 'Ответ ЖЭК', text: `По заявлению «${pet.text}»: кляузы не поощряются.${pet.reply ? ` ${pet.reply}` : ''}`, style: 'danger' });
        this.applyEffect(q, { sanity: -10, money: -2 }, 'Наказание ЖЭК');
      }
    }
    this.log(`Заявление «${pet.text}»: ${verdict === 'done' ? 'выполнено' : verdict === 'punished' ? 'подписавшие наказаны' : 'без ответа'}`, 'admin');
    return { ok: true, message: 'Решение принято' };
  },

  /**
   * Разнарядка на этажи (по этажу квартиры): сдать предмет, талоны или отработать смены до срока.
   * kind: 'item' | 'money' | 'shifts'.
   */
  assign({ from, to, text, kind = 'item', item = 'spoon', amount = 1, minutes = 60 }) {
    const a1 = toInt(from, C.BUILDING.firstResidentialFloor);
    const b1 = toInt(to, a1);
    if (!['item', 'money', 'shifts'].includes(kind)) throw new Error('Вид — предмет, талоны или смены');
    if (kind === 'item' && !C.ITEMS[item]) throw new Error('Нет такого предмета');
    const n = Math.max(1, Math.min(99, toInt(amount, 1)));
    const min = Math.max(1, Math.min(7 * 1440, Number(minutes) || 60));
    const a = {
      id: newId('z'),
      from: Math.min(a1, b1),
      to: Math.max(a1, b1),
      text: sanitizeText(text, 120) || 'Разнарядка ЖЭК',
      kind,
      item: kind === 'item' ? item : null,
      amount: n,
      until: this.timerNow() + min * 60000,
      createdAt: this.now(),
      done: {},
      progress: {},
    };
    this.state.assignments.push(a);
    const residents = this.alivePlayers().filter((p) => p.apartment.floor >= a.from && p.apartment.floor <= a.to);
    const what = this.assignmentView(a, null).what;
    this.notify(residents, { title: 'Разнарядка ЖЭК', text: `«${a.text}». С каждой квартиры: ${what}. Срок — ${fmtDuration(min * 60000)}. Подробности — на доске объявлений.`, style: 'announce' });
    this.log(`Разнарядка на этажи ${a.from}–${a.to}: «${a.text}» (${what}, ${min} мин)`, 'event', null, { public: `разнарядка ЖЭК на этажи ${a.from}–${a.to}: ${what}` });
    return { ok: true, message: `Разнарядка выдана: квартир ${residents.length}`, assignmentId: a.id };
  },

  assignClose({ id }) {
    const a = this.state.assignments.find((x) => x.id === id && !x.closed);
    if (!a) throw new Error('Нет такой открытой разнарядки');
    a.until = this.now();
    this.closeAssignments(this.now());
    return { ok: true, message: 'Разнарядка закрыта' };
  },

  assignRemove({ id }) {
    this.state.assignments = this.state.assignments.filter((x) => x.id !== id);
    return { ok: true, message: 'Разнарядка удалена' };
  },

  /** Изъять записки и передачки из-под двери (передачки вернутся отправителям). */
  dropsClear({ apt }) {
    const key = String(apt || '');
    if (!this.state.doorDrops[key]) return { ok: true, message: 'Под этой дверью пусто' };
    const n = this.state.doorDrops[key].length;
    this.returnDrops(key, `кв. ${key}`, 'zhek');
    this.log(`ЖЭК изъял из-под двери кв. ${key}: ${n}`, 'admin');
    return { ok: true, message: `Изъято: ${n}` };
  },

  /** Стереть следы (копоть, налёт, мел) — в одной сцене или во всём доме. */
  scarsClear({ scene }) {
    let n = 0;
    for (const key of Object.keys(this.world.scars)) {
      if (scene && key !== scene) continue;
      n += this.world.scars[key].length;
      delete this.world.scars[key];
    }
    return { ok: true, message: `Стёрто следов: ${n}` };
  },

  hazardClear({ scene, id }) {
    let n = 0;
    for (const [key, list] of Object.entries(this.world.hazards)) {
      if (scene && key !== scene) continue;
      const left = list.filter((hz) => id && hz.id !== id);
      n += list.length - left.length;
      if (left.length) this.world.hazards[key] = left;
      else delete this.world.hazards[key];
    }
    return { ok: true, message: `Убрано опасностей: ${n}` };
  },

  /** Снабжение: 'extra' — внеплановый завоз сейчас (+50% нормы), 'short' — недовоз в следующий раз, 'normal' — отменить недовоз. */
  supply({ mode }) {
    if (mode === 'extra') {
      this.deliver(true);
      this.log('Внеплановый завоз', 'event', null, { public: 'внеплановый завоз в столовую и медпункт' });
      this.notify(this.alivePlayers(), { title: 'Завоз', text: 'В столовую и медпункт пришла внеплановая машина.', style: 'good', journal: false });
      return { ok: true, message: 'Привезли' };
    }
    if (mode === 'short') {
      this.world.supplyNext = 0.3;
      this.log('Следующий завоз будет урезан (30%)', 'admin');
      return { ok: true, message: 'Следующий завоз — 30%' };
    }
    this.world.supplyNext = 1;
    return { ok: true, message: 'Завоз как обычно' };
  },

  /** Лампы в коридорах: погасить count случайных на этажах from–to или зажечь все. */
  lamps({ from, to, count = 3, on }) {
    const a = toInt(from, C.BUILDING.firstResidentialFloor);
    const b = toInt(to, a);
    if (Math.abs(b - a) > 300) throw new Error('Не больше 300 этажей за раз');
    let n = 0;
    for (let f = Math.min(a, b); f <= Math.max(a, b); f++) {
      if (on) {
        if (this.world.lampsOut[f]) n += this.world.lampsOut[f].length;
        delete this.world.lampsOut[f];
        continue;
      }
      const total = this.map.scene(`corridor:${f}`).lamps.length;
      const lit = [...Array(total).keys()].filter((i) => !(this.world.lampsOut[f] || []).includes(i));
      const howMany = Math.min(Math.max(0, toInt(count, 3)), lit.length);
      for (let k = 0; k < howMany; k++) {
        const i = lit.splice(Math.floor(this.random() * lit.length), 1)[0];
        this.world.lampsOut[f] = [...(this.world.lampsOut[f] || []), i];
        n++;
      }
    }
    this.log(on ? `Лампы зажжены на этажах ${a}–${b}` : `Погасло ламп: ${n} на этажах ${a}–${b}`, 'event', null, { public: on ? `на этажах ${a}–${b} заменили лампы` : `в коридорах ${a}–${b} перегорели лампы` });
    return { ok: true, message: on ? `Зажжено: ${n}` : `Погашено: ${n}` };
  },

  // ---- модерация ----
  mute({ id, minutes = 30 }) {
    const p = this.requirePlayer(id, { alive: false });
    const min = Math.max(1, Math.min(7 * 24 * 60, Number(minutes) || 30));
    p.mutedUntil = this.now() + min * 60000;
    p.lastSaid = null;
    this.notify([p], { title: 'Вы сорвали голос', text: `ЖЭК запретил вам говорить и писать на ${min} мин.`, style: 'warn' });
    this.log(`${p.name} заглушён на ${min} мин`, 'admin', p.id);
    return { ok: true, message: `Заглушён на ${min} мин` };
  },

  unmute({ id }) {
    const p = this.requirePlayer(id, { alive: false });
    p.mutedUntil = null;
    this.log(`${p.name}: заглушка снята`, 'admin', p.id);
  },

  /** Паспортный стол: сменить жильцу имя (за непотребное имя или по просьбе). Паспорт и вещи — те же. */
  rename({ id, name, reason }) {
    const p = this.requirePlayer(id);
    const clean = sanitizeName(name);
    if (!clean) throw new Error('Имя — от 2 до 20 букв или цифр');
    const taken = this.nameTaken(clean, p.id);
    if (taken) throw new Error(taken);
    const old = p.name;
    if (old === clean) throw new Error('Имя то же самое');
    p.name = clean;
    p.formerNames = [...(p.formerNames || []), old].slice(-5);
    const why = sanitizeText(reason, 200);
    this.notify([p], { title: 'Паспортный стол', text: `Вам выдали новый паспорт. Теперь вы — ${clean}.${why ? ` Основание: ${why}` : ''}`, style: 'announce' });
    this.log(`Паспортный стол: ${old} → ${clean}${why ? ` (${why})` : ''}`, 'admin', p.id);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
    return { ok: true, message: `${old} теперь ${clean}` };
  },

  /** Бан паспорта (а без паспорта — самого жильца); по желанию и адреса. minutes 0 — навсегда. */
  ban({ id, minutes = 0, reason, ip }) {
    const p = this.requirePlayer(id, { alive: false });
    const min = Number(minutes) || 0;
    const ban = { until: min > 0 ? this.now() + min * 60000 : null, reason: sanitizeText(reason, 200) || 'Нарушение порядка в доме' };
    const acc = p.account ? this.state.accounts[p.account] : null;
    if (acc) acc.banned = ban;
    else p.banned = ban;
    if (ip && p.lastIp) this.state.bannedIps[p.lastIp] = ban;
    const ids = acc ? acc.playerIds : [p.id];
    this.emit('kick', { ids, reason: ban.reason, until: ban.until });
    this.log(`Бан: ${p.name}${acc ? ` (паспорт ${acc.login})` : ''}${ip && p.lastIp ? ' и адрес' : ''} — ${ban.reason}${min > 0 ? `, на ${min} мин` : ', навсегда'}`, 'admin', p.id);
    return { ok: true, message: 'Забанен' };
  },

  unban({ id }) {
    const p = this.requirePlayer(id, { alive: false });
    const acc = p.account ? this.state.accounts[p.account] : null;
    if (acc) acc.banned = null;
    p.banned = null;
    if (p.lastIp) delete this.state.bannedIps[p.lastIp];
    this.log(`Бан снят: ${p.name}`, 'admin', p.id);
    return { ok: true, message: 'Бан снят' };
  },

  /** Удалить сообщение из чатов у всех. */
  deleteMessage({ id }) {
    const before = this.state.chatGlobal.length;
    this.state.chatGlobal = this.state.chatGlobal.filter((m) => m.id !== id);
    let found = before !== this.state.chatGlobal.length;
    for (const [key, list] of this.localChat) {
      const left = list.filter((m) => m.id !== id);
      if (left.length !== list.length) found = true;
      this.localChat.set(key, left);
    }
    if (!found) throw new Error('Сообщение уже удалено');
    for (const q of this.players()) if (q.lastSaid && q.lastSaid.id === id) q.lastSaid = null; // удалённое не станет «последними словами»
    this.emit('chat_delete', { id });
    this.log('Сообщение удалено из чата', 'admin');
    return { ok: true, message: 'Удалено' };
  },

  unpin({ id }) {
    for (const [floor, list] of Object.entries(this.state.boardNotes)) {
      const note = list.find((n) => n.id === id);
      if (!note) continue;
      const left = list.filter((n) => n.id !== id);
      if (left.length) this.state.boardNotes[floor] = left;
      else delete this.state.boardNotes[floor];
      this.log(`Снят листок ${note.name} с доски ${floor} этажа: «${note.text}»`, 'admin');
      return { ok: true, message: 'Листок снят.' };
    }
    throw new Error('Листок уже сняли.');
  },

  // ---- события дома ----
  fog(args) {
    return this.startFog(args);
  },

  fogEnd() {
    return this.endFog();
  },

  breakdown({ key, broken, durationMin, reason, repairable }) {
    const res = this.setBreakdown(key, broken, { durationMin, reason });
    // «жильцы могут чинить» — только у поломок со сроком: бессрочные чинит только ЖЭК
    if (broken && this.world.breakdowns[key] && repairable && this.world.breakdowns[key].until) {
      this.world.breakdowns[key].repairable = true;
      this.notify(this.alivePlayers(), { title: 'Аварийный наряд', text: `ЖЭК: «${C.BREAKDOWNS[key].name} — нужны руки. Кто поможет с ремонтом — премия».`, style: 'announce' });
    }
    return res;
  },

  power({ on, from, to, durationMin }) {
    return on ? this.restorePower() : this.cutPower({ from, to, durationMin });
  },

  cutlery({ steal, percent }) {
    return steal ? this.stealCutlery({ percent }) : this.returnCutlery();
  },

  aid({ target, money, items, title, text }) {
    const victims = this.resolveTargets(target);
    const effect = { money: toInt(money), items: items || {} };
    for (const p of victims) {
      const parts = this.applyEffect(p, effect);
      this.notify([p], {
        title: sanitizeText(title, 80) || 'Гуманитарная помощь',
        text: `${sanitizeText(text, 300) || 'ЖЭК выдал паёк.'} (${parts.join(', ') || 'пусто'})`,
        style: 'good',
      });
    }
    this.log(`Гуманитарка для ${victims.length} жильцов: ${this.bundleText(this.normalizeBundle(effect))}`, 'event');
    return { ok: true, message: `Получили: ${victims.length}` };
  },

  announce({ title, text }) {
    const msg = sanitizeText(text, 500);
    if (!msg) throw new Error('Пустое объявление');
    this.notify(this.alivePlayers(), { title: sanitizeText(title, 80) || 'Объявление ЖЭК', text: msg, style: 'announce' });
    this.systemChat(msg);
    this.log(`Объявление: ${msg}`, 'event', null, { public: `объявление ЖЭК: «${msg}»` });
  },

  chat({ text, as }) {
    const msg = sanitizeText(text, 300);
    if (!msg) throw new Error('Пустое сообщение');
    const who = sanitizeText(as, 30) || 'ЖЭК';
    // От имени живого жильца писать нельзя: иначе скриншотом можно подставить невиновного
    if (this.alivePlayers().some((q) => q.name.toLocaleLowerCase('ru') === who.toLocaleLowerCase('ru'))) {
      throw new Error('Нельзя писать от имени живого жильца.');
    }
    const m = { id: newId('m'), ts: this.now(), channel: 'global', from: { name: who, system: true }, text: msg };
    this.pushGlobal(m);
    this.emit('chat', m);
  },

  /** Произвольное событие: любые эффекты на любую цель. */
  custom({ target, title, text, effect = {}, style = 'danger' }) {
    const t = sanitizeText(title, 80) || 'Происшествие';
    const victims = this.resolveTargets(target);
    const clean = {};
    for (const k of [...STAT_KEYS, 'money']) if (Number(effect[k])) clean[k] = Number(effect[k]);
    if (effect.items) clean.items = effect.items;
    if (effect.condition) clean.condition = effect.condition;
    if (effect.cure) clean.cure = 'all';
    if (effect.kill) clean.kill = true;
    const allowedStyles = ['danger', 'warn', 'good', 'whisper', 'announce', 'info'];
    for (const p of victims) {
      this.notify([p], { title: t, text: sanitizeText(text, 500) || t, style: allowedStyles.includes(style) ? style : 'danger' });
      this.applyEffect(p, clean, t);
    }
    this.log(`Событие «${t}» → ${victims.map((p) => p.name).join(', ') || 'никто'}`, 'event');
    return { ok: true, message: `Затронуто жильцов: ${victims.length}` };
  },
};

// ===========================================================================
// Представления (что видит игрок / админ)
// ===========================================================================
Game.prototype.playerView = function playerView(p) {
  const now = this.now();
  const w = this.world;
  const clock = this.gameClock();
  const round = (s) => Object.fromEntries(STAT_KEYS.map((k) => [k, Math.round(s[k])]));

  const you = {
    id: p.id,
    name: p.name,
    apartment: p.apartment,
    alive: p.alive,
    deathCause: p.deathCause,
    stats: round(p.stats),
    money: p.money,
    inventory: Object.entries(p.inventory).map(([id, count]) => ({
      id,
      count,
      name: C.ITEMS[id]?.name || id,
      desc: C.ITEMS[id]?.desc || '',
      usable: !!C.ITEMS[id]?.use,
      food: !!C.ITEMS[id]?.use?.hunger, // в авоську за окном кладут только еду
      readable: !!C.ITEMS[id]?.read,
      furniture: !!C.ITEMS[id]?.furniture,
      equip: !!C.ITEMS[id]?.equip,
    })),
    gasmaskCharge: Math.round(p.gasmaskCharge),
    flashCharge: Math.round(p.flashCharge ?? 100),
    skills: Object.entries(MG.WORK_GAMES).map(([id, g]) => {
      const rank = this.rankOf(p, id);
      return { id, name: g.name, rank, xp: (p.skills && p.skills[id]) || 0, next: C.RANKS[rank] ?? null };
    }),
    location: { ...p.location, title: this.placeTitle(p) },
    pos: p.pos,
    posSeq: p.posSeq,
    travel: p.travel
      ? {
          via: p.travel.via,
          toPlace: p.travel.toPlace,
          toFloor: p.travel.toFloor,
          fromFloor: p.travel.fromFloor,
          stuck: !!p.travel.stuck,
          etaMs: p.travel.stuck ? null : Math.max(0, p.travel.arriveAt - now),
          totalMs: p.travel.arriveAt - p.travel.startedAt,
        }
      : null,
    searchInSec: Math.max(0, Math.ceil(((p.searchedAt || 0) + SEARCH_COOLDOWN_MS - now) / 1000)),
    sealed: this.doorSealed(this.currentApt(p) || p.apartment.number),
    sleeping: p.sleeping,
    account: p.account ? (this.state.accounts[p.account] || {}).login || p.account : null,
    push: (p.push || []).map((s) => s.endpoint),
    mutedMin: this.mutedFor(p),
    obituary: p.alive ? null : this.obituary(p),
    rebirthInSec: p.alive ? 0 : this.rebirthWait(p),
    echoUsed: !!p.echoUsed,
    echoPhrases: p.alive ? null : C.ECHO_PHRASES,
    tutorial: p.tutorial && !p.tutorial.rewarded && !p.tutorial.hidden ? C.TUTORIAL.map((t) => ({ id: t.id, text: t.text, done: p.tutorial.done.includes(t.id) })) : null,
    asks: (p.asks || []).filter((a) => a.until > now).map((a) => ({ id: a.id, question: a.question, options: a.options, from: a.from })),
    down: p.down ? { remainingSec: Math.max(0, Math.ceil((p.down.until - now) / 1000)), cause: p.down.cause } : null,
    knocker: (() => {
      const g = this.knockerFor(p);
      return g ? { id: g.id, name: g.name, apt: g.apartment.number, rumor: this.rumor(g) } : null;
    })(),
    conditions: p.conditions.map((c) => ({
      id: c.id,
      name: C.CONDITIONS[c.id]?.name || c.id,
      kind: C.CONDITIONS[c.id]?.kind,
      remainingSec: c.until ? Math.max(0, Math.round((c.until - now) / 1000)) : null,
    })),
    job: p.job ? { id: p.job.id, game: p.job.game } : null,
    shifts: p.shifts || 0,
    journal: p.journal.slice(-30),
  };

  const fog = w.fog
    ? {
        phase: this.fogPhase(),
        from: w.fog.from,
        to: w.fog.to,
        inSec: Math.max(0, Math.round((w.fog.warnUntil - now) / 1000)),
        endsInSec: Math.max(0, Math.round((w.fog.until - now) / 1000)),
        affectsYou: p.location.floor >= w.fog.from && p.location.floor <= w.fog.to,
      }
    : null;

  const facilities = {};
  for (const key of Object.keys(C.FACILITIES)) facilities[key] = { name: C.FACILITIES[key].name, floor: C.FACILITIES[key].floor, ...this.facilityStatus(key) };

  const here = this.describePlace(p);

  const trades = Object.values(this.state.trades)
    .filter((t) => t.to === p.id || t.from === p.id)
    .map((t) => ({
      id: t.id,
      incoming: t.to === p.id,
      other: (() => {
        const o = this.getPlayer(t.to === p.id ? t.from : t.to);
        return o ? { id: o.id, name: o.name } : null;
      })(),
      give: this.bundleText(t.give),
      want: this.bundleText(t.want),
      creditDay: t.credit ? this.gameDay() + t.credit : null,
    }));
  // расписки: мои долги и долги мне
  you.ious = {
    owe: this.state.ious.filter((x) => x.status === 'open' && x.debtorId === p.id).map((x) => this.iouView(x)),
    held: this.state.ious.filter((x) => x.status === 'open' && x.holderId === p.id).map((x) => this.iouView(x)),
  };
  you.elderOf = this.elderOf(p.apartment.floor)?.id === p.id ? p.apartment.floor : null;
  you.rentDebt = p.rentDebt || 0;
  you.furniture = Object.keys(p.furniture || {});
  you.stash = Object.entries(p.stash || {}).map(([id, count]) => ({ id, count, name: C.ITEMS[id]?.name || id }));
  you.window = Object.entries(p.window || {}).map(([id, count]) => ({ id, count, name: C.ITEMS[id]?.name || id }));
  you.day = this.gameDay();

  return {
    building: C.BUILDING.name,
    you,
    world: {
      clock,
      paused: w.paused,
      fog,
      power: w.power ? { from: w.power.from, to: w.power.to } : null,
      dark: this.isDark(p.location.floor),
      lift: { broken: !!w.breakdowns.lift, reason: w.breakdowns.lift?.reason || null },
      extraFloor: w.anomalies.extraFloor ? w.anomalies.extraFloor.label : null,
      repairs: Object.fromEntries(Object.entries(w.breakdowns).filter(([, b]) => b && b.repairable && b.until).map(([k, b]) => [k, Math.max(0, Math.round((b.until - this.now()) / 60000))])),
      cutleryStolen: w.cutleryStolen,
      online: this.onlineSet.size,
    },
    facilities,
    here,
    trades,
  };
};

Game.prototype.describePlace = function describePlace(p) {
  const l = p.location;
  const w = this.world;
  const dark = this.isDark(l.floor);
  // в толпе (столовая, цех) — ближайшие PEOPLE_SHOWN: с ними и можно что-то сделать, остальные — числом
  let others = this.othersAt(p);
  const crowd = others.length > PEOPLE_SHOWN ? others.length - PEOPLE_SHOWN : 0;
  if (crowd) {
    const d = (q) => Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y);
    others = others.map((q) => [d(q), q]).sort((a, b) => a[0] - b[0]).slice(0, PEOPLE_SHOWN).map((x) => x[1]).sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const people = others.map((q) => ({
    id: q.id,
    name: q.name,
    apt: q.apartment.number,
    symptoms: q.conditions.map((c) => C.CONDITIONS[c.id]?.symptom).filter(Boolean),
    rank: this.bestRank(q),
    rumor: this.rumor(q),
  }));
  // у себя дома хозяин видит и гостей, ушедших из сети: иначе выходом из игры можно удерживать чужое укрытие
  if (this.isOwnHome(p)) {
    for (const q of this.playersAt(this.locationKey(p))) {
      if (q.id === p.id || this.isOnline(q.id)) continue;
      people.push({ id: q.id, name: q.name, apt: q.apartment.number, symptoms: [], rank: this.bestRank(q), away: true });
    }
  }
  const here = { key: this.locationKey(p), place: l.place, floor: l.floor, title: this.placeTitle(p), text: '', people, crowd, shop: null, residents: null, closed: null };
  here.hazards = (this.world.hazards[here.key] || []).map((hz) => ({ id: hz.id, kind: hz.kind, name: C.HAZARDS[hz.kind].name, x: hz.x, y: hz.y, fenced: !!hz.fenced }));
  here.scars = this.scarsView(here.key);
  if (l.place === 'home') here.furniture = Object.keys(this.furnitureAt(this.currentApt(p)));
  const clim = l.floor != null ? this.climateAt(l.floor) : null;
  here.climate = clim ? { kind: clim.kind, name: C.CLIMATES[clim.kind].name, harm: clim.harm > 0 } : null;

  switch (l.place) {
    case 'home': {
      const apt = this.currentApt(p);
      const door = `Гермодверь ${this.doorSealed(apt) ? 'задраена' : 'открыта'}.`;
      here.ownHome = apt === p.apartment.number;
      if (here.ownHome) {
        here.text = `Ваша квартира. Голые бетонные стены, продавленная кровать, радиоточка бормочет о перевыполнении плана. ${door}${p.sleeping ? ' Вы спите.' : ''}`;
      } else {
        const owner = this.ownerOf(apt);
        here.host = owner ? { id: owner.id, name: owner.name } : null;
        here.title = `Кв. ${apt} · в гостях`;
        here.text = `Чужая квартира${owner ? ` — здесь живёт ${owner.name}` : ''}. Вы в гостях. ${door}`;
      }
      break;
    }
    case 'corridor': {
      const kind = this.map.floorKind(l.floor);
      if (dark) here.text = `Коридор ${l.floor} этажа. Темно, хоть глаз выколи. Где-то капает.`;
      else if (kind === 'technical') here.text = `Технический этаж ${l.floor}. Голый бетон, трубы под потолком, запертые двери. Здесь никто не живёт — и, кажется, давно.${this.world.baryga && this.world.baryga.floor === l.floor ? ' Из тёмного угла тянет табаком: там кто-то торгует.' : ''}`;
      else if (kind === 'service') here.text = `Служебный этаж ${l.floor}. Двери подсобок заперты. Табличка у двустворчатой двери: «${C.FACILITIES[this.map.facilityByFloor[l.floor]].name}».`;
      else here.text = `Коридор ${l.floor} этажа. Лампы дневного света гудят и мигают. Пахнет сыростью и чужим ужином.`;
      here.floorKind = kind;
      const residents = [];
      const elderHere = this.elderOf(l.floor);
      for (let i = 1; i <= C.BUILDING.apartmentsPerFloor; i++) {
        const number = `${l.floor}${String(i).padStart(2, '0')}`;
        const r = this.ownerOf(number);
        // недавно погибший: на двери «†», пока квартиру не займут
        const dead = r ? null : this.lastDeadIn(number);
        residents.push({ number, name: r ? r.name : dead ? `† ${dead.name}` : null, online: r ? this.isOnline(r.id) : false, you: r?.id === p.id, dead: !!dead, rumor: r ? this.rumor(r) : [], elder: !!(r && elderHere && elderHere.id === r.id) });
      }
      if (kind === 'residential') here.residents = residents;
      here.lampsOut = this.world.lampsOut[l.floor] || [];
      if (here.lampsOut.length && !dark) here.text += ` Плафонов не горит: ${here.lampsOut.length}.`;
      break;
    }
    case 'canteen':
    case 'medpost': {
      const st = this.facilityStatus(l.place);
      here.text = l.place === 'canteen'
        ? 'Столовая №3. Запах тушёной капусты и хлорки. Над раздачей плакат: «Хлеб — всему голова».'
        : 'Медпункт. Кушетка, шкаф с амбарным замком, плакат «Туман — не шутка!». Фельдшер смотрит устало.';
      if (!st.open) here.closed = st.reason;
      here.shop = this.shopEntries(l.place)
        .filter((e) => !(e.hiddenIfStolen && w.cutleryStolen))
        .map((e) => ({
          key: e.key,
          name: e.name,
          desc: e.desc,
          price: e.price,
          eat: !!e.eat,
          left: e.daily == null ? null : this.state.stock[l.place][e.key] || 0,
          note: e.needsSpoon && w.cutleryStolen ? 'нужна своя ложка' : null,
        }));
      here.supplyAt = `0${B.supplyHour}:00`;
      here.sideJob = this.sideJobHere(p);
      break;
    }
    case 'factory': {
      const st = this.facilityStatus('factory');
      here.text = 'Цех №4. Грохот станков, конвейер уходит в темноту. Мастер с журналом выдаёт наряды.';
      if (!st.open) here.closed = st.reason;
      here.jobs = Object.entries(MG.WORK_GAMES).map(([id, g]) => ({ id, name: g.name, rank: this.rankOf(p, id) }));
      p.shiftLog = (p.shiftLog || []).filter((t) => this.now() - t < 3600 * 1000);
      here.shiftsLeft = Math.max(0, B.shiftsPerHour - p.shiftLog.length);
      here.workCost = { energy: B.workEnergyCost, hunger: B.workHungerCost };
      break;
    }
    case 'lift':
      here.text = p.travel?.stuck
        ? 'Лифт застрял между этажами. Лампа мигает. Кнопка вызова диспетчера не работает.'
        : `Лифт скрипит и гудит. Табличка: «Грузоподъёмность 400 кг». Едем на ${p.travel?.toFloor ?? '?'} этаж.`;
      break;
    case 'stairs':
      here.text = `Бесконечные пролёты лестницы. Идёте на ${p.travel?.toFloor ?? '?'} этаж.`;
      break;
    default:
      here.text = '';
  }
  if (here.climate && l.place !== 'lift' && l.place !== 'stairs') here.text += ` ${C.CLIMATES[here.climate.kind].text}`;
  return here;
};

Game.prototype.adminSnapshot = function adminSnapshot() {
  const now = this.now();
  const w = this.world;
  return {
    clock: this.gameClock(),
    world: {
      paused: w.paused,
      fog: w.fog ? { ...w.fog, phase: this.fogPhase(), inSec: Math.max(0, Math.round((w.fog.warnUntil - now) / 1000)), endsInSec: Math.max(0, Math.round((w.fog.until - now) / 1000)) } : null,
      power: w.power ? { ...w.power, endsInSec: w.power.until ? Math.round((w.power.until - now) / 1000) : null } : null,
      breakdowns: Object.fromEntries(
        Object.entries(w.breakdowns).map(([k, b]) => [k, b ? { reason: b.reason, endsInSec: b.until ? Math.round((b.until - now) / 1000) : null, repairable: !!b.repairable } : null]),
      ),
      cutleryStolen: w.cutleryStolen,
      shiftsToday: w.shiftsToday || 0,
      supplyNext: w.supplyNext ?? 1,
      lampsOutFloors: Object.keys(w.lampsOut).length,
      rent: this.rentAmount(),
      baryga: w.baryga ? { floor: w.baryga.floor, purse: w.baryga.purse } : null,
      overlays: Object.entries(w.overlays).flatMap(([scene, list]) => list.map((o) => ({ id: o.id, scene, title: this.sceneTitle(scene), kind: o.kind, label: o.label || null }))),
      anomalies: w.anomalies,
      climate: w.climate.map((c) => ({ ...c, name: C.CLIMATES[c.kind].name, leftMin: c.until ? Math.max(0, Math.ceil((c.until - now) / 60000)) : null })),
      puppets: Object.values(w.puppets).map((pp) => ({ id: pp.id, name: pp.name, preset: pp.preset, scene: pp.scene, title: this.sceneTitle(pp.scene) })),
      plan: w.plan ? { done: w.plan.done, target: w.plan.target, week: w.plan.week + 1, participants: Object.keys(w.plan.participants).length } : null,
      stock: this.state.stock,
      radio: { queue: w.radio.queue, silenceSec: w.radio.silenceUntil ? Math.max(0, Math.round((w.radio.silenceUntil - now) / 1000)) : 0, log: w.radio.log },
      scarsCount: Object.values(w.scars).reduce((n, l) => n + l.length, 0),
    },
    online: this.onlineSet.size,
    archived: this.state.archive.length,
    director: this.director(),
    snapshots: this.snapshotsMeta(),
    scenarioRuns: this.scenarioRunsView(),
    scenarios: [
      ...Object.entries(C.SCENARIOS).map(([id, d]) => ({ id, name: d.name, steps: d.steps.length, builtin: true })),
      ...Object.entries(this.state.scenarios).map(([id, d]) => ({ id, name: d.name, steps: d.steps.length, builtin: false })),
    ],
    assignments: this.state.assignments.map((a) => ({ ...this.assignmentView(a, null), closed: !!a.closed, failed: a.failed || [] })),
    petitions: this.state.petitions.filter((x) => x.status !== 'expired').map((x) => ({ ...this.petitionView(x, null), floor: x.floor })),
    hazards: Object.entries(this.world.hazards).flatMap(([key, list]) => list.map((hz) => ({ ...hz, scene: key, title: this.sceneTitle(key), name: C.HAZARDS[hz.kind].name }))),
    schedule: this.state.schedule
      .slice()
      .sort((a, b) => a.at - b.at)
      .map((e) => ({ id: e.id, label: e.label, cmd: e.cmd, inSec: Math.max(0, Math.round(((w.paused && w.pausedAt ? e.at + (now - w.pausedAt) : e.at) - now) / 1000)), repeatSec: e.repeatMs ? Math.round(e.repeatMs / 1000) : null, runs: e.runs || 0 })),
    players: this.players().map((p) => (!p.alive ? {
      id: p.id,
      name: p.name,
      apartment: p.apartment,
      alive: false,
      deathCause: p.deathCause,
      diedAt: p.diedAt,
      online: this.isOnline(p.id),
      stats: { health: 0, hunger: 0, energy: 0, sanity: 0 },
      money: 0,
      inventory: {},
      location: { ...p.location, title: this.placeTitle(p) },
      travel: null,
      conditions: [],
      shifts: p.shifts || 0,
      lastSeen: p.lastSeen,
      account: p.account ? (this.state.accounts[p.account] || {}).login || p.account : null,
      banned: !!this.banInfo(p),
    } : {
      id: p.id,
      name: p.name,
      apartment: p.apartment,
      alive: p.alive,
      deathCause: p.deathCause,
      online: this.isOnline(p.id),
      stats: Object.fromEntries(STAT_KEYS.map((k) => [k, Math.round(p.stats[k])])),
      money: p.money,
      inventory: p.inventory,
      location: { ...p.location, title: this.placeTitle(p) },
      scene: this.locationKey(p),
      travel: p.travel ? { via: p.travel.via, toFloor: p.travel.toFloor, stuck: !!p.travel.stuck } : null,
      sealed: this.doorSealed(p.apartment.number),
      guestAt: p.location.place === 'home' && this.currentApt(p) !== p.apartment.number ? this.currentApt(p) : null,
      sleeping: p.sleeping,
      homeward: !!p.homeward,
      account: p.account ? (this.state.accounts[p.account] || {}).login || p.account : null,
      mutedMin: this.mutedFor(p),
      harmsHour: (p.harmLog || []).filter((t) => now - t < 3600 * 1000).length,
      rumor: this.rumor(p),
      deeds: p.deedTotals || {},
      elder: this.elderOf(p.apartment.floor)?.id === p.id,
      rentDebt: p.rentDebt || 0,
      techVisit: (p.techVisits || []).length ? p.techVisits[p.techVisits.length - 1] : null,
      furniture: Object.keys(p.furniture || {}).map((id) => C.ITEMS[id]?.name || id),
      push: (p.push || []).length,
      suspicious: (p.sameIpGifts || 0) >= 2,
      debts: this.state.ious.filter((x) => x.debtorId === p.id && this.iouOverdue(x)).length,
      goodness: Math.round(this.goodness(p) * 10) / 10,
      ranks: Object.fromEntries(Object.keys(MG.WORK_GAMES).map((g) => [g, this.rankOf(p, g)])),
      newbie: this.isNewbie(p),
      banned: !!this.banInfo(p),
      down: p.down ? Math.max(0, Math.ceil((p.down.until - now) / 1000)) : null,
      working: !!p.job,
      shifts: p.shifts || 0,
      conditions: p.conditions.map((c) => ({ id: c.id, name: C.CONDITIONS[c.id]?.name || c.id, remainingSec: c.until ? Math.round((c.until - now) / 1000) : null })),
      lastSeen: p.lastSeen,
    })),
  };
};

Game.prototype.adminContent = function adminContent() {
  const pickNames = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { name: v.name, ...(v.kind ? { kind: v.kind } : {}) }]));
  return {
    building: C.BUILDING,
    facilities: C.FACILITIES,
    items: pickNames(C.ITEMS),
    conditions: pickNames(C.CONDITIONS),
    accidents: Object.fromEntries(Object.entries(C.ACCIDENTS).map(([k, v]) => [k, { name: v.effect && v.effect.kill ? `${v.name} — смертельно` : v.name, text: v.text }])),
    breakdowns: pickNames(C.BREAKDOWNS),
    places: Object.fromEntries(MOVE_PLACES.map((k) => [k, C.PLACES[k].name])),
    hazards: Object.fromEntries(Object.entries(C.HAZARDS).map(([k, v]) => [k, v.name])),
    climates: Object.fromEntries(Object.entries(C.CLIMATES).map(([k, v]) => [k, v.name])),
    presets: C.CUSTOM_PRESETS,
    scenarios: { ...C.SCENARIOS, ...this.state.scenarios },
    scenarioCmds: SCENARIO_CMDS,
    shopNames: Object.fromEntries(Object.keys(C.SHOPS).flatMap((shop) => this.shopEntries(shop).map((e) => [e.key, e.name]))),
    palette: this.state.palette,
    world: this.worldConfig(),
  };
};

module.exports = { Game, freshState, sanitizeName, sanitizeText, nameSkeleton, ADMIN_COMMANDS, WORLD_CONFIG, ROLE_NAMES };
