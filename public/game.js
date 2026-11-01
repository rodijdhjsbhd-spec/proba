'use strict';

/* Клиент Гигахрущёвки. Сервер — источник правды: клиент рисует мир,
   двигает своего жильца (сервер проверяет стены и скорость) и отправляет действия. */
(() => {
  // ---------------------------------------------------------------------------
  // Утилиты
  // ---------------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);

  /** Безопасный конструктор DOM: весь текст идёт через textContent. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* приватный режим */ }
    },
  };

  const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с` : `${s} с`);
  const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

  // ---------------------------------------------------------------------------
  // Состояние клиента
  // ---------------------------------------------------------------------------
  const S = {
    ws: null,
    token: store.get('gh_token'),
    view: null,
    catalog: {},
    map: null, // World.create(...) — карты мира
    scene: null,
    sceneKey: null,
    posSeq: null,
    me: null, // { x, y, d, m } — своя позиция (двигаем локально)
    lastSent: { x: 0, y: 0, d: '', t: 0 },
    path: null,
    pathEnd: null,
    onArrive: null,
    stuckFor: 0,
    keys: new Set(),
    actors: new Map(),
    bubbles: new Map(),
    hover: null,
    near: null,
    sheet: null, // { kind, obj }
    chat: { local: [], global: [] },
    tab: 'local',
    unread: { local: 0, global: 0 },
    reqId: 0,
    pending: new Map(),
    memo: {},
    job: null,
    sound: store.get('gh_sound') !== 'off',
    retry: 0,
    shownAsks: new Set(), // вопросы ЖЭК, которые уже показаны
    lastHourBucket: null, // для сигналов радиоточки в 06:00 и 22:00
    regMode: 'new', // 'new' — новый жилец с паспортом, 'login' — вход по паспорту, 'newlife' — новая жизнь на том же паспорте
    ignored: new Set((() => {
      try { return JSON.parse(store.get('gh_ignored') || '[]'); } catch { return []; }
    })()),
  };

  const renderer = new Renderer($('#view'));
  new ResizeObserver(([entry]) => {
    const r = entry.contentRect;
    renderer.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
  }).observe($('#stage'));

  // ---------------------------------------------------------------------------
  // Связь
  // ---------------------------------------------------------------------------
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 0;
      $('#conn').hidden = true;
      if (!S.banned) send({ t: 'hello', token: S.token });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      $('#conn').hidden = false;
      for (const [, p] of S.pending) p({ ok: false, error: 'Нет связи' });
      S.pending.clear();
      setTimeout(connect, Math.min(10000, 800 * 2 ** S.retry++));
    };
  }

  function send(msg) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
  }

  /** Действие жильца. Ошибку показываем тостом, если не попросили молчать. */
  function act(action, args = {}, { quiet = false } = {}) {
    return new Promise((resolve) => {
      const id = ++S.reqId;
      S.pending.set(id, resolve);
      send({ t: 'act', id, action, args });
    }).then((res) => {
      if (!res.ok && !quiet) toast({ title: 'Не получилось', text: res.error, style: 'error' });
      return res;
    });
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'need_register':
        // Токен не стираем: если мир восстановят из копии, жилец найдётся при следующем входе.
        showRegister(S.token ? 'Жилец по вашему ордеру в домовой книге не найден: возможно, он давно погиб или мир начали заново. Можно заселиться снова.' : '');
        break;
      case 'register_error': {
        // ошибка новой жизни — на экране смерти, а не в скрытой форме входа
        const onDeath = !$('#death').hidden;
        if (onDeath) $('#rebirth-wait').textContent = msg.error;
        else $(S.regMode === 'login' ? '#login-error' : '#register-error').textContent = msg.error;
        toast({ title: onDeath ? 'Новый ордер не выдан' : S.regMode === 'login' ? 'Не вышло войти' : 'Ордер не выдан', text: msg.error, style: 'error' });
        break;
      }
      case 'need_new_life':
        // вошли по паспорту, но все жильцы этого паспорта погибли
        showRegister(`Паспорт «${msg.login}»: прошлые жильцы погибли. Дом не пустует долго — заселите нового.`, 'newlife');
        break;
      case 'banned': {
        const until = msg.until ? `до ${new Date(msg.until).toLocaleString('ru-RU')}` : 'навсегда';
        S.banned = true;
        showRegister(`ЖЭК закрыл вам вход ${until}. Причина: ${msg.reason}`, 'login');
        break;
      }
      case 'chat_delete':
        for (const ch of ['local', 'global']) S.chat[ch] = S.chat[ch].filter((m) => m.id !== msg.id);
        for (const [pid, b] of S.bubbles) if (b.msgId === msg.id) S.bubbles.delete(pid);
        renderChat();
        break;
      case 'catalog':
        // ЖЭК добавил новый предмет — обновим справочник названий
        S.catalog = msg.catalog || {};
        break;
      case 'welcome':
        S.banned = false;
        if (S.regMode === 'login' || S.regMode === 'newlife') S.regMode = 'new';
        S.token = msg.token;
        S.catalog = msg.catalog || {};
        S.config = msg.config || {};
        S.map = World.create(msg.world);
        S.sceneKey = null;
        store.set('gh_token', msg.token);
        $('#register').hidden = true;
        break;
      case 'view':
        if (S.banned) break; // экран бана не должен смениться игрой
        S.view = msg.view;
        S.viewAt = performance.now();
        syncScene();
        render();
        break;
      case 'actors':
        if (msg.key === S.sceneKey) updateActors(msg.actors);
        break;
      case 'pos_fix':
        if (S.me && msg.seq === S.posSeq) {
          S.me.x = msg.x;
          S.me.y = msg.y;
          S.path = null;
          S.lastSent = { x: msg.x, y: msg.y, d: S.me.d, t: performance.now() };
        }
        break;
      case 'chat_history':
        S.chat.global = msg.global || [];
        S.chat.local = msg.local || [];
        renderChat();
        break;
      case 'chat':
        addChat(msg.msg);
        break;
      case 'sound':
        // «звук в доме» от ЖЭК
        ambient.play(msg.kind);
        toast({ text: msg.text, style: 'whisper' });
        break;
      case 'object_say':
        // одержимая вещь (мусоропровод) говорит голосом ЖЭК
        S.objectBubbles = { ...(S.objectBubbles || {}), [msg.object]: { text: msg.text, until: Date.now() + 8000, ghost: true } };
        addChat({ id: `obj${Date.now()}`, channel: 'local', radio: true, garbled: true, from: { system: true, name: msg.object === 'chute' ? 'Мусоропровод' : 'Голос' }, text: msg.text });
        playDrone();
        break;
      case 'radio':
        // передача радиоточки: облачко над ней и строка в «Здесь»
        S.radioBubble = { text: msg.text, until: Date.now() + 8000, ghost: msg.garbled };
        addChat({ id: `radio${Date.now()}`, channel: 'local', radio: true, garbled: msg.garbled, from: { system: true, name: 'Радиоточка' }, text: msg.text });
        playTone(msg.garbled ? 180 : 660, 0.08, msg.garbled ? 'sawtooth' : 'square', 0.02);
        break;
      case 'notify':
        notify(msg);
        break;
      case 'res': {
        const resolve = S.pending.get(msg.id);
        S.pending.delete(msg.id);
        if (resolve) resolve(msg);
        break;
      }
      default:
    }
  }

  // ---------------------------------------------------------------------------
  // Сцена и соседи
  // ---------------------------------------------------------------------------
  function syncScene() {
    const v = S.view;
    if (!S.map || !v || !v.you.alive) return;
    const key = v.here.key;
    if (key !== S.sceneKey) {
      S.scene = S.map.scene(key);
      renderer.setScene(S.scene);
      S.actors.clear();
      S.hover = null;
      if (S.sheet && S.sheet.kind !== 'work') closeSheet();
    }
    if (key !== S.sceneKey || v.you.posSeq !== S.posSeq) {
      S.sceneKey = key;
      S.posSeq = v.you.posSeq;
      S.me = { x: v.you.pos.x, y: v.you.pos.y, d: v.you.pos.d || 'down', m: false };
      S.lastSent = { x: S.me.x, y: S.me.y, d: S.me.d, t: performance.now() };
      S.path = null;
      S.pathEnd = null;
      S.onArrive = null;
    }
  }

  function updateActors(list) {
    const myId = S.view && S.view.you.id;
    const seen = new Set();
    for (const a of list) {
      if (a.id === myId) continue;
      seen.add(a.id);
      const cur = S.actors.get(a.id);
      if (cur) Object.assign(cur, { tx: a.x, ty: a.y, d: a.d, m: a.m, sick: a.sick, hurt: a.hurt, sleep: a.sleep, down: a.down, mask: a.mask, away: a.away, newbie: a.newbie, name: a.name, apt: a.apt });
      else S.actors.set(a.id, { ...a, tx: a.x, ty: a.y, look: lookForActor(a), phase: Math.random() * 6 });
    }
    for (const id of [...S.actors.keys()]) if (!seen.has(id)) S.actors.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Движение
  // ---------------------------------------------------------------------------
  const MOVE_KEYS = {
    KeyW: [0, -1], ArrowUp: [0, -1],
    KeyS: [0, 1], ArrowDown: [0, 1],
    KeyA: [-1, 0], ArrowLeft: [-1, 0],
    KeyD: [1, 0], ArrowRight: [1, 0],
  };

  function canControl() {
    return S.view && S.view.you.alive && !S.view.you.down && !isTyping() && $('#modal').hidden && !(S.job && S.job.state === 'playing');
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && S.sheet && S.sheet.kind !== 'work') {
      closeSheet();
      return;
    }
    if (!canControl()) return;
    if (MOVE_KEYS[e.code]) {
      S.keys.add(e.code);
      e.preventDefault();
    } else if (e.code === 'KeyE') {
      e.preventDefault();
      if (S.npcNear) {
        openBaryga();
        return;
      }
      if (S.hazardNear) {
        fenceNear();
        return;
      }
      if (S.lastWordNear) {
        readLastWord(S.lastWordNear);
        return;
      }
      if (S.lampNear != null) {
        act('fix_lamp', { index: S.lampNear }).then((r) => r.ok && say(r.message));
        return;
      }
      const info = S.near && objectInfo(S.near);
      if (info && info.actions[0]) info.actions[0].run();
    } else if (e.code === 'Enter') {
      e.preventDefault();
      $('#chat-input').focus();
    }
  });
  document.addEventListener('keyup', (e) => S.keys.delete(e.code));
  window.addEventListener('blur', () => S.keys.clear());

  function walkTo(dest, onArrive) {
    if (!S.scene || !S.me) return false;
    const hz = ((S.view && S.view.here.hazards) || []).filter((z) => !z.fenced);
    const avoid = hz.length ? (x, y) => (hz.some((z) => Math.floor(z.x) === x && Math.floor(z.y) === y) ? 30 : 0) : null;
    const path = World.findPath(S.scene, S.me, dest, { avoid });
    if (!path) return false;
    if (!path.length) {
      // уже стоим на месте
      S.path = null;
      S.pathEnd = null;
      S.onArrive = null;
      if (onArrive) onArrive();
      return true;
    }
    S.path = path;
    S.pathEnd = { x: dest.x, y: dest.y };
    S.onArrive = onArrive || null;
    S.stuckFor = 0;
    return true;
  }

  function stepMovement(dt) {
    const me = S.me;
    let vx = 0, vy = 0;
    if (canControl()) for (const code of S.keys) {
      vx += MOVE_KEYS[code][0];
      vy += MOVE_KEYS[code][1];
    }
    if (vx || vy) {
      S.path = null;
      S.pathEnd = null;
      S.onArrive = null;
    } else if (S.path && S.path.length) {
      const p0 = S.path[0];
      const dx = p0.x - me.x, dy = p0.y - me.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.08) {
        S.path.shift();
        if (!S.path.length) {
          S.path = null;
          S.pathEnd = null;
          const cb = S.onArrive;
          S.onArrive = null;
          if (cb) cb();
        }
      } else {
        vx = dx / dist;
        vy = dy / dist;
      }
    }
    if (vx || vy) {
      const len = Math.hypot(vx, vy);
      vx /= len;
      vy /= len;
      const step = World.SPEED * dt;
      const ox = me.x, oy = me.y;
      const nx = me.x + vx * step;
      if (World.canStand(S.scene, nx, me.y)) me.x = nx;
      const ny = me.y + vy * step;
      if (World.canStand(S.scene, me.x, ny)) me.y = ny;
      me.d = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
      me.m = Math.hypot(me.x - ox, me.y - oy) > 0.001;
      if (S.path && !me.m && (S.stuckFor += dt) > 0.6) {
        S.path = null;
        S.pathEnd = null;
        S.onArrive = null;
      }
    } else {
      me.m = false;
    }
    // отправляем позицию не чаще ~11 раз в секунду
    const now = performance.now();
    const moved = Math.hypot(me.x - S.lastSent.x, me.y - S.lastSent.y) > 0.02 || me.d !== S.lastSent.d;
    if (moved && now - S.lastSent.t >= 90) {
      send({ t: 'pos', x: Math.round(me.x * 100) / 100, y: Math.round(me.y * 100) / 100, d: me.d });
      S.lastSent = { x: me.x, y: me.y, d: me.d, t: now };
    }
    // закрываем панель, если отошли от предмета
    if (S.sheet && S.sheet.obj && S.sheet.kind !== 'work' && World.distToObject(S.sheet.obj, me.x, me.y) > World.REACH + 1.2) closeSheet();
  }

  function stepActors(dt) {
    const k = Math.min(1, dt * 12);
    for (const a of S.actors.values()) {
      const dist = Math.hypot(a.tx - a.x, a.ty - a.y);
      if (dist > 3) {
        a.x = a.tx;
        a.y = a.ty;
      } else {
        a.x += (a.tx - a.x) * k;
        a.y += (a.ty - a.y) * k;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Предметы и двери: что с ними можно сделать
  // ---------------------------------------------------------------------------
  const FLAVOR = {
    window: () => (fogHere() ? 'За стеклом — сплошная белая муть. Она шевелится.' : 'За окном — стена соседнего корпуса. В окнах напротив кто-то тоже смотрит в окно.'),
    poster: 'Плакат выцвел, но буквы ещё видно. Кто-то пририсовал усы.',
    menu: 'Меню: суп дня, чай, хлеб, кисель, сухари, тушёнка. Мелом приписано: «Ложки — свои!»',
    jobboard: 'Наряды на смену. Вашей фамилии нет — значит, берите любой.',
    clock: 'Часы идут. Иногда — назад.',
    machine: 'Станок горячий. Лучше не трогать.',
    conveyor: 'Конвейер уходит в стену и выходит из противоположной. Что он везёт — непонятно.',
    cabinet: 'Шкаф с лекарствами. На замке.',
    couch: 'Холодная клеёнчатая кушетка.',
    wardrobe: 'В шкафу пусто. Пахнет нафталином.',
    stove: 'Плитка на две конфорки. Одна не работает.',
    sink: 'Из крана капает ржавая вода.',
    table: 'На столе — кружка и крошки.',
    dtable: 'Клеёнка липкая.',
    hose: 'Пожарный кран. Рукава нет.',
    radiator: 'Батарея чуть тёплая.',
    liftpanel: 'Кнопки затёрты до блеска.',
  };

  function residents() {
    const map = {};
    for (const r of S.view?.here?.residents || []) map[r.number] = r;
    return map;
  }

  function fogHere() {
    const f = S.view?.world.fog;
    return !!(f && f.phase === 'active' && f.affectsYou);
  }

  function say(text) {
    toast({ text, style: 'info' });
  }

  /** Подпись и действия для предмета. null — с предметом ничего не сделать. */
  function objectInfo(o) {
    const v = S.view;
    if (!v) return null;
    const you = v.you;
    switch (o.type) {
      case 'apt': {
        if (o.number === you.apartment.number) return { label: `Кв. ${o.number}`, sub: 'ваша квартира', actions: [{ label: 'Войти домой', run: () => act('move', { place: 'home' }) }] };
        const r = residents()[o.number];
        const knock = { label: 'Постучать', run: async () => { const res = await act('knock', { apt: o.number }); if (res.ok) say(res.message); } };
        if (!r || !r.name) return { label: `Кв. ${o.number}`, sub: 'пустует', actions: [knock] };
        return {
          label: `Кв. ${o.number}`,
          sub: `${r.name}${r.rumor && r.rumor.length ? ` · говорят: ${r.rumor.join(', ')}` : ''}`,
          actions: [
            knock,
            { label: 'Подсунуть записку', run: () => openNote(o.number, r.name) },
            { label: 'Оставить передачку', run: () => openParcel(o.number, r.name) },
          ],
        };
      }
      case 'locked':
        if (v.here.floorKind === 'technical') {
          const crowbar = you.inventory.some((i) => i.id === 'crowbar');
          return { label: 'Служебная дверь', sub: crowbar ? 'за ней подсобка' : 'заперто · нужна монтировка (если не вскрыта)', actions: [{ label: 'Вскрыть и обшарить подсобку', run: async () => { const r = await act('stash'); if (r.ok) say(r.message); } }] };
        }
        return { label: 'Служебная дверь', actions: [{ label: 'Подёргать ручку', run: () => say('Заперто. За дверью что-то ровно гудит.') }] };
      case 'lift':
        return { label: 'Лифт', sub: v.world.lift.broken ? `не работает${repairSub(v, 'lift')}` : `${v.here.floor} этаж`, actions: [{ label: 'Вызвать лифт', run: () => openTravel('lift', o) }, ...repairAction(v, 'lift', o)] };
      case 'stairs':
        return { label: 'Лестница', actions: [{ label: 'Пойти по лестнице', run: () => openTravel('stairs', o) }] };
      case 'facility': {
        const f = v.facilities[o.facility];
        return { label: f.name, sub: f.open ? 'открыто' : 'закрыто', actions: [{ label: 'Войти', run: () => act('move', { place: o.facility }) }] };
      }
      case 'board':
        return { label: 'Доска объявлений', actions: [{ label: 'Читать', run: () => openBoard(o) }] };
      case 'window':
        if (!v.here.ownHome) return { label: 'Окно', actions: [{ label: 'Посмотреть в окно', run: () => say(v.world.fog && v.world.fog.affectsYou ? 'За окном — серая муть.' : 'Окна дома напротив. Где-то горит свет.') }] };
        return { label: 'Окно', sub: (you.window || []).length ? `в авоське: ${you.window.map((x) => `${x.name} ×${x.count}`).join(', ')}` : 'авоська пуста', actions: [{ label: 'Авоська за окном', run: () => openWindowStash() }] };
      case 'memorial':
        return { label: 'Стена памяти', sub: 'имена выбывших жильцов', actions: [{ label: 'Прочитать имена', run: () => openMemorial() }] };
      case 'chute':
        return {
          label: 'Мусоропровод',
          sub: you.searchInSec ? `рылись недавно · ${fmtSec(you.searchInSec)}` : null,
          actions: [{ label: 'Порыться', run: async () => { const res = await act('search'); if (res.ok) say(res.message); } }],
        };
      case 'exit':
        return { label: 'Выход', actions: [{ label: 'Выйти в коридор', run: () => act('move', { place: 'corridor' }) }] };
      case 'hermodoor': {
        // постучали — хозяин может впустить
        const letIn = v.here.ownHome && you.knocker ? [{ label: `Впустить: ${you.knocker.name}`, run: () => act('open_door', { guest: you.knocker.id }) }] : [];
        if (you.sealed) return { label: 'Гермодверь', sub: 'задраена', actions: [...letIn, { label: 'Открыть гермодверь', run: () => act('seal', { on: false }) }] };
        const out = { label: 'Выйти в коридор', run: () => act('move', { place: 'corridor' }) };
        const seal = { label: 'Задраить гермодверь', run: () => act('seal', { on: true }) };
        const danger = v.world.fog && v.world.fog.affectsYou;
        return { label: 'Гермодверь', sub: you.knocker && v.here.ownHome ? `стучит ${you.knocker.name}${you.knocker.rumor && you.knocker.rumor.length ? ` (говорят: ${you.knocker.rumor.join(', ')})` : ''}` : 'открыта', actions: [...letIn, ...(danger ? [seal, out] : [out, seal])] };
      }
      case 'bed':
        return you.sleeping
          ? { label: 'Кровать', actions: [{ label: 'Встать', run: () => act('sleep', { on: false }) }] }
          : { label: 'Кровать', actions: [{ label: 'Лечь спать', run: () => act('sleep', { on: true }) }] };
      case 'radio':
        return {
          label: 'Радиоточка',
          actions: [{ label: 'Слушать', run: () => listenRadio() }],
        };
      case 'counter':
        return { label: 'Раздача', sub: v.facilities.canteen.open ? sideSub(v) : `закрыто${repairSub(v, 'canteen')}`, actions: [{ label: 'Подойти к раздаче', run: () => openShop('canteen', o) }, ...sideAction(v, o), ...repairAction(v, 'canteen', o)] };
      case 'window_med':
        return { label: 'Окошко фельдшера', sub: v.facilities.medpost.open ? sideSub(v) : `закрыто${repairSub(v, 'medpost')}`, actions: [{ label: 'Постучать в окошко', run: () => openShop('medpost', o) }, ...sideAction(v, o), ...repairAction(v, 'medpost', o)] };
      case 'jobboard':
        return { label: 'Доска нарядов', sub: 'план дома и доска почёта', actions: [{ label: 'Читать', run: () => openPlan(o) }] };
      case 'station': {
        const job = (v.here.jobs || []).find((j) => j.id === o.game);
        const sub = !v.facilities.factory.open ? 'цех стоит' : `${job ? job.rank : 1} разряд · смен в этот час: ${v.here.shiftsLeft ?? '—'}`;
        return { label: o.label, sub: `${sub}${repairSub(v, 'factory')}`, actions: [...repairAction(v, 'factory', o), { label: `Взять наряд: ${job ? job.name : o.game}`, run: () => startWork(o.game) }] };
      }
      default: {
        const f = FLAVOR[o.type];
        if (!f) return null;
        return { label: o.label || 'Предмет', actions: [{ label: 'Осмотреть', run: () => say(typeof f === 'function' ? f() : f) }] };
      }
    }
  }

  /** Ближайший предмет, с которым можно что-то сделать (без декора). */
  function nearestObject() {
    if (!S.scene || !S.me) return null;
    let best = null, bestD = Infinity;
    for (const o of S.scene.objects) {
      if (o.decor || !o.spot) continue;
      const d = World.distToObject(o, S.me.x, S.me.y);
      if (d <= World.REACH && d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  /** Погасший плафон рядом (в коридоре) — номер лампы или null. */
  function nearestDeadLamp() {
    const v = S.view;
    if (!v || !S.scene || v.here.place !== 'corridor' || !(v.here.lampsOut || []).length) return null;
    for (const i of v.here.lampsOut) {
      const l = S.scene.lamps[i];
      if (l && Math.hypot(S.me.x - l[0], S.me.y - l[1]) <= 1.6) return i;
    }
    return null;
  }

  /** Бумага, записка, листок: текст в окне. */
  function showPaper(title, text) {
    openModal({ title, style: 'paper', body: h('div', { class: 'paper-text' }, String(text).split('\n').map((l) => h('p', { text: l }))), actions: [{ label: 'Отложить', primary: true }] });
  }

  /** Авоська за окном: еда там портится медленнее (но туман до неё добирается). */
  function openWindowStash() {
    openSheet('window', 'Авоська за окном');
    S.memo.sheet = null;
    renderWindowStash();
  }

  function renderWindowStash() {
    const you = S.view.you;
    memo('sheet', [you.window, you.inventory], () => {
      const food = you.inventory.filter((it) => it.usable || it.id === 'bread');
      $('#sheet-body').replaceChildren(
        h('p', { class: 'hint', text: 'Холодно за окном — хлеб черствеет медленнее. Но если на этаж придёт туман, всё в авоське покроется налётом.' }),
        h('h4', { class: 'board-h', text: 'В авоське' }),
        (you.window || []).length
          ? h('ul', { class: 'inventory' }, you.window.map((x) => h('li', null, h('span', { class: 'name', text: `${x.name} ×${x.count}` }), h('button', { class: 'btn small', text: 'Взять', onclick: () => act('window_take', { item: x.id, count: 1 }) }))))
          : h('p', { class: 'note', text: 'Пусто.' }),
        h('h4', { class: 'board-h', text: 'В карманах' }),
        food.length
          ? h('ul', { class: 'inventory' }, food.map((x) => h('li', null, h('span', { class: 'name', text: `${x.name} ×${x.count}` }), h('button', { class: 'btn small', text: 'Положить', onclick: () => act('window_put', { item: x.id, count: 1 }) }))))
          : h('p', { class: 'note', text: 'Нечего класть.' }),
      );
    });
  }

  async function listenRadio() {
    const r = await act('radio_listen');
    if (!r.ok) return;
    const body = openSheet('radio', 'Радиоточка');
    body.replaceChildren(
      h('p', { class: 'hint', text: 'Передачи слышно, пока вы рядом с радиоточкой — дома или в столовой.' }),
      r.radio && r.radio.length
        ? h('ul', { class: 'radio-log' }, r.radio.map((l) => h('li', { class: l.garbled ? 'garbled' : '' }, h('span', { class: 'clock-s', text: l.clock }), l.text)))
        : h('p', { class: 'note', text: r.silence }),
    );
  }

  async function openMemorial() {
    const r = await act('memorial');
    if (!r.ok) return;
    const body = openSheet('memorial', 'Стена памяти');
    body.replaceChildren(
      h('p', { class: 'hint', text: r.total ? `Выбыло жильцов: ${r.total}. Здесь — последние.` : 'Пока ни одного имени. Пусть так и будет.' }),
      h(
        'ul',
        { class: 'memorial' },
        r.memorial.map((m) =>
          h('li', null, h('b', { text: m.name }), h('span', { text: ` · кв. ${m.apt}` }), h('small', { text: ` · прожито ${m.lived}, смен ${m.shifts}${m.helped ? `, помощь соседям: ${m.helped}` : ''} · ${m.ago} назад` })),
        ),
      ),
    );
  }

  function fenceNear() {
    if (!S.hazardNear) return;
    act('fence', { id: S.hazardNear }).then((r) => r.ok && say(r.message));
  }

  /** Неогороженная опасность рядом. */
  function nearestHazard() {
    const v = S.view;
    if (!v || !S.me) return null;
    let best = null, bd = 1.6;
    for (const z of v.here.hazards || []) {
      if (z.fenced) continue;
      const d = Math.hypot(S.me.x - z.x, S.me.y - z.y);
      if (d <= bd) {
        bd = d;
        best = z;
      }
    }
    return best;
  }

  /** Листок с последней записью погибшего рядом. */
  function nearestLastWord() {
    const v = S.view;
    if (!v || !S.me) return null;
    return (v.here.scars || []).find((sc) => sc.kind === 'lastword' && Math.hypot(S.me.x - sc.x, S.me.y - sc.y) <= 1.2) || null;
  }

  function readLastWord(sc) {
    showPaper('Листок на полу', `Почерк: ${sc.by || 'соседа'}. Последние слова:\n\n«${sc.text}»`);
  }

  function renderPrompt() {
    const busy = !S.view || S.view.you.travel || S.view.you.down;
    const npc = busy || !S.me ? null : [...S.actors.values()].find((a) => a.npc === 'baryga' && Math.hypot(a.x - S.me.x, a.y - S.me.y) <= 1.8);
    S.npcNear = npc || null;
    if (npc) {
      S.near = null;
      S.lampNear = null;
      S.hazardNear = null;
      S.lastWordNear = null;
      const sig = `npc${npc.id}`;
      if (S.memo.prompt === sig) return;
      S.memo.prompt = sig;
      $('#prompt').replaceChildren(
        h('span', { class: 'label' }, npc.name, h('small', { text: ' · скупает лампочки, вилки, ложки и бумаги' })),
        h('button', { class: 'btn small primary', onclick: () => openBaryga() }, h('kbd', { text: 'E' }), 'Поговорить'),
      );
      return;
    }
    const lw = busy ? null : nearestLastWord();
    S.lastWordNear = lw;
    if (lw && !nearestHazard()) {
      S.near = null;
      S.lampNear = null;
      S.hazardNear = null;
      const sig = `lw${lw.id}`;
      if (S.memo.prompt === sig) return;
      S.memo.prompt = sig;
      $('#prompt').replaceChildren(
        h('span', { class: 'label' }, 'Листок на полу', h('small', { text: ` · последние слова: ${lw.by}` })),
        h('button', { class: 'btn small primary', onclick: () => readLastWord(lw) }, h('kbd', { text: 'E' }), 'Прочитать'),
      );
      return;
    }
    const hz = busy ? null : nearestHazard();
    if (hz) {
      S.near = null;
      S.lampNear = null;
      S.hazardNear = hz.id;
      const sig = `hz${hz.id}`;
      if (S.memo.prompt === sig) return;
      S.memo.prompt = sig;
      $('#prompt').replaceChildren(
        h('span', { class: 'label danger' }, hz.name, h('small', { text: ' · не наступайте! Можно огородить, чтобы уберечь соседей' })),
        h('button', { class: 'btn small primary', onclick: () => fenceNear() }, h('kbd', { text: 'E' }), 'Огородить'),
      );
      return;
    }
    S.hazardNear = null;
    const lamp = S.view && !S.view.you.travel && !S.view.you.down ? nearestDeadLamp() : null;
    if (lamp != null) {
      S.near = null;
      const hasBulb = S.view.you.inventory.some((i) => i.id === 'bulb');
      const sig = `lamp${lamp}${hasBulb}`;
      if (S.memo.prompt === sig) return;
      S.memo.prompt = sig;
      $('#prompt').replaceChildren(
        h('span', { class: 'label' }, 'Погасший плафон', h('small', { text: hasBulb ? ' · у вас есть лампочка' : ' · нужна лампочка (бывает в мусоропроводе)' })),
        hasBulb ? h('button', { class: 'btn small primary', onclick: () => act('fix_lamp', { index: lamp }).then((r) => r.ok && say(r.message)) }, h('kbd', { text: 'E' }), 'Вкрутить лампочку') : null,
      );
      S.lampNear = hasBulb ? lamp : null;
      return;
    }
    S.lampNear = null;
    const o = S.view && (S.view.you.travel || S.view.you.down) ? null : nearestObject();
    S.near = o;
    const info = o && objectInfo(o);
    const sig = info ? `${o.id}|${info.label}|${info.sub}|${info.actions.map((a) => a.label).join('/')}` : 'none';
    if (S.memo.prompt === sig) return;
    S.memo.prompt = sig;
    const box = $('#prompt');
    if (!info) {
      box.replaceChildren(h('span', { class: 'idle', text: S.view?.you.travel ? '' : 'Подойдите к двери или предмету.' }));
      return;
    }
    box.replaceChildren(
      h('span', { class: 'label' }, info.label, info.sub ? h('small', { text: ` · ${info.sub}` }) : null),
      ...info.actions.map((a, i) =>
        h('button', { class: `btn small ${i === 0 ? 'primary' : ''}`, onclick: () => a.run() }, i === 0 ? h('kbd', { text: 'E' }) : null, a.label),
      ),
    );
  }

  // клики по сцене
  const canvas = $('#view');
  function worldPoint(e) {
    const r = canvas.getBoundingClientRect();
    return renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
  }

  function actorAt(pt) {
    for (const a of S.actors.values()) {
      if (a.away && !a.down) continue; // тело ушедшего не перехватывает клики (дверь под ним должна нажиматься)
      if (a.down && Math.abs(a.x - pt.x) < 0.55 && Math.abs(a.y - 0.2 - pt.y) < 0.4) return a;
      if (Math.abs(a.x - pt.x) < 0.35 && pt.y < a.y + 0.15 && pt.y > a.y - 1.25) return a;
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!S.view || !S.view.you.alive || !S.scene || !S.me) return;
    unlockAudio();
    const pt = worldPoint(e);
    const a = actorAt(pt);
    if (a && a.npc === 'puppet') {
      say(`${a.name} смотрит сквозь вас и молчит.`);
      return;
    }
    if (a && a.npc === 'baryga') {
      if (Math.hypot(a.x - S.me.x, a.y - S.me.y) <= 2) openBaryga();
      else approach(a.id, openBaryga);
      return;
    }
    if (a) {
      const person = { id: a.id, name: a.name, apt: a.apt };
      const open = () => (a.down ? openAid(person, true) : openTrade(person));
      if (Math.hypot(a.x - S.me.x, a.y - S.me.y) <= (a.down ? 1.6 : 2.5)) open();
      else approach(a.id, open);
      return;
    }
    const o = renderer.objectAt(pt);
    const info = o && objectInfo(o);
    if (o && info && info.actions[0]) {
      if (o.spot && World.distToObject(o, S.me.x, S.me.y) > World.REACH) {
        walkTo(o.spot, () => info.actions[0] && objectInfo(o).actions[0].run());
      } else {
        info.actions[0].run();
      }
      return;
    }
    if (!walkTo(pt) && o && o.spot) walkTo(o.spot);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!S.scene) return;
    const pt = worldPoint(e);
    const o = renderer.objectAt(pt);
    S.hover = o && objectInfo(o) ? o : null;
    canvas.classList.toggle('pointer', !!(S.hover || actorAt(pt)));
  });
  canvas.addEventListener('pointerleave', () => (S.hover = null));

  // ---------------------------------------------------------------------------
  // Панели поверх сцены
  // ---------------------------------------------------------------------------
  function openSheet(kind, title, obj) {
    S.sheet = { kind, obj: obj || null };
    S.memo.sheet = null;
    const sheet = $('#sheet');
    sheet.className = `sheet ${kind}`;
    sheet.hidden = false;
    $('#sheet-title').textContent = title;
    $('#sheet-close').hidden = kind === 'work';
    return $('#sheet-body');
  }

  function closeSheet() {
    if (S.sheet && S.sheet.kind === 'work' && S.job) S.job.timers.forEach((f) => f());
    S.sheet = null;
    S.job = null;
    $('#sheet').hidden = true;
    $('#sheet-body').replaceChildren();
  }
  $('#sheet-close').addEventListener('click', closeSheet);

  /** Перерисовать содержимое открытой панели, если её данные поменялись. */
  function renderSheet() {
    if (!S.sheet || !S.view) return;
    if (S.sheet.kind === 'shop') renderShop();
    else if (S.sheet.kind === 'travel') renderTravel();
    else if (S.sheet.kind === 'window') renderWindowStash();
  }

  // ---- раздача и окошко фельдшера ----
  function openShop(shop, obj) {
    openSheet('shop', shop === 'canteen' ? 'Раздача · Столовая №3' : 'Окошко фельдшера', obj);
    S.sheet.shop = shop;
    renderShop();
  }

  function renderShop() {
    const v = S.view;
    const here = v.here;
    const you = v.you;
    memo('sheet', [here.shop, here.closed, you.money], () => {
      const body = $('#sheet-body');
      const kids = [];
      if (here.closed) kids.push(h('p', { class: 'note bad', text: here.closed }));
      kids.push(
        h(
          'div',
          { class: 'shop' },
          (here.shop || []).map((e) =>
            h(
              'div',
              { class: 'shop-row' },
              h('div', null, e.name, e.desc ? h('span', { class: 'desc', text: e.desc }) : null, e.note ? h('span', { class: 'note', text: e.note }) : null),
              h('span', { class: `price${e.left === 0 ? ' out' : ''}`, text: e.left === 0 ? 'нет' : `${e.price} ₸${e.left != null ? ` · ${e.left} шт.` : ''}` }),
              h('button', {
                class: 'btn small',
                text: e.eat ? 'Взять' : 'Купить',
                disabled: !!here.closed || you.money < e.price || e.left === 0,
                onclick: () => act('buy', { shop: here.place, key: e.key }),
              }),
            ),
          ),
        ),
      );
      kids.push(h('p', { class: 'note', text: `У вас ${you.money} ₸. Завоз — в ${here.supplyAt || '08:00'}: чем больше смен закроют в цеху, тем больше привезут.` }));
      body.replaceChildren(...kids);
    });
  }

  // ---- лифт и лестница ----
  function openTravel(via, obj) {
    openSheet('travel', via === 'lift' ? 'Лифт' : 'Лестница', obj);
    S.sheet.via = via;
    renderTravel();
  }

  function renderTravel() {
    const v = S.view;
    const via = S.sheet.via;
    const here = v.here.floor;
    const you = v.you;
    const broken = via === 'lift' && v.world.lift.broken;
    const legBroken = you.conditions.some((c) => c.id === 'leg');
    memo('sheet', [via, here, broken, Math.floor(you.stats.energy), legBroken], () => {
      const body = $('#sheet-body');
      if (broken) {
        body.replaceChildren(
          h('p', { class: 'note bad', text: `Лифт не работает. ${v.world.lift.reason || ''}` }),
          h('button', {
            class: 'btn primary',
            text: 'Идти к лестнице',
            onclick: () => {
              const st = S.scene.objects.find((o) => o.type === 'stairs');
              closeSheet();
              if (st) walkTo(st.spot, () => openTravel('stairs', st));
            },
          }),
        );
        return;
      }
      const dests = [{ label: 'Домой', floor: you.apartment.floor }];
      for (const [key, f] of Object.entries(v.facilities)) dests.push({ label: f.name, floor: f.floor, key });
      const cost = (floor) => {
        const diff = Math.abs(floor - here);
        return via === 'lift' ? `~${Math.round(3 + diff * 0.08)} с` : `−${Math.ceil(diff * 0.4)} сил`;
      };
      const canGo = (floor) => floor !== here && (via === 'lift' || (!legBroken && you.stats.energy >= Math.abs(floor - here) * 0.4));
      const go = async (floor) => {
        const res = await act('move', { place: 'corridor', floor, via });
        if (res.ok) closeSheet();
      };
      const input = h('input', { type: 'number', min: '1', max: '999', inputmode: 'numeric', placeholder: String(here), 'aria-label': 'Этаж' });
      body.replaceChildren(
        h('p', { class: 'note', text: via === 'lift' ? `Вы на ${here} этаже. Куда едем?` : `Вы на ${here} этаже. Лестница бесплатная, но отнимает силы.` }),
        ...(legBroken && via === 'stairs' ? [h('p', { class: 'note bad', text: 'С переломом ноги по лестнице не пройти.' })] : []),
        h(
          'div',
          { class: 'dest-grid' },
          dests.map((d) =>
            h(
              'button',
              { class: 'btn', disabled: !canGo(d.floor), onclick: () => go(d.floor) },
              h('span', { text: d.label }),
              h('small', { text: d.floor === here ? `${d.floor} эт. · вы здесь` : `${d.floor} эт. · ${cost(d.floor)}` }),
            ),
          ),
        ),
        h(
          'form',
          {
            class: 'travel-form',
            onsubmit: (e) => {
              e.preventDefault();
              const floor = parseInt(input.value, 10);
              if (Number.isFinite(floor)) go(floor);
            },
          },
          h('label', { text: 'Другой этаж:' }),
          input,
          h('button', { class: 'btn', type: 'submit', text: via === 'lift' ? 'Поехать' : 'Пойти' }),
        ),
      );
    });
  }

  // ---- доска объявлений ----
  async function openBoard(obj) {
    const res = await act('board');
    if (!res.ok) return;
    const body = openSheet('board', 'Доска объявлений', obj);
    const input = h('textarea', { maxlength: '200', rows: '2', placeholder: 'Меняю лампочку на сухари. Кв. …', 'aria-label': 'Текст листка' });
    const mine = res.pinned.find((n) => n.mine);
    const assignments = (res.assignments || []).map((a) =>
      h(
        'li',
        { class: `assignment${a.closed ? ' closed' : ''}${a.mine ? ' done' : ''}` },
        h('b', { text: `Разнарядка ЖЭК · этажи ${a.floors}` }),
        h('p', { text: `«${a.text}». С каждой квартиры: ${a.what}.` }),
        h('small', {
          text: a.closed
            ? `Срок вышел. Сдали ${a.done.length} из ${a.total}.`
            : `Осталось ${a.leftMin} мин. Сдали ${a.done.length} из ${a.total}${a.done.length ? `: ${a.done.join(', ')}` : ''}.`,
        }),
        !a.closed && a.mineApplies
          ? a.mine
            ? h('span', { class: 'tag-ok', text: '✔ ваша квартира сдала' })
            : a.kind === 'shifts'
              ? h('span', { class: 'note', text: `Ваши смены: ${a.progress || 0} — засчитываются сами, когда закрываете наряд в цеху.` })
              : h('button', { class: 'btn small primary', type: 'button', text: 'Сдать за свою квартиру', onclick: async () => { const r = await act('assignment_submit', { id: a.id }); if (r.ok) { say(r.message); openBoard(obj); } } })
          : null,
      ),
    );
    // коллективные заявления
    const petText = h('textarea', { maxlength: '300', rows: '2', placeholder: 'Требуем починить лифт: третий день стоит…', 'aria-label': 'Текст заявления' });
    const statusText = { open: 'собирает подписи', sent: 'ушло в ЖЭК, ждём ответа', done: 'ЖЭК: меры приняты', ignored: 'ЖЭК не ответил', punished: 'ЖЭК наказал подписавших', expired: 'не набрало подписей' };
    const petitions = h(
      'div',
      { class: 'petitions' },
      h('h4', { class: 'board-h', text: 'Коллективные заявления в ЖЭК' }),
      (res.petitions || []).length
        ? h(
            'ul',
            { class: 'board-notes' },
            res.petitions.map((x) =>
              h(
                'li',
                { class: `petition ${x.status}` },
                h('p', { text: `«${x.text}»` }),
                h('small', { text: `${statusText[x.status] || x.status} · подписи ${x.count}/${x.needed}: ${x.signers.join(', ')}${x.reply ? ` · ответ: ${x.reply}` : ''}` }),
                x.status === 'open' && !x.signed ? h('button', { class: 'btn small', type: 'button', text: 'Подписать', onclick: async () => { const r = await act('petition_sign', { id: x.id }); if (r.ok) { say(r.message); openBoard(obj); } } }) : null,
              ),
            ),
          )
        : h('p', { class: 'note', text: 'Заявлений нет.' }),
      h(
        'form',
        { class: 'pin-form', onsubmit: async (e) => { e.preventDefault(); const r = await act('petition_create', { text: petText.value }); if (r.ok) { say(r.message); openBoard(obj); } } },
        petText,
        h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'submit', text: 'Вывесить заявление' })),
      ),
    );
    // старший по этажу
    const el = res.elder || {};
    const elder = h(
      'div',
      { class: 'elder' },
      h('h4', { class: 'board-h', text: 'Старший по этажу' }),
      h('p', { class: 'note', text: el.name ? `Старший: ${el.name}. Старшему первым звонят из ЖЭК.` : `Старшего нет. Нужно голосов: ${el.need || 1}.` }),
      el.canVote && (el.candidates || []).length
        ? h(
            'div',
            { class: 'actions' },
            el.candidates.map((c) => h('button', { class: `btn small${el.myVote === c.id ? ' primary' : ''}`, type: 'button', text: `${c.name} (${c.apt})${c.votes ? ` · ${c.votes}` : ''}`, onclick: async () => { const r = await act('vote_elder', { candidate: c.id }); if (r.ok) { say(r.message); openBoard(obj); } } })),
          )
        : el.canVote
          ? null
          : h('p', { class: 'note', text: 'Голосовать можно у доски своего этажа.' }),
    );
    const rentBox = res.rent || res.myRentDebt || (res.rentDebtors || []).length
      ? h(
          'div',
          { class: 'rent' },
          h('h4', { class: 'board-h', text: 'Квартплата' }),
          h('p', { class: 'note', text: res.rent ? `${res.rent} ₸ в сутки, списывается в полночь.` : 'Квартплаты сейчас нет.' }),
          res.myRentDebt ? h('div', { class: 'actions' }, h('span', { class: 'bad', text: `Ваш долг: ${res.myRentDebt} ₸` }), h('button', { class: 'btn small primary', type: 'button', text: 'Погасить', onclick: async () => { const r = await act('pay_rent'); if (r.ok) { say(r.message); openBoard(obj); } } })) : null,
          (res.rentDebtors || []).length ? h('ul', { class: 'board-notes' }, res.rentDebtors.map((d) => h('li', null, `Долг за квартиру: ${d.name} (кв. ${d.apt}) — ${d.debt} ₸`))) : null,
        )
      : null;
    const debtors = (res.debtors || []).length
      ? h('div', { class: 'debtors' }, h('h4', { class: 'board-h', text: 'Книга должников этажа' }), h('ul', { class: 'board-notes' }, res.debtors.map((d) => h('li', null, `Должник: ${d.debtor}. Кому: ${d.holder}. Долг: ${d.what} — срок вышел (день ${d.dueDay})`))))
      : null;
    body.replaceChildren(
      ...(assignments.length ? [h('ul', { class: 'board-notes assignments' }, assignments)] : []),
      ...(debtors ? [debtors] : []),
      ...(rentBox ? [rentBox] : []),
      h('h4', { class: 'board-h', text: 'Листки жильцов' }),
      res.pinned.length
        ? h('ul', { class: 'board-notes pinned' }, res.pinned.map((n) => h('li', { class: n.mine ? 'mine' : '' }, h('small', { text: `${n.name}, кв. ${n.apt} · ${new Date(n.ts).toLocaleString('ru-RU')}` }), n.text)))
        : h('p', { class: 'note', text: 'Пока никто ничего не повесил.' }),
      h(
        'form',
        {
          class: 'pin-form',
          onsubmit: async (e) => {
            e.preventDefault();
            const r = await act('pin', { text: input.value });
            if (r.ok) {
              say(r.message);
              openBoard(obj);
            }
          },
        },
        input,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn small primary', type: 'submit', text: mine ? 'Заменить мой листок' : 'Повесить листок' }),
          ...(mine ? [h('button', { class: 'btn small', type: 'button', text: 'Снять мой', onclick: async () => { const r = await act('unpin'); if (r.ok) openBoard(obj); } })] : []),
        ),
        h('p', { class: 'note', text: 'У жильца один листок на весь дом. Через 12 часов его снимают.' }),
      ),
      petitions,
      elder,
      h('h4', { class: 'board-h', text: 'Объявления ЖЭК' }),
      res.notes.length
        ? h('ul', { class: 'board-notes' }, res.notes.map((n) => h('li', null, h('small', { text: `${n.from} · ${new Date(n.ts).toLocaleString('ru-RU')}` }), n.text)))
        : h('p', { class: 'note', text: 'Доска пуста. Только ржавые кнопки.' }),
    );
  }

  // ---- записки и передачки под чужую дверь ----
  function openNote(apt, owner) {
    const text = h('textarea', { maxlength: '300', rows: '4', placeholder: 'Что написать…', 'aria-label': 'Текст записки' });
    const anon = h('input', { type: 'checkbox' });
    openModal({
      title: `Записка для кв. ${apt}`,
      style: 'trade',
      keepFocus: true,
      body: h(
        'div',
        { class: 'note-form' },
        h('p', { text: `${owner} найдёт её у двери, когда будет дома — даже если сейчас его нет.` }),
        text,
        h('label', { class: 'check' }, anon, 'без подписи (ЖЭК всё равно знает, кто писал)'),
      ),
      actions: [
        { label: 'Отмена' },
        {
          label: 'Подсунуть',
          primary: true,
          onClick: async () => {
            const res = await act('note', { apt, text: text.value, anon: anon.checked });
            if (res.ok) say(res.message);
            return res.ok;
          },
        },
      ],
    });
    setTimeout(() => text.focus(), 30);
  }

  function openParcel(apt, owner) {
    const you = S.view.you;
    const num = (max) => h('input', { type: 'number', min: '0', max: String(max), value: '0', inputmode: 'numeric' });
    const money = num(you.money);
    const items = you.inventory.map((it) => [it.id, num(it.count), it]);
    const text = h('input', { maxlength: '300', placeholder: 'Приписка (необязательно)', 'aria-label': 'Приписка' });
    openModal({
      title: `Передачка для кв. ${apt}`,
      style: 'trade',
      keepFocus: true,
      body: h(
        'div',
        { class: 'trade-grid single' },
        h('p', { text: `Оставить свёрток у двери: ${owner} заберёт его, когда будет дома.` }),
        h('label', null, `Талоны (есть ${you.money})`, money),
        items.length ? items.map(([, input, it]) => h('label', null, `${it.name} (×${it.count})`, input)) : h('p', { class: 'empty', text: 'Карманы пусты' }),
        text,
      ),
      actions: [
        { label: 'Отмена' },
        {
          label: 'Оставить',
          primary: true,
          onClick: async () => {
            const give = {
              money: parseInt(money.value, 10) || 0,
              items: Object.fromEntries(items.map(([id, input]) => [id, parseInt(input.value, 10) || 0]).filter(([, n]) => n > 0)),
            };
            const res = await act('parcel', { apt, give, text: text.value });
            if (res.ok) say(res.message);
            return res.ok;
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Регистрация и смерть
  // ---------------------------------------------------------------------------
  function setRegMode(mode) {
    S.regMode = mode;
    $('#register-form').hidden = mode === 'login';
    $('#login-form').hidden = mode !== 'login';
    $('#passport-fields').hidden = mode === 'newlife';
    $('#register-submit').textContent = mode === 'newlife' ? 'Заселить нового жильца' : 'Получить ордер';
    $('#register-login').required = mode === 'new';
    $('#register-password').required = mode === 'new';
    $('.reg-tabs').hidden = mode === 'newlife';
    for (const t of document.querySelectorAll('.reg-tabs .tab')) t.classList.toggle('active', t.dataset.reg === mode);
  }
  for (const t of document.querySelectorAll('.reg-tabs .tab')) t.addEventListener('click', () => setRegMode(t.dataset.reg));

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    S.banned = false;
    unlockAudio();
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) connect();
    send({ t: 'login', login: $('#login-login').value, password: $('#login-password').value });
  });

  function showRegister(note = '', mode = null) {
    $('#app').hidden = true;
    $('#death').hidden = true;
    $('#register').hidden = false;
    $('#register-note').hidden = !note;
    $('#register-note').textContent = note;
    setRegMode(mode || (S.regMode === 'newlife' ? 'new' : S.regMode));
    setTimeout(() => $('#register-name').focus(), 50);
  }

  $('#register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    S.banned = false;
    $('#register-error').textContent = '';
    unlockAudio();
    const msg = { t: 'register', name: $('#register-name').value };
    if (S.regMode === 'new') {
      msg.login = $('#register-login').value;
      msg.password = $('#register-password').value;
    }
    send(msg);
  });

  $('#tutorial-hide').addEventListener('click', () => act('tutorial_hide'));

  /** Куда указывает стрелка памятки: объект текущей сцены для следующего шага. */
  function tutorialMarker(v) {
    const next = v.you.tutorial && v.you.tutorial.find((t) => !t.done);
    if (!next || !S.scene) return null;
    const here = v.here;
    const find = (test) => S.scene.objects.find(test);
    let o = null;
    if (next.id === 'corridor' && here.place === 'home') o = find((x) => x.type === 'hermodoor');
    if (next.id === 'factory') {
      if (here.place === 'home') o = find((x) => x.type === 'hermodoor');
      else if (here.place === 'corridor' && here.floor === v.facilities.factory.floor) o = find((x) => x.type === 'facility');
      else if (here.place === 'corridor') o = find((x) => x.type === 'lift');
      else o = find((x) => x.type === 'exit');
    }
    if (next.id === 'shift' && here.place === 'factory') o = find((x) => x.type === 'station');
    if (next.id === 'eat' && here.place === 'canteen') o = find((x) => x.type === 'counter');
    if (next.id === 'eat' && here.place === 'corridor' && here.floor === v.facilities.canteen.floor) o = find((x) => x.type === 'facility');
    if (next.id === 'eat' && here.place === 'factory') o = find((x) => x.type === 'exit');
    if (next.id === 'seal' && here.place === 'home') o = find((x) => x.type === 'hermodoor');
    if (next.id === 'seal' && here.place === 'corridor' && here.floor === v.you.apartment.floor) o = find((x) => x.type === 'apt' && x.number === v.you.apartment.number);
    if (!o) return null;
    const up = o.wall && !o.bottom ? 0.9 : 0;
    return { x: o.x + o.w / 2, y: o.y - up - 0.2 };
  }

  // старому жильцу без паспорта — выдать паспорт
  $('#claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await act('claim_account', { login: $('#claim-login').value, password: $('#claim-password').value });
    if (res.ok) {
      say(res.message);
      $('#claim-password').value = '';
    }
  });

  $('#death-login').addEventListener('click', () => showRegister('Войдите по паспорту: если по нему уже заселён новый жилец, вы окажетесь у него.', 'login'));

  $('#rebirth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    closeSheet();
    send({ t: 'register', name: $('#rebirth-name').value });
  });

  function showDeath(v) {
    $('#app').hidden = true;
    $('#death').hidden = false;
    $('#death-cause').textContent = `${v.you.name}, кв. ${v.you.apartment.number}. ${v.you.deathCause || ''}.`;
    const ob = v.you.obituary;
    if (ob) $('#obituary').textContent = `Прожил в доме: ${ob.lived}. Смен отработано: ${ob.shifts}. Помог соседям: ${ob.helped}.${ob.bestRank > 1 ? ` Лучший разряд: ${ob.bestRank}.` : ''}`;
    const wait = v.you.rebirthInSec || 0;
    $('#rebirth-submit').disabled = wait > 0;
    $('#rebirth-wait').textContent = wait > 0 ? `Дом ещё не принял вашу смерть. Новый ордер — через ${fmtSec(wait)}.` : '';
    $('#echo-box').hidden = !!v.you.echoUsed || !v.you.echoPhrases;
    memo('echo', [v.you.echoUsed, v.you.echoPhrases], () => {
      $('#echo-phrases').replaceChildren(
        ...(v.you.echoPhrases || []).map((text, i) =>
          h('button', { class: 'btn small', type: 'button', text: `«${text}»`, onclick: async () => { const r = await act('echo', { phrase: i }); if (r.ok) say(r.message); } }),
        ),
      );
    });
    memo('death', v.you.journal.length, () => {
      $('#death-journal').replaceChildren(...v.you.journal.filter((j) => j.kind !== 'death').slice(-6).reverse().map(journalItem));
    });
  }

  // ---------------------------------------------------------------------------
  // Интерфейс вокруг сцены
  // ---------------------------------------------------------------------------
  function memo(key, data, fn) {
    const s = JSON.stringify(data);
    if (S.memo[key] === s) return;
    S.memo[key] = s;
    fn();
  }

  function render() {
    const v = S.view;
    if (!v || S.banned) return;
    if (!v.you.alive) {
      if (S.sheet) closeSheet();
      showDeath(v);
      return;
    }
    $('#register').hidden = true;
    $('#death').hidden = true;
    $('#app').hidden = false;

    const you = v.you;
    $('#building').textContent = v.building;
    $('#clock').textContent = v.world.paused ? `${v.world.clock.label} ⏸` : v.world.clock.label;
    $('#who-name').textContent = you.name;
    $('#who-apt').textContent = `кв. ${you.apartment.number}`;
    $('#money').textContent = you.money;
    $('#online').textContent = `в сети: ${v.world.online}`;

    renderBanners(v);
    $('#passport-panel').hidden = !!you.account;
    $('#tutorial-panel').hidden = !you.tutorial;
    memo('tutorial', you.tutorial, () => {
      if (!you.tutorial) return;
      const next = you.tutorial.find((t) => !t.done);
      $('#tutorial').replaceChildren(...you.tutorial.map((t) => h('li', { class: t.done ? 'done' : t === next ? 'next' : '' }, t.text)));
    });
    for (const a of you.asks || []) openAsk(a);
    radioSignals(v);
    memo('stats', [you.stats, you.conditions.map((c) => [c.id, c.remainingSec == null ? null : Math.ceil(c.remainingSec / 10)])], () => renderStats(you));
    memo('inv', [you.inventory, you.gasmaskCharge, you.flashCharge], () => renderInventory(you));
    renderIous(v);
    $('#who-apt').textContent = `кв. ${you.apartment.number}${you.elderOf ? ' · ★ старший' : ''}`;
    memo('skills', you.skills, () => {
      $('#skills').replaceChildren(
        ...you.skills.map((k) =>
          h('li', null, h('span', { text: k.name }), h('b', { text: `${k.rank} разряд` }), h('small', { text: k.next != null ? `опыт ${k.xp}/${k.next}` : `опыт ${k.xp} · высший` })),
        ),
      );
    });
    memo('head', [v.here.title, v.here.text, v.here.floor, v.here.place], () => {
      const showFloor = v.here.floor != null && ['canteen', 'medpost', 'factory'].includes(v.here.place);
      $('#place-title').replaceChildren(v.here.title, ...(showFloor ? [h('span', { class: 'floor-tag', text: ` ${v.here.floor} этаж` })] : []));
      $('#place-text').textContent = v.here.text;
    });
    memo('nearby', [v.here.people, v.trades, v.here.ownHome], () => renderNearby(v));
    memo('journal', you.journal.length && you.journal[you.journal.length - 1].ts, () => {
      $('#journal').replaceChildren(...you.journal.slice().reverse().map(journalItem));
    });
    renderCaption(v);
    renderSheet();
    document.body.classList.toggle('sanity-critical', you.stats.sanity < 10);
    document.body.classList.toggle('sanity-low', you.stats.sanity >= 10 && you.stats.sanity < 25);
    syncWork(v);
  }

  function isNight(v) {
    const h = v.world.clock.hour;
    return h >= 22 || h < 6;
  }

  /** Радиоточка даёт сигнал в 06:00 и 22:00 (только у жильца, без сообщений в общий чат). */
  function radioSignals(v) {
    const bucket = isNight(v) ? 'night' : 'day';
    if (S.lastHourBucket && S.lastHourBucket !== bucket) {
      for (let i = 0; i < 3; i++) playTone(i === 2 ? 1046 : 784, 0.18, 'sine', 0.05, i * 0.35);
      toast({
        title: 'Радиоточка',
        text: bucket === 'night' ? 'Двадцать два ноль-ноль. Ночной режим: свет в коридорах приглушён.' : 'Шесть ноль-ноль. Подъём! Цех №4 ждёт.',
        style: 'info',
      });
    }
    S.lastHourBucket = bucket;
  }

  function renderBanners(v) {
    const w = v.world;
    const you = v.you;
    const list = [];
    if (w.paused) list.push(['info', 'Время в доме остановилось.']);
    if (w.fog) {
      const range = `${w.fog.from}–${w.fog.to}`;
      if (w.fog.phase === 'warning') {
        list.push([
          'siren',
          w.fog.affectsYou
            ? `СИРЕНА! Туман на этажах ${range} через ${w.fog.inSec} с. ${you.location.place === 'home' && you.sealed ? 'Вы за гермодверью.' : 'Домой и задраить гермодверь!'}`
            : `Сирена: туман на этажах ${range} через ${w.fog.inSec} с.`,
        ]);
      } else {
        let state = '';
        if (w.fog.affectsYou) {
          if (you.location.place === 'home' && you.sealed) state = ' Вы в безопасности за гермодверью.';
          else if (you.location.place === 'home') state = ' Дверь открыта — туман сочится внутрь!';
          else state = ' ВЫ В ТУМАНЕ!';
        }
        list.push(['fog', `Туман на этажах ${range}. Рассеется через ${fmtSec(w.fog.endsInSec)}.${state}`]);
      }
    }
    if (w.power) list.push(['warn', `Нет света на этажах ${w.power.from}–${w.power.to}.`]);
    if (w.lift.broken) list.push(['warn', `Лифт не работает. ${w.lift.reason || ''}`]);
    if (w.cutleryStolen) list.push(['warn', 'В столовой украли ложки — суп только со своей.']);
    memo('banners', list, () => {
      $('#banners').replaceChildren(...list.map(([cls, text]) => h('div', { class: `banner ${cls}`, text })));
    });
  }

  function renderCaption(v) {
    const t = v.you.travel;
    const cap = $('#caption');
    if (v.you.down) {
      cap.hidden = false;
      cap.className = 'caption stuck';
      cap.textContent = `Вы без сознания. ${v.you.down.remainingSec} с… Кто-нибудь может помочь.`;
      return;
    }
    if (!t) {
      cap.hidden = true;
      return;
    }
    cap.hidden = false;
    cap.className = `caption${t.stuck ? ' stuck' : ''}`;
    cap.textContent = t.stuck
      ? 'Лифт застрял между этажами. Ждите, пока починят.'
      : `${t.via === 'lift' ? 'Лифт' : 'Лестница'}: ${t.fromFloor} → ${t.toFloor} этаж · ещё ~${Math.ceil((t.etaMs || 0) / 1000)} с`;
  }

  const STAT_LABELS = { health: 'Здоровье', hunger: 'Сытость', energy: 'Силы', sanity: 'Рассудок' };

  function renderStats(you) {
    $('#stats').replaceChildren(
      ...Object.entries(STAT_LABELS).map(([k, label]) => {
        const val = you.stats[k];
        return h(
          'div',
          { class: `stat${val <= 20 ? ' low' : ''}` },
          h('div', { class: 'stat-head' }, h('span', { text: label }), h('b', { text: val })),
          h('div', { class: `bar ${k}` }, h('i', { style: `width:${val}%` })),
        );
      }),
    );
    $('#conditions').replaceChildren(
      ...you.conditions.map((c) =>
        h('li', { class: c.kind }, c.name, h('span', { class: 't', text: c.remainingSec != null ? fmtSec(c.remainingSec) : 'нужно лечение' })),
      ),
    );
  }

  /** Расписки: мои долги и долги мне. Панель видна, только если они есть. */
  function renderIous(v) {
    const you = v.you;
    const owe = (you.ious && you.ious.owe) || [];
    const held = (you.ious && you.ious.held) || [];
    $('#iou-panel').hidden = !owe.length && !held.length;
    const people = v.here.people.filter((q) => !q.away);
    memo('ious', [owe, held, people.map((q) => q.id)], () => {
      $('#ious').replaceChildren(
        ...owe.map((x) =>
          h(
            'li',
            { class: x.overdue ? 'overdue' : '' },
            h('span', { text: `Вы должны ${x.holder}: ${x.what} — до дня ${x.dueDay}${x.overdue ? ' · ПРОСРОЧЕНО' : ''}` }),
            h('button', { class: 'btn small primary', text: 'Вернуть', onclick: async () => { const r = await act('iou_repay', { id: x.id }); if (r.ok) say(r.message); } }),
          ),
        ),
        ...held.map((x) =>
          h(
            'li',
            { class: x.overdue ? 'overdue' : '' },
            h('span', { text: `Долг вам от ${x.debtor}: ${x.what} — до дня ${x.dueDay}${x.overdue ? ' · просрочено' : ''}` }),
            h('button', { class: 'btn small', text: 'Простить', onclick: async () => { if (confirm('Простить долг?')) { const r = await act('iou_forgive', { id: x.id }); if (r.ok) say(r.message); } } }),
            ...people.filter((q) => q.id !== x.debtorId).map((q) => h('button', { class: 'btn small', text: `Передать: ${q.name}`, onclick: async () => { const r = await act('iou_transfer', { id: x.id, to: q.id }); if (r.ok) say(r.message); } })),
          ),
        ),
      );
    });
  }

  function renderInventory(you) {
    const inv = $('#inventory');
    if (!you.inventory.length) {
      inv.replaceChildren(h('li', { class: 'empty', text: 'Пусто. Совсем.' }));
      return;
    }
    inv.replaceChildren(
      ...you.inventory.map((it) =>
        h(
          'li',
          { title: it.desc },
          h(
            'span',
            { class: 'name' },
            it.name,
            ' ',
            h('span', { class: 'count', text: `×${it.count}` }),
            it.equip
              ? h('span', {
                  class: `equip${(it.id === 'gasmask' && !you.gasmaskCharge) || (it.id === 'flashlight' && !you.flashCharge) ? ' dead' : ''}`,
                  text: it.id === 'gasmask' ? (you.gasmaskCharge ? ` · фильтр ${you.gasmaskCharge}%` : ' · фильтр забит') : it.id === 'flashlight' ? (you.flashCharge ? ` · заряд ${you.flashCharge}%` : ' · сел') : ' · в кармане',
                })
              : null,
          ),
          it.usable ? h('button', { class: 'btn small', text: 'Исп.', title: `Использовать: ${it.name}`, onclick: () => act('use', { item: it.id }) }) : null,
          it.readable ? h('button', { class: 'btn small', text: 'Читать', title: `Прочитать: ${it.name}`, onclick: () => act('use', { item: it.id }).then((r) => r.read && showPaper(r.read.title, r.read.text)) }) : null,
        ),
      ),
    );
  }

  function journalItem(j) {
    return h('li', { class: j.kind }, h('span', { class: 'clock-s', text: j.clock }), j.text);
  }

  function renderNearby(v) {
    const kids = [];
    for (const p of v.here.people) {
      // у себя дома хозяин может выставить гостя
      const evict = v.here.ownHome ? h('button', { class: 'btn small danger', text: 'Выставить', onclick: () => act('evict', { guest: p.id }) }) : null;
      kids.push(
        h(
          'span',
          { class: 'chip-person' },
          h('b', { text: p.name }),
          p.away ? h('span', { class: 'symptom', text: 'спит, не в сети' }) : null,
          p.rumor && p.rumor.length ? h('span', { class: 'rumor', title: 'Что о нём говорят соседи', text: p.rumor.join(', ') }) : null,
          p.rank > 1 ? h('span', { class: 'symptom', text: `${p.rank} разряд` }) : null,
          p.symptoms.length ? h('span', { class: 'symptom', text: p.symptoms.join(', ') }) : null,
          p.away ? null : h('button', { class: 'btn small', text: 'Обмен', onclick: () => tradeWith(p) }),
          evict,
        ),
      );
    }
    for (const t of v.trades) {
      kids.push(
        h(
          'div',
          { class: 'trade' },
          t.incoming
            ? `${t.other ? t.other.name : '?'} предлагает: ${t.give} — в обмен на: ${t.want}${t.creditDay ? ` (в долг, отдать до дня ${t.creditDay})` : ''}`
            : `Вы предложили ${t.other ? t.other.name : '?'}: ${t.give} — за: ${t.want}${t.creditDay ? ` (в долг до дня ${t.creditDay})` : ''}`,
          h(
            'div',
            { class: 'actions' },
            t.incoming ? h('button', { class: 'btn small primary', text: 'Принять', onclick: () => act('trade_respond', { trade: t.id, accept: true }) }) : null,
            h('button', { class: 'btn small', text: t.incoming ? 'Отказать' : 'Отозвать', onclick: () => act('trade_respond', { trade: t.id, accept: false }) }),
          ),
        ),
      );
    }
    $('#nearby').replaceChildren(...kids);
  }

  /** Обмен с соседом: если далеко — сначала подойти. */
  function tradeWith(person) {
    const a = S.actors.get(person.id);
    if (a && Math.hypot(a.x - S.me.x, a.y - S.me.y) > 2.5) walkTo({ x: a.x, y: a.y }, () => openTrade(person));
    else openTrade(person);
  }

  // ---------------------------------------------------------------------------
  // Главный цикл: движение + кадр
  // ---------------------------------------------------------------------------
  let lastTs = performance.now();
  function frame(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    const v = S.view;
    try {
      if (v && v.you.alive && S.scene && S.me && !$('#app').hidden) {
        stepMovement(dt);
        stepActors(dt);
        renderPrompt();
        drawWorld(ts / 1000);
      }
    } catch (err) {
      // одна ошибка не должна останавливать мир
      console.error(err);
      S.path = null;
    }
    requestAnimationFrame(frame);
  }

  function drawWorld(time) {
    const v = S.view;
    const you = v.you;
    const f = v.world.fog;
    let fog = null;
    if (f && f.phase === 'active' && f.affectsYou) {
      if (you.location.place === 'home') fog = you.sealed ? 'window' : 'leak';
      else fog = 'outside';
    }
    const has = (id) => you.inventory.some((i) => i.id === id);
    let liftFloor = null;
    if (you.travel && you.travel.totalMs) {
      const elapsed = you.travel.totalMs - (you.travel.etaMs || 0) + (you.travel.stuck ? 0 : performance.now() - S.viewAt);
      const k = Math.max(0, Math.min(1, elapsed / you.travel.totalMs));
      liftFloor = Math.round(you.travel.fromFloor + (you.travel.toFloor - you.travel.fromFloor) * k);
    }
    const [hh, mm] = v.world.clock.time.split(':').map(Number);
    renderer.draw({
      you: {
        id: you.id,
        name: you.name,
        x: S.me.x,
        y: S.me.y,
        d: S.me.d,
        m: S.me.m,
        self: true,
        look: lookFor(you.id),
        sick: you.conditions.some((c) => c.kind === 'disease'),
        hurt: you.conditions.some((c) => c.kind === 'injury'),
        sleep: you.sleeping && !S.me.m,
        down: !!you.down,
        newbie: !!you.tutorial,
        mask: has('gasmask') && you.gasmaskCharge > 0 && !!fog && fog !== 'window',
      },
      actors: [...S.actors.values()],
      time,
      now: Date.now(),
      gameMinutes: hh * 60 + mm,
      dark: v.world.dark,
      night: isNight(v),
      lampsOut: v.here.lampsOut || [],
      hazards: v.here.hazards || [],
      scars: v.here.scars || [],
      radioBubble: S.radioBubble,
      objectBubbles: S.objectBubbles,
      climate: v.here.climate ? v.here.climate.kind : null,
      marker: tutorialMarker(v),
      flashlight: has('flashlight') && you.flashCharge > 0,
      fog,
      fogOutside: !!(f && f.phase === 'active' && f.affectsYou),
      siren: !!(f && f.phase === 'warning' && f.affectsYou),
      liftFloor,
      liftBroken: v.world.lift.broken,
      sealed: you.sealed,
      residents: residents(),
      target: S.near,
      hover: S.hover,
      bubbles: S.bubbles,
      pathEnd: S.pathEnd,
      sanity: you.stats.sanity,
    });
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------------------
  // Чат
  // ---------------------------------------------------------------------------
  function addChat(msg) {
    const ch = msg.channel === 'global' ? 'global' : 'local';
    S.chat[ch].push(msg);
    if (S.chat[ch].length > 120) S.chat[ch].shift();
    if (ch !== S.tab && !(msg.from && msg.from.id && S.ignored.has(msg.from.id))) S.unread[ch]++;
    if (ch === 'local' && msg.from && msg.from.id && !msg.hallucination && !S.ignored.has(msg.from.id)) S.bubbles.set(msg.from.id, { text: msg.text, until: Date.now() + 6000, msgId: msg.id });
    renderChat();
  }

  function renderChat() {
    const log = $('#chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const myId = S.view && S.view.you.id;
    const list = S.chat[S.tab].filter((m) => !(m.from && m.from.id && S.ignored.has(m.from.id)));
    log.replaceChildren(
      ...(list.length
        ? list.map((m) => {
            if (m.from && m.from.system) return h('li', { class: `sys${m.radio ? ' radio' : ''}${m.garbled ? ' garbled' : ''}` }, h('span', { class: 'from', text: `📻 ${m.from.name}: ` }), m.text);
            const tools =
              m.from && m.from.id && m.from.id !== myId && !m.from.puppet
                ? h(
                    'span',
                    { class: 'msg-tools' },
                    h('button', { type: 'button', title: 'Пожаловаться в ЖЭК', text: '⚑', onclick: async () => { const r = await act('report', { id: m.id }); if (r.ok) say(r.message); } }),
                    h('button', { type: 'button', title: `Не слышать ${m.from.name}`, text: '🔇', onclick: () => ignore(m.from) }),
                  )
                : null;
            return h(
              'li',
              { class: m.hallucination ? 'ghost' : '' },
              h('span', { class: 'from' }, m.from.name, m.from.puppet ? null : h('span', { class: 'apt', text: `(${m.from.apt})` })),
              ': ',
              m.text,
              tools,
            );
          })
        : [h('li', { class: 'empty', text: S.tab === 'local' ? 'Тихо. Только гудят лампы.' : 'Радиоточка молчит.' })]),
    );
    if (nearBottom) log.scrollTop = log.scrollHeight;
    for (const tab of document.querySelectorAll('.chat .tabs .tab')) {
      const t = tab.dataset.tab;
      tab.classList.toggle('active', t === S.tab);
      tab.replaceChildren(t === 'local' ? 'Здесь' : 'Весь дом', ...(S.unread[t] ? [h('span', { class: 'badge', text: S.unread[t] })] : []));
    }
  }

  /** «Не слышать»: скрыть сообщения и облачка жильца (запоминается в этом браузере). */
  function ignore(from) {
    if (!confirm(`Не слышать ${from.name}? Его сообщения и реплики пропадут у вас. Вернуть — очистив данные сайта.`)) return;
    S.ignored.add(from.id);
    store.set('gh_ignored', JSON.stringify([...S.ignored]));
    S.bubbles.delete(from.id);
    renderChat();
  }

  function selectTab(tab) {
    S.tab = tab;
    S.unread[tab] = 0;
    renderChat();
    const log = $('#chat-log');
    log.scrollTop = log.scrollHeight;
  }

  for (const tab of document.querySelectorAll('.chat .tabs .tab')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) {
      input.blur();
      return;
    }
    const res = await act('chat', { channel: S.tab, text });
    if (res.ok) {
      input.value = '';
      input.blur(); // вернуть управление ходьбой
      // на телефоне вернуться к сцене — реплика появится облачком над головой
      if (window.innerWidth < 760) $('#stage').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // ---------------------------------------------------------------------------
  // Уведомления и модальные окна
  // ---------------------------------------------------------------------------
  function toast({ title, text, style = 'info', action = null }) {
    const el = h(
      'div',
      { class: `toast ${style}` },
      title ? h('b', { text: title }) : null,
      text,
      action
        ? h('button', {
            class: 'btn small primary toast-action',
            text: action.label,
            onclick: async () => {
              const go = async () => {
                const res = await act(action.act, action.args || {});
                if (res.ok) el.remove();
              };
              // «Открыть» на стук: сначала дойти до гермодвери
              const door = action.act === 'open_door' && S.scene && S.scene.objects.find((o) => o.type === 'hermodoor');
              if (door && door.spot && S.me && !World.nearObject(door, S.me)) {
                if (walkTo(door.spot, go)) return;
              }
              go();
            },
          })
        : null,
    );
    $('#toasts').append(el);
    setTimeout(() => el.remove(), style === 'error' ? 4000 : 6000);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }

  const MODAL_STYLES = ['siren', 'fog', 'danger', 'whisper', 'announce', 'receipt'];
  const modalQueue = [];
  let modalOpen = false;

  /** Вопрос ЖЭК с вариантами ответа. */
  function openAsk(ask) {
    if (S.shownAsks.has(ask.id)) return;
    S.shownAsks.add(ask.id);
    playDrone();
    openModal({
      title: ask.from || 'ЖЭК',
      body: ask.question,
      style: 'announce',
      actions: ask.options.map((label, i) => ({ label, primary: i === 0, onClick: async () => (await act('answer', { id: ask.id, option: i })).ok })),
    });
  }

  function notify(n) {
    if (n.ask) {
      openAsk(n.ask);
      return;
    }
    if (n.style === 'death') {
      playTone(80, 1.6, 'sawtooth', 0.12);
      return;
    }
    if (n.style === 'siren') playSiren();
    else if (n.style === 'whisper') playDrone();
    else if (n.style === 'danger' || n.style === 'fog') playTone(110, 0.5, 'square', 0.08);
    else if (n.style === 'knock') playKnock();
    else playTone(660, 0.12, 'sine', 0.04);

    if (MODAL_STYLES.includes(n.style)) {
      openModal({ title: n.title, body: n.text, style: n.style, actions: [{ label: n.style === 'whisper' ? '…' : 'Понятно', primary: true }] });
    } else {
      toast(n);
    }
  }

  function openModal(m) {
    modalQueue.push(m);
    if (!modalOpen) nextModal();
  }

  function nextModal() {
    const m = modalQueue.shift();
    const modal = $('#modal');
    if (!m) {
      modal.hidden = true;
      modalOpen = false;
      return;
    }
    modalOpen = true;
    S.keys.clear();
    modal.className = `modal ${m.style || ''}`;
    $('#modal-title').textContent = m.title || '';
    $('#modal-body').replaceChildren(typeof m.body === 'string' ? h('p', { text: m.body }) : m.body);
    $('#modal-actions').replaceChildren(
      ...m.actions.map((a) =>
        h('button', {
          class: `btn ${a.primary ? 'primary' : ''}`,
          text: a.label,
          onclick: async () => {
            if (a.onClick && (await a.onClick()) === false) return;
            nextModal();
          },
        }),
      ),
    );
    modal.hidden = false;
    const first = $('#modal-actions .btn.primary') || $('#modal-actions .btn');
    if (first && !m.keepFocus) first.focus();
  }

  // ---- помочь соседу предметом / обшарить лежачего ----
  /** Подойти к соседу на расстояние вытянутой руки (сервер разрешает касаться с touchReach). */
  function approach(id, then) {
    const a = S.actors.get(id);
    const reach = (S.config && S.config.touchReach) || 1.8;
    if (!a || !S.me || Math.hypot(a.x - S.me.x, a.y - S.me.y) <= reach - 0.2) return then();
    // ближайшая проходимая точка рядом с телом
    const spots = [[0, 0.7], [0.7, 0], [-0.7, 0], [0, -0.7], [0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6]]
      .map(([dx, dy]) => ({ x: a.x + dx, y: a.y + dy }))
      .filter((pt) => World.canStand(S.scene, pt.x, pt.y))
      .sort((p1, p2) => Math.hypot(p1.x - S.me.x, p1.y - S.me.y) - Math.hypot(p2.x - S.me.x, p2.y - S.me.y));
    for (const pt of spots) if (walkTo(pt, then)) return undefined;
    return then();
  }

  function openAid(person, down) {
    const you = S.view.you;
    const usable = you.inventory.filter((it) => it.usable);
    const run = (action, args) => async () => {
      await new Promise((resolve) => approach(person.id, resolve));
      const res = await act(action, { target: person.id, ...args });
      if (res.ok && res.message) say(res.message);
      return res.ok;
    };
    const body = h(
      'div',
      { class: 'aid-form' },
      h('p', { text: down ? `${person.name} лежит без сознания. Перевяжите, дайте таблетку или хоть что-то съестное — и он очнётся. Или нет.` : `Чем помочь ${person.name}?` }),
      usable.length
        ? h('div', { class: 'actions' }, usable.map((it) => h('button', { class: 'btn small', text: `${it.name} (×${it.count})`, onclick: async () => { if (await run('aid', { item: it.id })()) nextModal(); } })))
        : h('p', { class: 'empty', text: 'В карманах нечем помочь.' }),
    );
    openModal({
      title: down ? `${person.name} без сознания` : `Помочь: ${person.name}`,
      style: down ? 'danger' : 'trade',
      keepFocus: true,
      body,
      actions: [{ label: 'Отойти' }, ...(down ? [{ label: 'Обшарить карманы', onClick: run('rob', {}) }] : [])],
    });
  }

  // ---- обмен ----
  function openTrade(person) {
    const you = S.view.you;
    const num = (max) => h('input', { type: 'number', min: '0', max: String(max), value: '0', inputmode: 'numeric' });
    const giveMoney = num(you.money);
    const giveItems = you.inventory.map((it) => [it.id, num(it.count), it]);
    const wantMoney = num(999);
    const wantItems = Object.entries(S.catalog).map(([id, name]) => [id, num(99), { name }]);
    // «в долг»: своё отдаю сейчас, взамен — расписка
    const credit = h('input', { type: 'checkbox' });
    const creditDays = h('select', null, [1, 2, 3, 5, 7].map((d) => h('option', { value: String(d), text: String((you.day || 1) + d) })));

    const body = h(
      'div',
      null,
      h('p', { text: `${person.name} (кв. ${person.apt}). Подарок отдаётся сразу; обмен — если сосед согласится. Стойте рядом.` }),
      h(
        'div',
        { class: 'trade-grid' },
        h(
          'div',
          null,
          h('h4', { text: 'Отдаю' }),
          h('label', null, `Талоны (есть ${you.money})`, giveMoney),
          giveItems.length ? giveItems.map(([, input, it]) => h('label', null, `${it.name} (×${it.count})`, input)) : h('p', { class: 'empty', text: 'Карманы пусты' }),
        ),
        h('div', null, h('h4', { text: 'Прошу взамен' }), h('label', null, 'Талоны', wantMoney), wantItems.map(([, input, it]) => h('label', null, it.name, input))),
      ),
      h('label', { class: 'check credit' }, credit, ' в долг: пусть отдаст до дня ', creditDays, h('small', { text: ` (сегодня день ${you.day || '?'})` })),
    );
    const collect = (money, items) => ({
      money: parseInt(money.value, 10) || 0,
      items: Object.fromEntries(items.map(([id, input]) => [id, parseInt(input.value, 10) || 0]).filter(([, n]) => n > 0)),
    });
    openModal({
      title: 'Передать или обменять',
      body,
      style: 'trade',
      keepFocus: true,
      actions: [
        { label: 'Отмена' },
        { label: 'Помочь предметом', onClick: () => { setTimeout(() => openAid(person, false), 0); return true; } },
        ...(S.view.world.dark
          ? [{ label: 'Пошарить по карманам', onClick: async () => { const r = await act('pickpocket', { target: person.id }); if (r.ok) say(r.message); return true; } }]
          : []),
        { label: 'Подарить', onClick: async () => (await act('trade_offer', { to: person.id, give: collect(giveMoney, giveItems), want: {} })).ok },
        {
          label: 'Предложить обмен',
          primary: true,
          onClick: async () => {
            const res = await act('trade_offer', { to: person.id, give: collect(giveMoney, giveItems), want: collect(wantMoney, wantItems), credit: credit.checked ? Number(creditDays.value) : 0 });
            if (res.ok && !res.gift) toast({ title: 'Предложение отправлено', text: `Ждём ответа от ${person.name}.`, style: 'trade' });
            return res.ok;
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Звук (WebAudio, без файлов)
  // ---------------------------------------------------------------------------
  let actx = null;
  function unlockAudio() {
    if (!S.sound) return null;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch {
      actx = null;
    }
    return actx;
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  function playTone(freq, dur, type = 'sine', vol = 0.05, delay = 0) {
    const a = unlockAudio();
    if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function playSiren() {
    const a = unlockAudio();
    if (!a) return;
    const t = a.currentTime;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(380, t);
    for (let i = 0; i < 4; i++) {
      o.frequency.linearRampToValueAtTime(880, t + i + 0.5);
      o.frequency.linearRampToValueAtTime(380, t + i + 1);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.1);
    g.gain.setValueAtTime(0.06, t + 3.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + 4.05);
  }

  function playDrone() {
    playTone(55, 2.5, 'sine', 0.12);
    playTone(58, 2.5, 'sine', 0.08, 0.2);
  }

  function playKnock() {
    for (let i = 0; i < 3; i++) playTone(140, 0.08, 'square', 0.09, i * 0.18);
  }

  const soundBtn = $('#sound-toggle');
  const syncSoundBtn = () => {
    soundBtn.textContent = S.sound ? '🔊' : '🔇';
    soundBtn.title = S.sound ? 'Звук включён' : 'Звук выключен';
  };
  soundBtn.addEventListener('click', () => {
    S.sound = !S.sound;
    store.set('gh_sound', S.sound ? 'on' : 'off');
    syncSoundBtn();
    // выключили — замолкает и фон
    if (!S.sound && actx) actx.suspend();
    else unlockAudio();
  });
  syncSoundBtn();

  // ---- фон дома: гул ламп, капель, станки, ветер из-под двери, шаги соседей ----
  const ambient = GHSound.create(() => (S.sound ? unlockAudio() : null));
  function ambientState() {
    const v = S.view;
    if (!v || !v.you.alive || $('#app').hidden) return {};
    const f = v.world.fog;
    const fogHere = !!(f && f.phase === 'active' && f.affectsYou);
    const steps = [...S.actors.values()].filter((a) => a.m && !a.away).length;
    return {
      place: v.you.travel ? v.you.travel.via : v.here.place,
      technical: v.here.floorKind === 'technical',
      dark: !!v.world.dark,
      fogLeak: fogHere && v.here.place === 'home' && !v.you.sealed,
      fogOutside: fogHere && v.here.place !== 'home',
      steps: Math.min(3, steps),
      climate: v.here.climate ? v.here.climate.kind : null,
      night: isNight(v),
    };
  }
  setInterval(() => {
    try {
      ambient.update(ambientState());
    } catch (err) {
      console.error(err);
    }
  }, 700);

  // ---------------------------------------------------------------------------
  // Работа: мини-игры (открываются панелью над станком)
  // ---------------------------------------------------------------------------
  const BIN_KEYS = ['1', '2', '3', '4'];

  async function startWork(gameId, side = null) {
    if (S.job) return;
    const res = gameId === 'repair' ? await act('repair_start') : side ? await act('side_start', { kind: gameId }) : await act('work_start', { game: gameId });
    if (!res.ok) return;
    const job = res.job;
    S.keys.clear();
    const station = side || S.scene.objects.find((o) => o.type === 'station' && o.game === job.game);
    openSheet('work', job.data.title, station);
    S.job = { ...job, gameId, startedAt: performance.now(), state: 'playing', timers: [] };
    ({ sort: playSort, meter: playMeter, gauge: playGauge, serve: playSort, pack: playSort })[job.game](S.job);
  }

  // ---- аварийный наряд ----
  function repairSub(v, key) {
    const left = (v.world.repairs || {})[key];
    return left != null ? ` · нужен ремонт, ещё ~${left} мин` : '';
  }

  function repairAction(v, key, o) {
    return (v.world.repairs || {})[key] != null ? [{ label: 'Аварийный наряд: чинить', run: () => startWork('repair', o) }] : [];
  }

  // ---- подработка за паёк ----
  function sideSub(v) {
    const sj = v.here.sideJob;
    if (!sj) return null;
    return sj.open ? (sj.done ? `подработка: в эти часы уже были` : `подработка: ${sj.name.toLowerCase()} — сейчас`) : `подработка: ${sj.hours}`;
  }

  function sideAction(v, o) {
    const sj = v.here.sideJob;
    return sj && sj.open && !sj.done ? [{ label: `Подработать: ${sj.name}`, run: () => startWork(sj.kind, o) }] : [];
  }

  // ---- доска нарядов: план дома и доска почёта ----
  async function openPlan(obj) {
    const r = await act('plan');
    if (!r.ok) return;
    const p = r.plan;
    const body = openSheet('plan', `План дома · неделя ${p.week}`, obj);
    const pct = Math.min(100, Math.round((p.done / p.target) * 100));
    body.replaceChildren(
      h('p', { text: `Смен за неделю: ${p.done} из ${p.target}. Осталось дней: ${p.daysLeft}. Выполним — каждому участнику премия ${p.bonus} ₸.` }),
      h('div', { class: 'plan-bar' }, h('i', { style: `width:${pct}%` })),
      h('p', { class: 'note', text: `Ваших смен в плане: ${p.mine}.` }),
      ...(p.top.length ? [h('ol', { class: 'plan-top' }, p.top.map((t) => h('li', null, `${t.name} — ${t.shifts}`)))] : []),
      h('h4', { class: 'board-h', text: 'Доска почёта' }),
      r.honor
        ? h(
            'div',
            { class: 'honor' },
            h('p', { class: 'note', text: `Неделя ${r.honor.week}: ${r.honor.done >= r.honor.target ? 'план выполнен' : 'план сорван'} (${r.honor.done}/${r.honor.target}).` }),
            h('p', null, h('b', { text: 'Ударники: ' }), r.honor.workers.length ? r.honor.workers.map((w) => `${w.name} (${w.shifts})`).join(', ') : '—'),
            h('p', null, h('b', { text: 'Самые щедрые: ' }), r.honor.generous.length ? r.honor.generous.map((w) => w.name).join(', ') : '—'),
          )
        : h('p', { class: 'note', text: 'Пока пусто: первая неделя ещё идёт.' }),
    );
  }

  // ---- барыга ----
  async function openBaryga() {
    const r = await act('baryga');
    if (!r.ok) return;
    const body = openSheet('baryga', 'Барыга');
    body.replaceChildren(
      h('p', { class: 'hint', text: `«Беру: ${r.wants.join(', ')}. Наличных у меня сегодня — ${r.purse} ₸».` }),
      r.items.length
        ? h(
            'ul',
            { class: 'inventory' },
            r.items.map((x) => h('li', null, h('span', { class: 'name', text: `${x.name} ×${x.have} — ${x.price} ₸` }), h('button', { class: 'btn small', text: 'Продать 1', onclick: async () => { const res = await act('baryga_sell', { item: x.id, count: 1 }); if (res.ok) { say(res.message); openBaryga(); } } }))),
          )
        : h('p', { class: 'note', text: '«Нечего тебе продать. Приходи с лампочками».' }),
      h('div', { class: 'actions' }, h('button', { class: 'btn small', text: 'Купить монтировку', title: 'Вскрывает служебные двери на технических этажах', onclick: async () => { const res = await act('baryga_crowbar'); if (res.ok) { say(res.message); openBaryga(); } } })),
    );
  }

  function workShell(job, ...content) {
    const d = job.data;
    const timer = h('div', { class: 'timer' }, h('i', { style: 'width:100%' }));
    $('#sheet-body').replaceChildren(
      h('p', { class: 'rules', text: d.rules }),
      timer,
      ...content,
      h('div', { class: 'actions' }, h('button', { class: 'btn small danger', text: 'Бросить смену', onclick: cancelWork })),
    );
    const limit = d.limitSec * 1000;
    const iv = setInterval(() => {
      if (S.job !== job || job.state !== 'playing') return clearInterval(iv);
      const left = Math.max(0, 1 - (performance.now() - job.startedAt) / limit);
      timer.firstChild.style.width = `${left * 100}%`;
      if (left <= 0) {
        clearInterval(iv);
        if (job.onTimeout) job.onTimeout();
      }
    }, 250);
    job.timers.push(() => clearInterval(iv));
  }

  async function submitWork(job, answers) {
    if (job.state !== 'playing') return;
    job.state = 'submitting';
    job.timers.forEach((f) => f());
    const res = await act('work_submit', { job: job.id, answers });
    job.state = 'done';
    if (S.job !== job) return;
    $('#sheet-title').textContent = 'Смена окончена';
    $('#sheet-body').replaceChildren(
      h('p', { class: 'result', text: res.ok ? res.result.text : res.error }),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', text: 'Ещё смену', onclick: () => { closeSheet(); startWork(job.gameId); } }),
        h('button', { class: 'btn', text: 'Закрыть', onclick: closeSheet }),
      ),
    );
    if (res.ok && res.result.reward) playTone(880, 0.15, 'triangle', 0.06);
  }

  async function cancelWork() {
    const job = S.job;
    if (!job) return;
    job.state = 'done';
    job.timers.forEach((f) => f());
    await act('work_cancel', {}, { quiet: true });
    closeSheet();
  }

  /** Сервер прервал смену (авария, смерть, админ) — закрываем панель. */
  function syncWork(v) {
    const job = S.job;
    if (!job || job.state !== 'playing') return;
    if (!v.you.job || v.you.job.id !== job.id) {
      job.state = 'done';
      toast({ title: 'Смена прервана', text: 'Наряд закрыт без оплаты.', style: 'warn' });
      closeSheet();
    }
  }

  // 1. Сортировка
  function playSort(job) {
    const d = job.data;
    const answers = [];
    const part = h('div', { class: 'part' });
    const progress = h('div', { class: 'progress' });
    const choose = (bin) => {
      if (job.state !== 'playing') return;
      answers.push(bin);
      if (answers.length >= d.items.length) submitWork(job, answers);
      else show();
    };
    const bins = h('div', { class: 'bins' }, d.bins.map((bn, i) => h('button', { class: 'btn', onclick: () => choose(bn.id) }, bn.name, h('kbd', { text: BIN_KEYS[i] }))));
    const show = () => {
      part.textContent = d.items[answers.length];
      progress.textContent = `Деталь ${answers.length + 1} из ${d.items.length}`;
    };
    const onKey = (e) => {
      const i = BIN_KEYS.indexOf(e.key);
      if (i >= 0 && !isTyping()) choose(d.bins[i].id);
    };
    document.addEventListener('keydown', onKey);
    job.timers.push(() => document.removeEventListener('keydown', onKey));
    job.onTimeout = () => submitWork(job, answers);
    workShell(job, part, bins, progress);
    show();
  }

  // 2. Счётчики
  function playMeter(job) {
    const d = job.data;
    const screen = h('div', { class: 'reading' });
    const progress = h('div', { class: 'progress' });
    workShell(job, screen, progress);
    let i = 0;
    const inputs = d.readings.map((_, n) => h('input', { maxlength: '5', inputmode: 'numeric', placeholder: `№${n + 1}`, 'aria-label': `Показание ${n + 1}` }));
    const collect = () => inputs.map((inp) => inp.value);
    const askInputs = () => {
      screen.replaceWith(
        h(
          'form',
          { onsubmit: (e) => { e.preventDefault(); submitWork(job, collect()); } },
          h('div', { class: 'meter-inputs' }, inputs),
          h('button', { class: 'btn primary', type: 'submit', text: 'Сдать журнал' }),
        ),
      );
      progress.textContent = 'Запишите показания по порядку.';
      inputs[0].focus();
    };
    const showNext = () => {
      if (S.job !== job || job.state !== 'playing') return;
      if (i >= d.readings.length) return askInputs();
      screen.textContent = d.readings[i];
      progress.textContent = `Счётчик №${i + 1} из ${d.readings.length}`;
      i++;
      const tm = setTimeout(showNext, d.showMs);
      job.timers.push(() => clearTimeout(tm));
    };
    job.onTimeout = () => submitWork(job, collect());
    showNext();
  }

  // 3. Манометр. Формула совпадает с server/minigames.js → gaugePos.
  function gaugePos(p, tMs) {
    const t = tMs / 1000;
    return Math.max(0, Math.min(1, 0.5 + 0.33 * Math.sin(t * p.w1 + p.p1) + 0.14 * Math.sin(t * p.w2 + p.p2)));
  }

  function playGauge(job) {
    const d = job.data;
    const CW = 340, CH = 200;
    const dpr = window.devicePixelRatio || 1;
    const cnv = h('canvas', { width: CW * dpr, height: CH * dpr, 'aria-label': 'Манометр' });
    const ctx = cnv.getContext('2d');
    ctx.scale(dpr, dpr);
    const presses = [];
    let hits = 0;
    const counter = h('div', { class: 'progress', text: `Сбросов: 0 из ${d.presses}` });
    const button = h('button', { class: 'btn primary gauge-btn', text: 'СБРОС (пробел)' });

    const press = () => {
      if (job.state !== 'playing') return;
      const t = Math.round(performance.now() - job.startedAt);
      if (presses.length && t - presses[presses.length - 1] < 250) return;
      presses.push(t);
      const hit = Math.abs(gaugePos(d, t) - d.center) <= d.width / 2;
      if (hit) hits++;
      button.classList.remove('flash-hit', 'flash-miss');
      void button.offsetWidth;
      button.classList.add(hit ? 'flash-hit' : 'flash-miss');
      playTone(hit ? 740 : 180, 0.1, hit ? 'triangle' : 'square', 0.05);
      counter.textContent = `Сбросов: ${presses.length} из ${d.presses} · удачных: ${hits}`;
      if (presses.length >= d.presses) submitWork(job, presses);
    };
    button.addEventListener('click', press);
    const onKey = (e) => {
      if (e.code === 'Space' && !isTyping()) {
        e.preventDefault();
        press();
      }
    };
    document.addEventListener('keydown', onKey);
    job.timers.push(() => document.removeEventListener('keydown', onKey));

    const cx = CW / 2, cy = CH - 20, r = 140;
    const ang = (x) => Math.PI + x * Math.PI;
    const draw = () => {
      if (S.job !== job || job.state !== 'playing') return;
      const pos = gaugePos(d, performance.now() - job.startedAt);
      ctx.clearRect(0, 0, CW, CH);
      ctx.lineWidth = 18;
      ctx.strokeStyle = '#3b413f';
      ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.strokeStyle = '#8a3a33';
      ctx.beginPath(); ctx.arc(cx, cy, r, ang(0.88), 2 * Math.PI); ctx.stroke();
      ctx.strokeStyle = '#8ccf86';
      ctx.beginPath(); ctx.arc(cx, cy, r, ang(d.center - d.width / 2), ang(d.center + d.width / 2)); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#8f948d';
      for (let i = 0; i <= 10; i++) {
        const a = ang(i / 10);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (r - 16), cy + Math.sin(a) * (r - 16));
        ctx.lineTo(cx + Math.cos(a) * (r - 28), cy + Math.sin(a) * (r - 28));
        ctx.stroke();
      }
      const a = ang(pos);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#e3a13b';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8)); ctx.stroke();
      ctx.fillStyle = '#ddd8cb';
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
      requestAnimationFrame(draw);
    };
    job.onTimeout = () => submitWork(job, presses);
    workShell(job, h('div', { class: 'gauge-wrap' }, cnv, button, counter));
    requestAnimationFrame(draw);
  }

  // Для автотестов и отладки из консоли (сервер всё равно проверяет каждое действие).
  window.ghDebug = { S, renderer, walkTo, objectInfo };

  // ---------------------------------------------------------------------------
  connect();
})();
