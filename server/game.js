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
    this.lastKnock = new Map();
    this.knocks = new Map(); // хозяин → кто стучит { guestId, ts }
    this.refusals = new Map(); // гость → кто не открыл ему в туман или выставил { apt, owner, ts, kind }
    for (const p of Object.values(this.state.players)) {
      this.byToken.set(p.token, p.id);
      const scene = this.sceneOf(p);
      if (!p.pos || !World.canStand(scene, p.pos.x, p.pos.y)) p.pos = { ...this.map.spawn(scene.key), d: 'down' };
      p.posSeq = p.posSeq || 1;
      // после перезапуска сервера все не в сети: кто был не дома — идёт домой
      if (p.alive) {
        p.leftAt = p.leftAt || p.lastSeen || this.now();
        p.absence = p.absence || { knocks: [] };
        if (!this.isOwnHome(p) && !p.homeward) p.homeward = { since: this.now(), arriveAt: null };
      }
    }
  }

  static normalize(state) {
    const fresh = freshState();
    if (!state || typeof state !== 'object') return fresh;
    const s = { ...fresh, ...state };
    s.world = { ...fresh.world, ...(state.world || {}) };
    s.world.breakdowns = { ...fresh.world.breakdowns, ...((state.world || {}).breakdowns || {}) };
    for (const p of Object.values(s.players || {})) {
      p.inventory = p.inventory || {};
      p.conditions = p.conditions || [];
      p.journal = p.journal || [];
      p.gasmaskCharge = p.gasmaskCharge ?? 100;
      p.job = null; // незаконченные смены после перезапуска сервера сгорают
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
    if (!p) return;
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
    p.leftAt = now;
    p.absence = { knocks: [], stats: Object.fromEntries(STAT_KEYS.map((k) => [k, Math.round(p.stats[k])])), money: p.money };
    if (p.job) p.job = null;
    if (this.isOwnHome(p)) {
      p.sleeping = !this.hasCondition(p, 'insomnia');
    } else {
      // Выход из игры не спасает: тело идёт домой с обычной скоростью, застрявший остаётся в лифте,
      // а в тумане ждёт отбоя. Пока идёт — соседи его видят.
      p.homeward = { since: now, arriveAt: null };
    }
    this.dirty(this.othersAt(p).map((q) => q.id));
  }

  /** Сколько миллисекунд идти домой отсюда (null — путь закрыт). */
  routeHomeMs(p) {
    const here = p.location;
    const walk = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) / World.SPEED : 0);
    let sec = 0;
    let from = p.pos;
    if (here.place !== 'corridor') {
      const exit = this.sceneOf(p).objects.find((o) => o.type === 'exit' || o.type === 'hermodoor');
      sec += walk(from, exit && exit.spot) + 1;
      const corridor = this.map.scene(`corridor:${here.floor}`);
      const door = corridor.objects.find((o) => (here.place === 'home' ? o.type === 'apt' && o.number === this.currentApt(p) : o.type === 'facility'));
      from = door ? door.spot : this.map.spawn(corridor.key);
    }
    const home = this.map.scene(`corridor:${p.apartment.floor}`);
    const myDoor = home.objects.find((o) => o.type === 'apt' && o.number === p.apartment.number);
    if (here.floor !== p.apartment.floor) {
      const diff = Math.abs(here.floor - p.apartment.floor);
      const corridor = this.map.scene(`corridor:${here.floor}`);
      const liftWorks = !this.world.breakdowns.lift;
      if (!liftWorks && this.hasBlock(p, 'stairs')) return null;
      const exitObj = corridor.objects.find((o) => o.type === (liftWorks ? 'lift' : 'stairs'));
      sec += walk(from, exitObj && exitObj.spot);
      sec += liftWorks ? B.liftBaseSec + diff * B.liftSecPerFloor : diff * B.stairsSecPerFloor;
      const arrive = home.objects.find((o) => o.type === (liftWorks ? 'lift' : 'stairs'));
      sec += walk(arrive && arrive.spot, myDoor && myDoor.spot);
    } else {
      sec += walk(from, myDoor && myDoor.spot);
    }
    return Math.round((sec + 1) * 1000);
  }

  /** Тело ушедшего жильца бредёт домой. */
  updateHomeward(p, now) {
    const h = p.homeward;
    if (p.travel) return; // едет в лифте или идёт по лестнице — ждём прибытия (застрявший так и стоит)
    if (this.inFog(p.location.floor)) {
      h.arriveAt = null; // в тумане не идёт — ждёт отбоя
      return;
    }
    if (h.arriveAt == null) {
      const ms = this.routeHomeMs(p);
      if (ms == null) return;
      h.arriveAt = now + ms;
    }
    if (now < h.arriveAt) return;
    const witnesses = this.othersAt(p);
    p.homeward = null;
    this.relocate(p, { place: 'home', floor: p.apartment.floor, apt: p.apartment.number }, 'bed');
    p.sleeping = !this.hasCondition(p, 'insomnia');
    this.dirty(witnesses.map((q) => q.id));
  }

  /** Квитанция ЖЭК «Пока вас не было»: что случилось, пока жилец был не в сети. */
  sendReceipt(p, now) {
    const a = p.absence || { knocks: [] };
    const lines = [`Вас не было: ${fmtDuration(now - p.leftAt)}.`];
    if (p.location.place === 'home') lines.push('Вы проснулись у себя дома.');
    else if (p.travel && p.travel.stuck) lines.push('Вы очнулись в застрявшем лифте.');
    else if (p.travel) lines.push('Вы очнулись по дороге — в лифте.');
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
    const since = p.leftAt;
    const events = this.state.log.filter((e) => e.ts >= since && e.kind === 'event').slice(-6);
    if (events.length) lines.push('В доме:', ...events.map((e) => `— ${e.text}`));
    const neighbours = this.state.log.filter(
      (e) => e.ts >= since && (e.kind === 'death' || e.kind === 'join') && e.playerId !== p.id && e.floor === p.apartment.floor,
    );
    if (neighbours.length) lines.push('На вашем этаже:', ...neighbours.slice(-5).map((e) => `— ${e.text.replace(/^☠ /, 'умер: ')}`));
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

  log(text, kind = 'info', playerId = null) {
    const who = playerId ? this.getPlayer(playerId) : null;
    const entry = { ts: this.now(), clock: this.gameClock().label, text, kind, playerId, floor: who ? who.apartment.floor : null };
    this.state.log.push(entry);
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
    this.emit('log', entry);
  }

  journal(p, text, kind = 'info') {
    p.journal.push({ ts: this.now(), clock: this.gameClock().label, text, kind });
    if (p.journal.length > 40) p.journal.splice(0, p.journal.length - 40);
  }

  /** Уведомление (всплывашка) + запись в личный журнал. */
  notify(players, { title, text, style = 'info', journal = true, action = null }) {
    const list = players.filter(Boolean);
    for (const p of list) if (journal) this.journal(p, title ? `${title}. ${text}` : text, style);
    this.emit('notify', { to: list.map((p) => p.id), title, text, style, action });
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
    if (p.homeward) {
      if (this.isOwnHome(p)) p.homeward = null;
      else p.homeward.arriveAt = null;
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
    }
    return true;
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
        mask: this.hasItem(p, 'gasmask') && this.inFog(p.location.floor),
      }));
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

  /** Имя занято живым жильцом или зарезервировано за домом/ЖЭК? */
  nameTaken(name, exceptId = null) {
    const low = name.toLocaleLowerCase('ru');
    if (C.RESERVED_NAMES.some((r) => r.toLocaleLowerCase('ru') === low)) return 'Это имя занято домом. Выберите другое.';
    if (this.alivePlayers().some((q) => q.id !== exceptId && q.name.toLocaleLowerCase('ru') === low)) return 'Жилец с таким именем уже есть.';
    return null;
  }

  // =========================================================================
  // Регистрация
  // =========================================================================
  register(rawName) {
    const name = sanitizeName(rawName);
    if (!name) return { ok: false, error: 'Имя — от 2 до 20 букв или цифр.' };
    const taken = this.nameTaken(name);
    if (taken) return { ok: false, error: taken };
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
    };
    this.state.players[id] = p;
    this.byToken.set(token, id);
    this.journal(p, `Ордер на заселение получен. Ваша квартира — №${apartment.number}, ${apartment.floor} этаж. Голые стены, кровать и радиоточка.`);
    this.journal(p, `Еда стоит талонов. Талоны дают за смену в цеху (${C.FACILITIES.factory.floor} этаж). Столовая — на ${C.FACILITIES.canteen.floor} этаже.`);
    this.log(`Заселился новый жилец: ${name}, кв. ${apartment.number}`, 'join', id);
    this.systemChat(`В квартиру ${apartment.number} заселился новый жилец — ${name}.`);
    return { ok: true, player: p, token };
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
  }

  updateWorldTimers(now) {
    const w = this.world;
    this.runSchedule(now);
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
      if (p.homeward && p.homeward.arriveAt) p.homeward.arriveAt += ms;
      if (p.job) p.job.startedAt += ms;
    }
  }

  /** Давно погибших уносим из Пульта в архив домовой книги, чтобы снимок для админки не рос бесконечно. */
  archiveDead(now = this.now()) {
    const limit = C.ARCHIVE_DEAD_AFTER_H * 3600 * 1000;
    for (const p of this.players()) {
      if (p.alive || !p.diedAt || now - p.diedAt < limit) continue;
      this.state.archive.push({ id: p.id, name: p.name, apartment: p.apartment.number, createdAt: p.createdAt, diedAt: p.diedAt, deathCause: p.deathCause, shifts: p.shifts || 0 });
      if (this.state.archive.length > 5000) this.state.archive.splice(0, this.state.archive.length - 5000);
      delete this.state.players[p.id];
      this.byToken.delete(p.token);
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
      if (this.hasItem(p, 'gasmask')) {
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

    if (this.isDark(floor) && !this.hasItem(p, 'flashlight')) delta.sanity += B.darkSanityPerMin * dh;

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
        if (this.random() < def.contagious * d) {
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

  wearGasmask(p, d) {
    p.gasmaskCharge -= 20 * d; // одного противогаза хватает примерно на 5 минут тумана
    if (p.gasmaskCharge <= 0) {
      this.removeItem(p, 'gasmask', 1);
      p.gasmaskCharge = 100;
      this.journal(p, 'Фильтр противогаза забился. Противогаз пришёл в негодность.', 'danger');
      this.dirty([p.id]);
    }
  }

  hallucinate(p) {
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
    if (!def.use) return { ok: false, error: 'Это не используется. Зато можно обменять.' };
    if (!this.itemUseful(p, itemId)) return { ok: false, error: 'Вам это сейчас не нужно.' };
    p.sleeping = false;
    this.removeItem(p, itemId, 1);
    const parts = this.applyItemUse(p, itemId);
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
    this.dirty([p.id, t.id, ...this.othersAt(t).map((q) => q.id)]);
    return { ok: true, message: t.down ? '' : `${t.name} приходит в себя.` };
  }

  /** Обшарить карманы лежащего без сознания: все талоны и до двух вещей. */
  rob(p, targetId) {
    if (!p.alive) return { ok: false, error: 'Вы мертвы.' };
    if (p.down) return { ok: false, error: 'Вы без сознания.' };
    const t = this.getPlayer(targetId);
    if (!this.canTouch(p, t)) return { ok: false, error: 'Подойдите ближе.' };
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
      const who = d.anon ? 'без подписи' : `от ${d.fromName} (кв. ${d.fromApt})`;
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
    if (p.money < entry.price) return { ok: false, error: `Не хватает талонов (нужно ${entry.price}).` };
    p.money -= entry.price;
    if (entry.eat) {
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
    const job = MG.createJob(gameId);
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
    const text = sanitizeText(rawText, 300);
    if (!text) return { ok: false, error: 'Пустое сообщение.' };
    const now = this.now();
    if (now - (this.lastChatAt.get(p.id) || 0) < 700) return { ok: false, error: 'Не так быстро.' };
    this.lastChatAt.set(p.id, now);
    const msg = { id: newId('m'), ts: now, channel, from: { id: p.id, name: p.name, apt: p.apartment.number }, text };
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
    this.log(`☠ ${p.name} (кв. ${p.apartment.number}): ${cause}`, 'death', p.id);
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
  applyEffect(p, effect = {}, cause = 'Несчастный случай') {
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
    this.log(`Объявлен туман: этажи ${f.from}–${f.to}, сила ${f.intensity}, ${durationMin} мин`, 'event');
    if (f.warnUntil <= now) this.updateWorldTimers(now);
    return { ok: true };
  }

  endFog(silent = false) {
    if (!this.world.fog) return { ok: false, error: 'Тумана нет.' };
    const f = this.world.fog;
    this.world.fog = null;
    if (!silent) {
      this.notify(this.alivePlayers(), { title: 'Отбой', text: `Туман на этажах ${f.from}–${f.to} рассеялся.`, style: 'good' });
      this.systemChat(`Отбой тревоги. Туман на этажах ${f.from}–${f.to} рассеялся.`);
    }
    this.log(`Туман на этажах ${f.from}–${f.to} закончился`, 'event');
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
      this.log(`Сломано: ${def.name}${until ? ` (на ${durationMin} мин)` : ''} — ${text}`, 'event');
    } else {
      if (!this.world.breakdowns[key]) return { ok: false, error: 'Это и так работает.' };
      this.world.breakdowns[key] = null;
      this.notify(this.alivePlayers(), { title: 'Починили', text: `${def.name} снова работает.`, style: 'good' });
      this.log(`Починено: ${def.name}`, 'event');
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
    this.log(`Отключён свет на этажах ${pw.from}–${pw.to}`, 'event');
    return { ok: true };
  }

  restorePower() {
    const pw = this.world.power;
    if (!pw) return { ok: false, error: 'Свет и так есть.' };
    this.world.power = null;
    const lit = this.alivePlayers().filter((p) => p.location.floor >= pw.from && p.location.floor <= pw.to);
    this.notify(lit, { title: 'Свет дали', text: 'Лампы загудели снова.', style: 'good' });
    this.log(`Свет восстановлен на этажах ${pw.from}–${pw.to}`, 'event');
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
    this.log(`Украдены столовые приборы. Пострадали жильцы: ${victims.map((p) => p.name).join(', ') || 'никто'}`, 'event');
    return { ok: true };
  }

  returnCutlery() {
    this.world.cutleryStolen = false;
    this.systemChat('Столовая №3 получила новую партию ложек. Приятного аппетита.');
    this.log('Ложки в столовой вернули', 'event');
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
    if (this.nameTaken(p.name, p.id) && !C.RESERVED_NAMES.includes(p.name)) p.name = `${p.name} (вернулся)`.slice(0, 20);
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
    this.log(`Жилец ${p.name} стёрт из домовой книги`, 'admin');
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
    this.log(`Объявление: ${msg}`, 'event');
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
      equip: !!C.ITEMS[id]?.equip,
    })),
    gasmaskCharge: Math.round(p.gasmaskCharge),
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
  }));
  const here = { key: this.locationKey(p), place: l.place, floor: l.floor, title: this.placeTitle(p), text: '', people, shop: null, residents: null, closed: null };

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
        residents.push({ number, name: r ? r.name : null, online: r ? this.isOnline(r.id) : false, you: r?.id === p.id });
      }
      if (kind === 'residential') here.residents = residents;
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
          note: e.needsSpoon && w.cutleryStolen ? 'нужна своя ложка' : null,
        }));
      break;
    }
    case 'factory': {
      const st = this.facilityStatus('factory');
      here.text = 'Цех №4. Грохот станков, конвейер уходит в темноту. Мастер с журналом выдаёт наряды.';
      if (!st.open) here.closed = st.reason;
      here.jobs = Object.entries(MG.GAMES).map(([id, g]) => ({ id, name: g.name }));
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
    },
    online: this.onlineSet.size,
    archived: this.state.archive.length,
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
      travel: p.travel ? { via: p.travel.via, toFloor: p.travel.toFloor, stuck: !!p.travel.stuck } : null,
      sealed: this.doorSealed(p.apartment.number),
      guestAt: p.location.place === 'home' && this.currentApt(p) !== p.apartment.number ? this.currentApt(p) : null,
      sleeping: p.sleeping,
      homeward: !!p.homeward,
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
    accidents: Object.fromEntries(Object.entries(C.ACCIDENTS).map(([k, v]) => [k, { name: v.name, text: v.text }])),
    breakdowns: pickNames(C.BREAKDOWNS),
    places: Object.fromEntries(MOVE_PLACES.map((k) => [k, C.PLACES[k].name])),
  };
};

module.exports = { Game, freshState, sanitizeName, sanitizeText, ADMIN_COMMANDS, WORLD_CONFIG };
