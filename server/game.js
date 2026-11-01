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
const HOMOGLYPHS = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', ё: 'е', 3: 'з', 0: 'о', 6: 'б' };
/** «Скелет» имени: без регистра, пробелов, знаков, с одинаковыми буквами-двойниками. */
function nameSkeleton(name) {
  return String(name || '')
    .toLocaleLowerCase('ru')
    .replace(/[\s._\-]/g, '')
    .replace(/[abcehkmoptxyё306]/g, (ch) => HOMOGLYPHS[ch] || ch);
}

function sanitizeName(raw) {
  const name = sanitizeText(raw, 40).replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 20);
  return name.length >= 2 ? name : null;
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
    this.map = World.create(WORLD_CONFIG);
    this.state.palette = this.state.palette || { conditions: {}, accidents: {}, items: {} };
    this.applyPalette();
    if (!this.state.stock) this.state.stock = this.fullStock(1);
    if (this.world.lastSupplyDay == null) {
      // сегодняшний завоз уже был, если сейчас позже часа завоза
      const day = Math.floor(this.world.gameMinutes / 1440);
      const hour = Math.floor((this.world.gameMinutes % 1440) / 60);
      this.world.lastSupplyDay = hour >= B.supplyHour ? day : day - 1;
    }
    this.lastKnock = new Map();
    this.knocks = new Map(); // хозяин → кто стучит { guestId, ts }
    this.groupSince = new Map(); // сцена → с какого момента там собралось 3+ жильцов (для режиссёра)
    this.refusals = new Map(); // гость → кто не открыл ему в туман или выставил { apt, owner, ts, kind }
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
        // смену прервал перезапуск сервера — силы и сытость, потраченные на неё, возвращаются
        p.stats.energy = Math.min(100, (p.stats.energy || 0) + B.workEnergyCost);
        p.stats.hunger = Math.min(100, (p.stats.hunger || 0) + B.workHungerCost);
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

  alivePlayers() {
    return this.players().filter((p) => p.alive);
  }

  getPlayer(id) {
    return this.state.players[id] || null;
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
        if (this.inFog(here.floor)) return wait(5000); // за дверью туман — ждём внутри
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

    // 3. Чужой этаж — к лифту (или лестнице) и наверх/вниз. В туман на своём этаже не едет.
    if (this.inFog(homeFloor)) return wait(5000);
    const via = this.world.breakdowns.lift ? 'stairs' : 'lift';
    const target = scene.objects.find((o) => o.type === via);
    if (h.step !== via) {
      h.step = via;
      h.nextAt = now + this.walkMs(p.pos, target && target.spot);
      return;
    }
    if (target && target.spot) p.pos = { x: target.spot.x, y: target.spot.y, d: 'up' };
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
    for (const g of Object.keys(MG.GAMES)) {
      const rank = this.rankOf(dead, g);
      if (rank > 1) skills[g] = C.RANKS[rank - 2];
    }
    heir.skills = skills;
    const items = Object.keys(dead.inventory || {});
    const parts = [];
    if (items.length) {
      const id = items[Math.floor(this.random() * items.length)];
      this.addItem(heir, id, 1);
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
    if (p.location.place === 'home') lines.push('Вы проснулись у себя дома.');
    else if (p.travel && p.travel.stuck) lines.push('Вы очнулись в застрявшем лифте.');
    else if (p.travel) lines.push(p.travel.via === 'stairs' ? 'Вы очнулись по дороге — на лестнице.' : 'Вы очнулись по дороге — в лифте.');
    else lines.push(`До дома вы так и не дошли: ${this.placeTitle(p)}.`);
    if (a.stats) {
      const parts = STAT_KEYS.map((k) => [STAT_NAMES[k], a.stats[k], Math.round(p.stats[k])]).filter(([, was, now2]) => was !== now2);
      if (parts.length) lines.push(parts.map(([n, was, now2]) => `${n}: ${was} → ${now2}`).join(' · '));
    }
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

  /** Уведомление (всплывашка) + запись в личный журнал. */
  notify(players, { title, text, style = 'info', journal = true, action = null, ask = null }) {
    const list = players.filter(Boolean);
    for (const p of list) if (journal) this.journal(p, title ? `${title}. ${text}` : text, style);
    this.emit('notify', { to: list.map((p) => p.id), title, text, style, action, ask });
    this.dirty(list.map((p) => p.id));
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

  addItem(p, id, n = 1) {
    if (!C.ITEMS[id] || n <= 0) return;
    p.inventory[id] = (p.inventory[id] || 0) + n;
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
    const now = this.now();
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

  ownerOf(apt) {
    return this.alivePlayers().find((q) => q.apartment.number === apt) || null;
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
    const key = this.locationKey(p);
    return this.alivePlayers().filter((q) => q.id !== p.id && this.isOnline(q.id) && this.locationKey(q) === key);
  }

  sceneOf(p) {
    return this.map.scene(this.locationKey(p));
  }

  /** Перенести жильца в другое место (сцену) — он появится у нужного входа. */
  relocate(p, location, entry = 'default') {
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
    p.pos = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, d: ['up', 'down', 'left', 'right'].includes(dir) ? dir : p.pos.d };
    if (dist > 0.01) {
      p.movedAt = now;
      if (p.sleeping && dist > 0.1) p.sleeping = false;
      this.checkHazards(p, now);
    }
    return true;
  }

  /** Наступил на опасность, которую поставил бог (если её не огородили). */
  checkHazards(p, now) {
    const list = this.world.hazards[this.locationKey(p)];
    if (!list || !list.length) return;
    for (const hz of list) {
      if (hz.fenced || Math.hypot(p.pos.x - hz.x, p.pos.y - hz.y) > 0.45) continue;
      p.hazardHits = p.hazardHits || {};
      if (now - (p.hazardHits[hz.id] || 0) < 10000) continue;
      p.hazardHits[hz.id] = now;
      const def = C.HAZARDS[hz.kind];
      const acc = C.ACCIDENTS[def.accident];
      this.accidentScar(p, def.accident, hz);
      this.notify([p], { title: def.name, text: acc.text, style: 'danger' });
      this.markHarm(p);
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
    p.deeds = p.deeds || { helped: 0 };
    p.deeds.helped++;
    this.journal(p, `Вы огородили: ${C.HAZARDS[hz.kind].name}. Теперь никто не наступит.`, 'good');
    this.log(`${p.name} огородил опасность: ${C.HAZARDS[hz.kind].name} (${this.placeTitle(p)})`, 'social', p.id);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
    return { ok: true, message: 'Огорожено. Табличка «Осторожно» висит.' };
  }

  /** Кого видно в сцене: живые жильцы в сети. */
  sceneActors(key) {
    const now = this.now();
    return this.alivePlayers()
      .filter((p) => this.locationKey(p) === key)
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
      }));
  }

  /** Темно ли там, где стоит жилец: нет света на этаже или в коридоре погасла половина ламп. */
  isDarkFor(p) {
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
    this.dirty([p.id, ...others.map((q) => q.id)]);
    return { ok: true, message: 'Стало светлее.' };
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
    const taken = new Set(this.alivePlayers().map((p) => p.apartment.number));
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
    };
    this.state.players[id] = p;
    this.byToken.set(token, id);
    if (account) this.linkAccount(p, account);
    if (heirOf) this.inherit(p, heirOf);
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
    if (!ask) return { ok: false, error: 'Вопрос уже снят.' };
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
          const dead = this.players().find((q) => !q.alive && q.apartment.number === o.number && q.diedAt && this.now() - q.diedAt < B.tombstoneMin * 60000);
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
      if (!w.fog.arrived && now >= w.fog.warnUntil) {
        w.fog.arrived = true;
        const f = w.fog;
        const victims = this.alivePlayers().filter((p) => p.location.floor >= f.from && p.location.floor <= f.to);
        this.notify(victims, {
          title: 'ТУМАН',
          text: 'Туман пришёл на ваш этаж. Если вы не за закрытой гермодверью — бегите.',
          style: 'fog',
        });
        this.log(`Туман накрыл этажи ${f.from}–${f.to}`, 'event');
      }
      if (now >= w.fog.until) this.endFog();
    }
    for (const t of Object.values(this.state.trades)) {
      if (now - t.createdAt > 3 * 60000) delete this.state.trades[t.id];
    }
    if (this.world.tick % 60 === 0) {
      this.archiveDead(now);
      this.expireBoardNotes(now);
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

  /** Следы сцены для отрисовки: fade — насколько выцвел (0 — свежий, 1 — почти исчез). */
  scarsView(key) {
    const ttl = B.scarHours * 3600 * 1000;
    const now = this.now();
    return (this.world.scars[key] || []).map((sc) => ({ id: sc.id, kind: sc.kind, x: sc.x, y: sc.y, fade: Math.min(1, Math.max(0, (now - sc.at) / ttl)), ...(sc.text ? { text: sc.text, by: sc.by } : {}) }));
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
    const need = Math.max(6, this.alivePlayers().length * B.supplyShiftsPerResident);
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
      const condition = raw.condition && C.CONDITIONS[raw.condition] ? raw.condition : undefined;
      return { name, text: sanitizeText(raw.text, 300) || name, effect: { ...stats(raw.effect, -200, 200), ...(raw.kill ? { kill: true } : {}) }, condition, custom: true };
    }
    if (type === 'items') {
      const cure = (Array.isArray(raw.cure) ? raw.cure : []).filter((c) => C.CONDITIONS[c]);
      const use = { ...stats(raw.use, -100, 100), ...(cure.length ? { cure } : {}) };
      return { name, desc: sanitizeText(raw.desc, 120) || '', ...(Object.keys(use).length ? { use } : {}), custom: true };
    }
    throw new Error('Нет такого раздела палитры');
  }

  /** Планировщик ЖЭК: выполнить команды, время которых пришло. */
  runSchedule(now) {
    const due = this.state.schedule.filter((e) => now >= e.at).slice(0, 10);
    for (const e of due) {
      const res = this.admin(e.cmd, JSON.parse(JSON.stringify(e.args || {})));
      e.runs = (e.runs || 0) + 1;
      this.log(`По расписанию: ${e.label}${res.ok ? (res.message ? ` — ${res.message}` : '') : ` — не вышло: ${res.error}`}`, 'schedule');
      if (e.repeatMs) {
        e.at += e.repeatMs;
        if (e.at <= now) e.at = now + e.repeatMs;
      } else {
        this.state.schedule = this.state.schedule.filter((x) => x !== e);
      }
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
    for (const p of this.players()) {
      for (const c of p.conditions) if (c.until) c.until += ms;
      if (p.travel && !p.travel.stuck) {
        p.travel.arriveAt += ms;
        p.travel.startedAt += ms;
      }
      if (p.down) p.down.until += ms;
      if (p.homeward && p.homeward.nextAt) p.homeward.nextAt += ms;
      if (p.job) p.job.startedAt += ms;
    }
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
    } else if (p.stats.hunger > 50 && p.conditions.length === 0 && !fogged) {
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
    const now = this.now();
    p.travel = { via, toPlace: 'corridor', toFloor: floor, fromFloor: from, startedAt: now, arriveAt: now + sec * 1000 };
    this.relocate(p, { place: via, floor: from });
    this.dirty([...witnesses, ...this.othersAt(p)].map((q) => q.id));
    return { ok: true };
  }

  updateTravel(p, now) {
    const t = p.travel;
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
    const onlyCures = !u.hunger && !u.health && !u.sanity;
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
      if (c && c.until) c.until = this.now() + (c.until - this.now()) / 2;
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
    const now = this.now();
    p.down = { since: now, until: now + B.downSec * 1000, cause, robbedBy: [] };
    p.stats.health = 0;
    p.sleeping = false;
    p.job = null;
    p.homeward = null;
    this.notify([p], { title: 'Вы теряете сознание', text: 'В глазах темнеет. Может быть, кто-нибудь поможет…', style: 'danger' });
    this.log(`${p.name} без сознания: ${cause}`, 'accident', p.id);
    this.dirty([p.id, ...this.othersAt(p).map((q) => q.id)]);
  }

  /** Соседи рядом, до которых можно дотянуться. */
  canTouch(p, target) {
    return target && target.alive && target.id !== p.id && this.locationKey(target) === this.locationKey(p) && this.distance(p, target) <= B.touchReach;
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
    this.removeItem(p, itemId, 1);
    const parts = this.applyItemUse(t, itemId);
    const what = `${def.name}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    if (t.down) {
      const robbers = t.down.robbedBy;
      t.down = null;
      t.stats.health = Math.max(10, t.stats.health);
      t.lastHarm = null;
      this.notify([t], {
        title: 'Вы очнулись',
        text: `Вас привёл в чувство ${p.name}: ${what}.${robbers.length ? `\nПока вы лежали, в ваших карманах рылся: ${robbers.join(', ')}.` : ''}`,
        style: 'good',
      });
      this.log(`${p.name} привёл в чувство ${t.name}: ${what}`, 'social', p.id);
    } else {
      this.notify([t], { title: 'Помощь', text: `${p.name} дал вам: ${what}.`, style: 'good' });
      this.log(`${p.name} помог ${t.name}: ${what}`, 'social', p.id);
    }
    this.journal(p, `Вы помогли ${t.name}: ${what}.`, 'good');
    p.deeds = p.deeds || { helped: 0 };
    p.deeds.helped++;
    this.dirty([p.id, t.id, ...this.othersAt(t).map((q) => q.id)]);
    return { ok: true, message: t.down ? '' : `${t.name} приходит в себя.` };
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
    return Math.max(...Object.keys(MG.GAMES).map((g) => this.rankOf(p, g)));
  }

  /** Новосёл: первые часы его нельзя обокрасть (злые механики сначала бьют по новичкам). */
  isNewbie(p) {
    return this.now() - (p.createdAt || 0) < B.newbieProtectionH * 3600 * 1000;
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
    if (!this.isDark(p.location.floor) || p.location.place === 'lift' || p.location.place === 'stairs') return { ok: false, error: 'Светло — сразу заметят.' };
    if (this.isNewbie(t)) return { ok: false, error: 'Новосёла трогать — себе дороже: ЖЭК присматривает за новенькими.' };
    const now = this.now();
    if (now - (p.lastPickAt || 0) < B.pickpocketCooldownSec * 1000) return { ok: false, error: 'Слишком подозрительно — подождите.' };
    p.lastPickAt = now;
    const lit = [t, ...this.othersAt(p).filter((q) => q.id !== t.id)].some((q) => this.hasItem(q, 'flashlight'));
    if (this.random() >= B.pickpocketChance) {
      this.notify([t], { title: 'Чужая рука', text: `В темноте вы схватили за руку ${p.name}. Он лез к вам в карман.`, style: 'warn' });
      this.log(`${p.name} попался на попытке обшарить ${t.name} в темноте`, 'social', p.id);
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
      this.removeItem(t, id, 1);
      this.addItem(p, id, 1);
      what = C.ITEMS[id].name;
    } else {
      return { ok: true, message: 'Карманы пустые. Только крошки.' };
    }
    this.notify([t], { title: 'Карманы', text: lit ? `В свете фонарика видно, кто это был: ${p.name}. Пропало: ${what}.` : `В темноте кто-то обшарил ваши карманы. Пропало: ${what}.`, style: 'warn' });
    this.log(`${p.name} обшарил в темноте ${t.name}: ${what}${lit ? ' (его видели)' : ''}`, 'social', p.id);
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
        this.refusals.set(p.id, { apt: door.number, owner: owner.name, ts: now, kind: 'ignored' });
      }
      this.notify([owner], {
        title: 'Стук в дверь',
        text: `В глазок видно: ${p.name} из кв. ${p.apartment.number}${symptoms.length ? ` — ${symptoms.join(', ')}` : ''}.`,
        style: 'knock',
        journal: false,
        action: { label: 'Открыть', act: 'open_door', args: { guest: p.id } },
      });
      return { ok: true, message: 'Вы постучали. За дверью кто-то шевелится.' };
    }
    if (owner && !this.isOnline(owner.id) && owner.absence) {
      owner.absence.knocks.push({ name: p.name, apt: p.apartment.number, ts: now });
      if (owner.absence.knocks.length > 20) owner.absence.knocks.shift();
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
    return { ok: true, notes, pinned };
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
    owner.deeds = owner.deeds || { helped: 0 };
    owner.deeds.helped++;
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
    if (fog) this.refusals.set(guest.id, { apt: owner.apartment.number, owner: owner.name, ts: this.now(), kind: 'evicted' });
    this.notify([guest], { title: 'Вас выставили', text: `${owner.name} выставил вас за дверь кв. ${owner.apartment.number}.${fog ? ' В коридоре туман.' : ''}`, style: fog ? 'danger' : 'warn' });
    this.journal(owner, `Вы выставили ${guest.name} за дверь.`, 'warn');
    this.log(`${owner.name} выставил ${guest.name} за дверь${fog ? ' — в туман' : ''}`, 'social', owner.id);
    this.dirty([owner.id, guest.id, ...this.othersAt(guest).map((q) => q.id)]);
    return { ok: true };
  }

  /** Гостей хозяина, который умер или пропал, выводим в коридор. */
  evictAllGuests(apt, floor) {
    for (const q of this.alivePlayers()) {
      if (q.location.place === 'home' && this.currentApt(q) === apt && q.apartment.number !== apt) {
        this.relocate(q, { place: 'corridor', floor }, `apt:${apt}`);
        this.journal(q, `Хозяина кв. ${apt} больше нет. Вы вышли в коридор.`, 'warn');
        this.dirty([q.id]);
      }
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
    return { door, now };
  }

  addDrop(p, door, drop, now) {
    p.lastDropAt = now;
    if (!this.state.doorDrops[door.number]) this.state.doorDrops[door.number] = [];
    this.state.doorDrops[door.number].push({ id: newId('d'), ts: now, fromId: p.id, fromName: p.name, fromApt: p.apartment.number, ...drop });
    const owner = this.alivePlayers().find((q) => q.apartment.number === door.number);
    if (owner && this.isOnline(owner.id) && this.isOwnHome(owner)) this.collectDrops(owner);
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
    p.money -= bundle.money;
    for (const [id, n] of Object.entries(bundle.items)) this.removeItem(p, id, n);
    const text = sanitizeText(rawText, C.NOTES.maxLength);
    this.addDrop(p, check.door, { kind: 'parcel', bundle, text }, check.now);
    const what = this.bundleText(bundle);
    this.journal(p, `Вы оставили передачку у кв. ${check.door.number}: ${what}.`);
    p.deeds = p.deeds || { helped: 0 };
    p.deeds.helped++;
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
        for (const [id, n] of Object.entries(d.bundle.items)) this.addItem(p, id, n);
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
    if (p.location.place !== 'factory') return { ok: false, error: 'Работа — в цеху.' };
    const status = this.facilityStatus('factory');
    if (!status.open) return { ok: false, error: status.reason };
    if (p.job) return { ok: false, error: 'Вы уже на смене.' };
    if (!MG.GAMES[gameId]) return { ok: false, error: 'Такой работы нет.' };
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
    if (reward > 0) this.world.shiftsToday = (this.world.shiftsToday || 0) + 1;
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
    p.lastSaid = { text, ts: now };
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
      this.removeItem(from, id, n);
      this.addItem(to, id, n);
    }
  }

  bundleText(b) {
    const parts = [];
    if (b.money) parts.push(talons(b.money));
    for (const [id, n] of Object.entries(b.items)) parts.push(`${C.ITEMS[id].name}${n > 1 ? ` ×${n}` : ''}`);
    return parts.join(', ') || 'ничего';
  }

  tradeOffer(p, toId, rawGive, rawWant) {
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
      this.moveBundle(p, q, give);
      const what = this.bundleText(give);
      this.journal(p, `Вы отдали жильцу ${q.name}: ${what}.`);
      this.notify([q], { title: 'Подарок', text: `${p.name} (кв. ${p.apartment.number}) отдал вам: ${what}.`, style: 'good' });
      this.log(`${p.name} → ${q.name}: подарок (${what})`, 'trade', p.id);
      p.deeds = p.deeds || { helped: 0 };
      p.deeds.helped++;
      return { ok: true, gift: true };
    }

    const mine = Object.values(this.state.trades).filter((t) => t.from === p.id);
    if (mine.length >= 5) return { ok: false, error: 'Слишком много открытых предложений.' };
    const t = { id: newId('t'), from: p.id, to: q.id, give, want, createdAt: this.now() };
    this.state.trades[t.id] = t;
    this.notify([q], {
      title: 'Предложение обмена',
      text: `${p.name} предлагает: ${this.bundleText(give)} — в обмен на: ${this.bundleText(want)}.`,
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
    if (!this.hasBundle(b, t.want)) return { ok: false, error: 'У вас нет того, что просят.' };
    this.moveBundle(a, b, t.give);
    this.moveBundle(b, a, t.want);
    delete this.state.trades[t.id];
    this.journal(a, `Обмен с ${b.name}: отдали ${this.bundleText(t.give)}, получили ${this.bundleText(t.want)}.`, 'good');
    this.journal(b, `Обмен с ${a.name}: отдали ${this.bundleText(t.want)}, получили ${this.bundleText(t.give)}.`, 'good');
    this.notify([a], { title: 'Обмен состоялся', text: `${b.name} принял ваше предложение.`, style: 'good', journal: false });
    this.log(`Обмен ${a.name} ⇄ ${b.name}: ${this.bundleText(t.give)} ⇄ ${this.bundleText(t.want)}`, 'trade', a.id);
    return { ok: true };
  }

  // =========================================================================
  // Смерть
  // =========================================================================
  kill(p, cause) {
    if (!p.alive) return;
    p.alive = false;
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
    }
    this.refusals.delete(p.id);
    // мел на полу, а рядом — последнее, что жилец успел сказать
    if (p.pos && !p.travel) {
      const key = this.locationKey(p);
      this.scar(key, 'chalk', p.pos.x, p.pos.y);
      if (p.lastSaid && this.now() - p.lastSaid.ts < 6 * 3600 * 1000) this.scar(key, 'lastword', p.pos.x + 0.6, p.pos.y + 0.2, { text: p.lastSaid.text, by: p.name });
    }
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
    this.dirty([p.id]);
    return parts;
  }

  /** Точка входа для всех команд админки. */
  admin(cmd, args = {}) {
    const fn = ADMIN_COMMANDS[cmd];
    if (!fn) return { ok: false, error: `Неизвестная команда: ${cmd}` };
    try {
      return fn.call(this, args) || { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
    const now = this.now();
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
    });
    this.notify(elsewhere, { title: 'Сирена', text: `Где-то воет сирена: туман на этажах ${f.from}–${f.to}.`, style: 'warn' });
    this.systemChat(`ВНИМАНИЕ! Туман на этажах ${f.from}–${f.to}. Жильцам немедленно укрыться в квартирах.`);
    this.log(`Объявлен туман: этажи ${f.from}–${f.to}, сила ${f.intensity}, ${durationMin} мин`, 'event', null, { public: `туман на этажах ${f.from}–${f.to}` });
    if (f.warnUntil <= now) this.updateWorldTimers(now);
    return { ok: true };
  }

  endFog(silent = false) {
    if (!this.world.fog) return { ok: false, error: 'Тумана нет.' };
    const f = this.world.fog;
    this.world.fog = null;
    if (f.arrived) this.fogScars(f);
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
      const until = Number(durationMin) > 0 ? this.now() + Number(durationMin) * 60000 : null;
      const text = sanitizeText(reason, 200) || def.brokenText;
      this.world.breakdowns[key] = { since: this.now(), until, reason: text };
      if (key === 'factory') {
        const workers = this.alivePlayers().filter((p) => p.job);
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
    const until = Number(durationMin) > 0 ? this.now() + Number(durationMin) * 60000 : null;
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
    if (!ADMIN_COMMANDS[cmd] || ['schedule', 'unschedule', 'pause', 'erase'].includes(cmd)) throw new Error('Эту команду нельзя поставить в расписание');
    const now = this.now();
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
    if (p.down && p.stats.health > 0) p.down = null;
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
    if (this.alivePlayers().some((q) => q.apartment.number === p.apartment.number)) {
      const apt = this.allocateApartment();
      if (!apt) throw new Error('Дом переполнен — некуда вернуть жильца');
      p.apartment = apt;
    }
    p.name = this.freeName(p.name, p.id);
    p.alive = true;
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
    if (!pal[type] || !pal[type][id]) throw new Error('В палитре такого нет');
    const name = pal[type][id].name;
    delete pal[type][id];
    if (type === 'conditions') {
      delete C.CONDITIONS[id];
      for (const p of this.players()) p.conditions = p.conditions.filter((c) => c.id !== id);
    }
    if (type === 'accidents') delete C.ACCIDENTS[id];
    if (type === 'items') {
      delete C.ITEMS[id];
      for (const p of this.players()) delete p.inventory[id];
      // вещь исчезает отовсюду: из обменов, передачек под дверью и рецептов лечения
      for (const t of Object.values(this.state.trades)) if (t.give.items[id] || t.want.items[id]) delete this.state.trades[t.id];
      for (const drops of Object.values(this.state.doorDrops)) for (const d of drops) if (d.bundle && d.bundle.items) delete d.bundle.items[id];
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
          free.push(c);
        }
      }
      if (!free.length) throw new Error('Некуда поставить');
      pos = free[Math.floor(this.random() * free.length)];
    }
    const hz = { id: newId('h'), kind, x: pos.x, y: pos.y, fenced: false, until: Number(minutes) > 0 ? this.now() + Number(minutes) * 60000 : null };
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
    this.world.radio.silenceUntil = min > 0 ? this.now() + min * 60000 : null;
    this.log(min > 0 ? `Тишина в эфире на ${min} мин` : 'Эфир радиоточки возвращён', 'admin');
    return { ok: true, message: min > 0 ? `Радиоточки замолчали на ${min} мин` : 'Эфир вернулся' };
  },

  /** Подбросить жильцу записку под дверь — от кого угодно или без подписи. */
  plantNote({ id, text, from }) {
    const p = this.requirePlayer(id);
    const clean = sanitizeText(text, C.NOTES.maxLength);
    if (!clean) throw new Error('Пустая записка');
    const sign = sanitizeText(from, 40);
    const apt = p.apartment.number;
    if (!this.state.doorDrops[apt]) this.state.doorDrops[apt] = [];
    this.state.doorDrops[apt].push({ id: newId('d'), ts: this.now(), fromId: null, fromName: sign || '', fromApt: '—', kind: 'note', text: clean, anon: !sign, byZhek: true });
    if (this.isOnline(p.id) && this.isOwnHome(p)) this.collectDrops(p);
    this.log(`Записка под дверь ${p.name}${sign ? ` от «${sign}»` : ' без подписи'}: «${clean}»`, 'admin', p.id);
    return { ok: true, message: this.isOwnHome(p) ? 'Записка у жильца' : 'Записка ждёт под дверью' };
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

  breakdown({ key, broken, durationMin, reason }) {
    return this.setBreakdown(key, broken, { durationMin, reason });
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
      readable: !!C.ITEMS[id]?.read,
      equip: !!C.ITEMS[id]?.equip,
    })),
    gasmaskCharge: Math.round(p.gasmaskCharge),
    flashCharge: Math.round(p.flashCharge ?? 100),
    skills: Object.entries(MG.GAMES).map(([id, g]) => {
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
      return g ? { id: g.id, name: g.name, apt: g.apartment.number } : null;
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
    }));

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
  const people = this.othersAt(p).map((q) => ({
    id: q.id,
    name: q.name,
    apt: q.apartment.number,
    symptoms: q.conditions.map((c) => C.CONDITIONS[c.id]?.symptom).filter(Boolean),
    rank: this.bestRank(q),
  }));
  const here = { key: this.locationKey(p), place: l.place, floor: l.floor, title: this.placeTitle(p), text: '', people, shop: null, residents: null, closed: null };
  here.hazards = (this.world.hazards[here.key] || []).map((hz) => ({ id: hz.id, kind: hz.kind, name: C.HAZARDS[hz.kind].name, x: hz.x, y: hz.y, fenced: !!hz.fenced }));
  here.scars = this.scarsView(here.key);

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
      else if (kind === 'technical') here.text = `Технический этаж ${l.floor}. Голый бетон, трубы под потолком, запертые двери. Здесь никто не живёт — и, кажется, давно.`;
      else if (kind === 'service') here.text = `Служебный этаж ${l.floor}. Двери подсобок заперты. Табличка у двустворчатой двери: «${C.FACILITIES[this.map.facilityByFloor[l.floor]].name}».`;
      else here.text = `Коридор ${l.floor} этажа. Лампы дневного света гудят и мигают. Пахнет сыростью и чужим ужином.`;
      here.floorKind = kind;
      const residents = [];
      for (let i = 1; i <= C.BUILDING.apartmentsPerFloor; i++) {
        const number = `${l.floor}${String(i).padStart(2, '0')}`;
        const r = this.alivePlayers().find((q) => q.apartment.number === number);
        // недавно погибший: на двери «†», пока квартиру не займут
        const dead = r ? null : this.players().find((q) => !q.alive && q.apartment.number === number && q.diedAt && this.now() - q.diedAt < B.tombstoneMin * 60000);
        residents.push({ number, name: r ? r.name : dead ? `† ${dead.name}` : null, online: r ? this.isOnline(r.id) : false, you: r?.id === p.id, dead: !!dead });
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
      break;
    }
    case 'factory': {
      const st = this.facilityStatus('factory');
      here.text = 'Цех №4. Грохот станков, конвейер уходит в темноту. Мастер с журналом выдаёт наряды.';
      if (!st.open) here.closed = st.reason;
      here.jobs = Object.entries(MG.GAMES).map(([id, g]) => ({ id, name: g.name, rank: this.rankOf(p, id) }));
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
        Object.entries(w.breakdowns).map(([k, b]) => [k, b ? { reason: b.reason, endsInSec: b.until ? Math.round((b.until - now) / 1000) : null } : null]),
      ),
      cutleryStolen: w.cutleryStolen,
      shiftsToday: w.shiftsToday || 0,
      supplyNext: w.supplyNext ?? 1,
      lampsOutFloors: Object.keys(w.lampsOut).length,
      stock: this.state.stock,
      radio: { queue: w.radio.queue, silenceSec: w.radio.silenceUntil ? Math.max(0, Math.round((w.radio.silenceUntil - now) / 1000)) : 0, log: w.radio.log },
      scarsCount: Object.values(w.scars).reduce((n, l) => n + l.length, 0),
    },
    online: this.onlineSet.size,
    archived: this.state.archive.length,
    director: this.director(),
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
      ranks: Object.fromEntries(Object.keys(MG.GAMES).map((g) => [g, this.rankOf(p, g)])),
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
    palette: this.state.palette,
    world: WORLD_CONFIG,
  };
};

module.exports = { Game, freshState, sanitizeName, sanitizeText, nameSkeleton, ADMIN_COMMANDS, WORLD_CONFIG };
