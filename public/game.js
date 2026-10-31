'use strict';

/* Клиент Гигахрущёвки. Сервер — источник правды: клиент только рисует
   присланный «вид» (view) и отправляет действия (act). */
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

  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  };
  const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с` : `${s} с`);

  // ---------------------------------------------------------------------------
  // Состояние клиента
  // ---------------------------------------------------------------------------
  const S = {
    ws: null,
    token: store.get('gh_token'),
    view: null,
    catalog: {},
    chat: { local: [], global: [] },
    tab: 'local',
    unread: { local: 0, global: 0 },
    reqId: 0,
    pending: new Map(),
    memo: {},
    job: null,
    sound: store.get('gh_sound') !== 'off',
    retry: 0,
  };

  // ---------------------------------------------------------------------------
  // Связь
  // ---------------------------------------------------------------------------
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 0;
      $('#conn').hidden = true;
      send({ t: 'hello', token: S.token });
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

  /** Действие игрока. Ошибку показываем тостом, если не попросили молчать. */
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
        S.token = null;
        store.set('gh_token', null);
        showRegister();
        break;
      case 'register_error':
        $('#register-error').textContent = msg.error;
        toast({ title: 'Ордер не выдан', text: msg.error, style: 'error' });
        break;
      case 'welcome':
        S.token = msg.token;
        S.catalog = msg.catalog || {};
        store.set('gh_token', msg.token);
        $('#register').hidden = true;
        break;
      case 'view':
        S.view = msg.view;
        render();
        break;
      case 'chat_history':
        S.chat.global = msg.global || [];
        S.chat.local = msg.local || [];
        renderChat();
        break;
      case 'chat':
        addChat(msg.msg);
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
  // Регистрация и смерть
  // ---------------------------------------------------------------------------
  function showRegister() {
    $('#app').hidden = true;
    $('#death').hidden = true;
    $('#register').hidden = false;
    setTimeout(() => $('#register-name').focus(), 50);
  }

  $('#register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#register-error').textContent = '';
    unlockAudio();
    send({ t: 'register', name: $('#register-name').value });
  });

  $('#rebirth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    closeWork();
    send({ t: 'register', name: $('#rebirth-name').value });
  });

  function showDeath(v) {
    $('#app').hidden = true;
    $('#death').hidden = false;
    $('#death-cause').textContent = `${v.you.name}, кв. ${v.you.apartment.number}. ${v.you.deathCause || ''}.`;
    memo('death', v.you.journal.length, () => {
      $('#death-journal').replaceChildren(...v.you.journal.filter((j) => j.kind !== 'death').slice(-6).reverse().map(journalItem));
    });
    setOverlays(null);
  }

  // ---------------------------------------------------------------------------
  // Рисование
  // ---------------------------------------------------------------------------
  /** Перерисовать секцию только если её данные поменялись (не сбиваем клики и фокус). */
  function memo(key, data, fn) {
    const s = JSON.stringify(data);
    if (S.memo[key] === s) return;
    S.memo[key] = s;
    fn();
  }

  function render() {
    const v = S.view;
    if (!v) return;
    if (!v.you.alive) {
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
    memo('stats', [you.stats, you.conditions.map((c) => [c.id, c.remainingSec == null ? null : Math.ceil(c.remainingSec / 10)])], () => renderStats(you));
    memo('inv', [you.inventory, you.gasmaskCharge], () => renderInventory(you));
    memo('place', [v.here, you.location, you.travel, you.sealed, you.sleeping, you.money, v.trades, v.world.fog && v.world.fog.phase], () => renderPlace(v));
    memo('nav', [you.location, !!you.travel, v.facilities, v.world.lift, Math.floor(you.stats.energy / 5)], () => renderNav(v));
    memo('journal', you.journal.length && you.journal[you.journal.length - 1].ts, () => {
      $('#journal').replaceChildren(...you.journal.slice().reverse().map(journalItem));
    });
    setOverlays(v);
    syncWork(v);
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

  const STAT_LABELS = { health: 'Здоровье', hunger: 'Сытость', energy: 'Силы', sanity: 'Рассудок' };

  function renderStats(you) {
    $('#stats').replaceChildren(
      ...Object.entries(STAT_LABELS).map(([k, label]) => {
        const v = you.stats[k];
        return h(
          'div',
          { class: `stat${v <= 20 ? ' low' : ''}` },
          h('div', { class: 'stat-head' }, h('span', { text: label }), h('b', { text: v })),
          h('div', { class: `bar ${k}` }, h('i', { style: `width:${v}%` })),
        );
      }),
    );
    $('#conditions').replaceChildren(
      ...you.conditions.map((c) =>
        h('li', { class: c.kind }, c.name, c.remainingSec != null ? h('span', { class: 't', text: fmtSec(c.remainingSec) }) : h('span', { class: 't', text: 'нужно лечение' })),
      ),
    );
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
            it.equip ? h('span', { class: 'equip', text: it.id === 'gasmask' ? ` · фильтр ${you.gasmaskCharge}%` : ' · в кармане' }) : null,
          ),
          it.usable ? h('button', { class: 'btn small', text: 'Исп.', title: `Использовать: ${it.name}`, onclick: () => act('use', { item: it.id }) }) : null,
        ),
      ),
    );
  }

  function journalItem(j) {
    return h('li', { class: j.kind }, h('span', { class: 'clock-s', text: j.clock }), j.text);
  }

  // ---- место ----
  function renderPlace(v) {
    const you = v.you;
    const here = v.here;
    const box = $('#place');
    const kids = [];
    kids.push(h('h1', null, here.title, here.floor != null && here.place !== 'home' ? h('span', { class: 'floor-tag', text: `${here.floor} этаж` }) : null));
    kids.push(h('p', { class: 'place-text', text: here.text }));
    if (here.closed) kids.push(h('div', { class: 'closed', text: here.closed }));

    if (you.travel) {
      const t = you.travel;
      const label = t.stuck
        ? 'Застряли. Ждите, пока починят лифт.'
        : `${t.via === 'lift' ? 'Лифт' : 'Лестница'} → ${t.toFloor} этаж · ещё ~${Math.ceil((t.etaMs || 0) / 1000)} с`;
      kids.push(h('div', { class: `travel${t.stuck ? ' stuck' : ''}` }, h('span', { text: label })));
    }

    if (here.place === 'home') {
      const fogSoon = v.world.fog && v.world.fog.affectsYou;
      kids.push(
        h(
          'div',
          { class: 'actions' },
          h('button', {
            class: `btn ${!you.sealed && fogSoon ? 'primary' : ''}`,
            text: you.sealed ? 'Открыть гермодверь' : 'Задраить гермодверь',
            onclick: () => act('seal', { on: !you.sealed }),
          }),
          h('button', { class: 'btn', text: you.sleeping ? 'Проснуться' : 'Лечь спать', onclick: () => act('sleep', { on: !you.sleeping }) }),
        ),
      );
    }

    if (here.shop) {
      kids.push(h('div', { class: 'sub-h', text: here.place === 'canteen' ? 'Раздача' : 'Окошко фельдшера' }));
      kids.push(
        h(
          'div',
          { class: 'shop' },
          here.shop.map((e) =>
            h(
              'div',
              { class: 'shop-row' },
              h('div', null, e.name, e.desc ? h('span', { class: 'desc', text: e.desc }) : null, e.note ? h('span', { class: 'note', text: e.note }) : null),
              h('span', { class: 'price', text: `${e.price} ₸` }),
              h('button', {
                class: 'btn small',
                text: e.eat ? 'Взять' : 'Купить',
                disabled: !!here.closed || you.money < e.price || !!you.travel,
                onclick: () => act('buy', { shop: here.place, key: e.key }),
              }),
            ),
          ),
        ),
      );
    }

    if (here.jobs) {
      kids.push(h('div', { class: 'sub-h', text: `Наряды на смену · −${here.workCost.energy} сил, −${here.workCost.hunger} сытости · до 6 ₸` }));
      kids.push(
        h(
          'div',
          { class: 'actions' },
          here.jobs.map((j) =>
            h('button', { class: 'btn', text: j.name, disabled: !!here.closed || !!you.job || !!S.job, onclick: () => startWork(j.id) }),
          ),
        ),
      );
    }

    if (here.residents) {
      kids.push(h('div', { class: 'sub-h', text: 'Двери этажа' }));
      kids.push(
        h(
          'div',
          { class: 'residents' },
          here.residents.map((r) =>
            h(
              'div',
              { class: `door${r.you ? ' you' : ''}` },
              h('span', { class: 'num', text: `кв. ${r.number}` }),
              r.name ? [h('span', { class: `dot${r.online ? ' on' : ''}` }), r.you ? `${r.name} (вы)` : r.name] : h('span', { class: 'empty', text: 'пустует' }),
            ),
          ),
        ),
      );
    }

    if (v.trades.length) {
      kids.push(h('div', { class: 'sub-h', text: 'Предложения обмена' }));
      kids.push(
        h(
          'div',
          { class: 'trades' },
          v.trades.map((t) =>
            h(
              'div',
              { class: 'trade' },
              t.incoming
                ? `${t.other ? t.other.name : '?'} предлагает: ${t.give} — в обмен на: ${t.want}`
                : `Вы предложили ${t.other ? t.other.name : '?'}: ${t.give} — за: ${t.want}`,
              h(
                'div',
                { class: 'actions' },
                t.incoming ? h('button', { class: 'btn small primary', text: 'Принять', onclick: () => act('trade_respond', { trade: t.id, accept: true }) }) : null,
                h('button', { class: 'btn small', text: t.incoming ? 'Отказать' : 'Отозвать', onclick: () => act('trade_respond', { trade: t.id, accept: false }) }),
              ),
            ),
          ),
        ),
      );
    }

    if (here.place !== 'home') {
      kids.push(h('div', { class: 'sub-h', text: here.people.length ? 'Рядом с вами' : 'Рядом никого' }));
      if (here.people.length) {
        kids.push(
          h(
            'ul',
            { class: 'people' },
            here.people.map((p) =>
              h(
                'li',
                null,
                h('span', null, h('b', { text: p.name }), ` · кв. ${p.apt}`, p.symptoms.length ? h('span', { class: 'symptom', text: ` — ${p.symptoms.join(', ')}` }) : null),
                h('button', { class: 'btn small', text: 'Передать / обмен', onclick: () => openTrade(p) }),
              ),
            ),
          ),
        );
      }
    }
    box.replaceChildren(...kids);
  }

  // ---- навигация ----
  function renderNav(v) {
    const you = v.you;
    const here = you.location;
    const busy = !!you.travel;
    const liftBroken = v.world.lift.broken;
    const route = (floor) => {
      const diff = Math.abs(floor - here.floor);
      if (!diff) return 'рядом';
      if (!liftBroken) return `лифт · ${diff} эт.`;
      return `лестница · −${Math.ceil(diff * 0.4)} сил`;
    };
    const btn = (label, sub, dest, isHere, extra = '') =>
      h('button', { class: `btn${isHere ? ' here' : ''}`, disabled: busy || isHere, onclick: () => act('move', dest) }, h('span', { text: label }), h('small', { text: sub + extra }));

    const fac = v.facilities;
    const facBtn = (key) =>
      btn(fac[key].name, `${fac[key].floor} эт. · ${route(fac[key].floor)}`, { place: key }, here.place === key, fac[key].open ? '' : ' · закрыто');

    $('#nav-buttons').replaceChildren(
      btn('Домой', `кв. ${you.apartment.number} · ${route(you.apartment.floor)}`, { place: 'home' }, here.place === 'home'),
      btn('Выйти в коридор', `${here.floor} этаж`, { place: 'corridor', floor: here.floor }, here.place === 'corridor' || busy),
      facBtn('canteen'),
      facBtn('medpost'),
      facBtn('factory'),
    );
    const ls = $('#lift-status');
    ls.textContent = liftBroken ? 'Лифт сломан — пешком' : 'Лифт работает';
    ls.className = `lift-status${liftBroken ? ' broken' : ''}`;
    $('#lift-form button').disabled = busy;
  }

  $('#lift-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const floor = parseInt($('#lift-floor').value, 10);
    if (!Number.isFinite(floor)) return;
    act('move', { place: 'corridor', floor });
  });

  // ---- атмосфера ----
  function setOverlays(v) {
    const fog = $('#fog');
    const dark = $('#dark');
    fog.className = 'fog-overlay';
    dark.className = 'dark-overlay';
    document.body.classList.remove('sanity-low', 'sanity-critical');
    if (!v) return;
    const you = v.you;
    const f = v.world.fog;
    if (f && f.phase === 'active' && f.affectsYou) {
      if (you.location.place === 'home' && you.sealed) fog.classList.add('light');
      else if (you.location.place === 'home') fog.classList.add('medium');
      else fog.classList.add('heavy');
    }
    if (v.world.dark) {
      dark.classList.add('on');
      if (you.inventory.some((i) => i.id === 'flashlight')) dark.classList.add('torch');
    }
    if (you.stats.sanity < 10) document.body.classList.add('sanity-critical');
    else if (you.stats.sanity < 25) document.body.classList.add('sanity-low');
  }

  document.addEventListener('pointermove', (e) => {
    const dark = $('#dark');
    dark.style.setProperty('--mx', `${e.clientX}px`);
    dark.style.setProperty('--my', `${e.clientY}px`);
  });

  // ---------------------------------------------------------------------------
  // Чат
  // ---------------------------------------------------------------------------
  function addChat(msg) {
    const ch = msg.channel === 'global' ? 'global' : 'local';
    S.chat[ch].push(msg);
    if (S.chat[ch].length > 120) S.chat[ch].shift();
    if (ch !== S.tab) S.unread[ch]++;
    renderChat();
  }

  function renderChat() {
    const log = $('#chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const list = S.chat[S.tab];
    log.replaceChildren(
      ...(list.length
        ? list.map((m) => {
            if (m.from && m.from.system) return h('li', { class: 'sys' }, h('span', { class: 'from', text: `📻 ${m.from.name}: ` }), m.text);
            return h(
              'li',
              { class: m.hallucination ? 'ghost' : '' },
              h('span', { class: 'from' }, m.from.name, h('span', { class: 'apt', text: `(${m.from.apt})` })),
              ': ',
              m.text,
            );
          })
        : [h('li', { class: 'empty', text: S.tab === 'local' ? 'Тихо. Только гудят лампы.' : 'Радиоточка молчит.' })]),
    );
    if (nearBottom) log.scrollTop = log.scrollHeight;
    for (const tab of document.querySelectorAll('.tab')) {
      const t = tab.dataset.tab;
      tab.classList.toggle('active', t === S.tab);
      tab.replaceChildren(t === 'local' ? 'Здесь' : 'Весь дом', ...(S.unread[t] ? [h('span', { class: 'badge', text: S.unread[t] })] : []));
    }
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      S.tab = tab.dataset.tab;
      S.unread[S.tab] = 0;
      renderChat();
      const log = $('#chat-log');
      log.scrollTop = log.scrollHeight;
    });
  }

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    const res = await act('chat', { channel: S.tab, text });
    if (res.ok) input.value = '';
  });

  // ---------------------------------------------------------------------------
  // Уведомления и модальные окна
  // ---------------------------------------------------------------------------
  function toast({ title, text, style = 'info' }) {
    const el = h('div', { class: `toast ${style}` }, title ? h('b', { text: title }) : null, text);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), style === 'error' ? 4000 : 6000);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }

  const MODAL_STYLES = ['siren', 'fog', 'danger', 'whisper', 'announce'];
  const modalQueue = [];
  let modalOpen = false;

  function notify(n) {
    if (n.style === 'death') {
      playTone(80, 1.6, 'sawtooth', 0.12);
      return;
    }
    if (n.style === 'siren') playSiren();
    else if (n.style === 'whisper') playDrone();
    else if (n.style === 'danger' || n.style === 'fog') playTone(110, 0.5, 'square', 0.08);
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
    modal.className = `modal ${m.style || ''}`;
    $('#modal-title').textContent = m.title || '';
    const body = $('#modal-body');
    body.replaceChildren(typeof m.body === 'string' ? h('p', { text: m.body }) : m.body);
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

  // ---- обмен ----
  function openTrade(person) {
    const you = S.view.you;
    const num = (max) => h('input', { type: 'number', min: '0', max: String(max), value: '0', inputmode: 'numeric' });
    const giveMoney = num(you.money);
    const giveItems = you.inventory.map((it) => [it.id, num(it.count), it]);
    const wantMoney = num(999);
    const wantItems = Object.entries(S.catalog).map(([id, name]) => [id, num(99), { name }]);

    const body = h(
      'div',
      null,
      h('p', { text: `${person.name} (кв. ${person.apt}). Подарок отдаётся сразу; обмен — если сосед согласится.` }),
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
        h(
          'div',
          null,
          h('h4', { text: 'Прошу взамен' }),
          h('label', null, 'Талоны', wantMoney),
          wantItems.map(([, input, it]) => h('label', null, it.name, input)),
        ),
      ),
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
        {
          label: 'Подарить',
          onClick: async () => (await act('trade_offer', { to: person.id, give: collect(giveMoney, giveItems), want: {} })).ok,
        },
        {
          label: 'Предложить обмен',
          primary: true,
          onClick: async () => {
            const res = await act('trade_offer', { to: person.id, give: collect(giveMoney, giveItems), want: collect(wantMoney, wantItems) });
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

  function playTone(freq, dur, type = 'sine', vol = 0.05) {
    const a = unlockAudio();
    if (!a) return;
    const t = a.currentTime;
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
    setTimeout(() => playTone(58, 2.5, 'sine', 0.08), 200);
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
  });
  syncSoundBtn();

  // ---------------------------------------------------------------------------
  // Работа: мини-игры
  // ---------------------------------------------------------------------------
  const BIN_KEYS = ['1', '2', '3', '4'];

  async function startWork(gameId) {
    const res = await act('work_start', { game: gameId });
    if (!res.ok) return;
    const job = res.job;
    S.job = { ...job, gameId, startedAt: performance.now(), state: 'playing', timers: [] };
    const panel = $('#work');
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ({ sort: playSort, meter: playMeter, gauge: playGauge })[job.game](S.job);
  }

  function workShell(job, ...content) {
    const d = job.data;
    const timer = h('div', { class: 'timer' }, h('i', { style: 'width:100%' }));
    $('#work').replaceChildren(
      h('h1', { text: d.title }),
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
        job.onTimeout && job.onTimeout();
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
    const text = res.ok ? res.result.text : res.error;
    $('#work').replaceChildren(
      h('h1', { text: 'Смена окончена' }),
      h('p', { class: 'result', text }),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', text: 'Ещё смену', onclick: () => { closeWork(); startWork(job.gameId); } }),
        h('button', { class: 'btn', text: 'Закрыть', onclick: closeWork }),
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
    closeWork();
  }

  function closeWork() {
    if (S.job) S.job.timers.forEach((f) => f());
    S.job = null;
    $('#work').hidden = true;
    $('#work').replaceChildren();
    S.memo.place = null; // кнопки нарядов снова активны
    render();
  }

  /** Сервер прервал смену (ушли, авария, смерть) — закрываем панель. */
  function syncWork(v) {
    const job = S.job;
    if (!job || job.state !== 'playing') return;
    if (!v.you.job || v.you.job.id !== job.id) {
      job.state = 'done';
      job.timers.forEach((f) => f());
      toast({ title: 'Смена прервана', text: 'Наряд закрыт без оплаты.', style: 'warn' });
      closeWork();
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
    const bins = h(
      'div',
      { class: 'bins' },
      d.bins.map((b, i) => h('button', { class: 'btn', onclick: () => choose(b.id) }, b.name, h('kbd', { text: BIN_KEYS[i] }))),
    );
    const show = () => {
      part.textContent = d.items[answers.length];
      progress.textContent = `Деталь ${answers.length + 1} из ${d.items.length}`;
    };
    const onKey = (e) => {
      const i = BIN_KEYS.indexOf(e.key);
      if (i >= 0 && document.activeElement?.tagName !== 'INPUT') choose(d.bins[i].id);
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
    const showNext = () => {
      if (S.job !== job || job.state !== 'playing') return;
      if (i >= d.readings.length) return askInputs();
      screen.textContent = d.readings[i];
      progress.textContent = `Счётчик №${i + 1} из ${d.readings.length}`;
      i++;
      const t = setTimeout(showNext, d.showMs);
      job.timers.push(() => clearTimeout(t));
    };
    const inputs = d.readings.map((_, n) => h('input', { maxlength: '5', inputmode: 'numeric', placeholder: `№${n + 1}`, 'aria-label': `Показание ${n + 1}` }));
    const collect = () => inputs.map((inp) => inp.value);
    const askInputs = () => {
      screen.replaceWith(
        h(
          'form',
          {
            onsubmit: (e) => {
              e.preventDefault();
              submitWork(job, collect());
            },
          },
          h('div', { class: 'meter-inputs' }, inputs),
          h('button', { class: 'btn primary', type: 'submit', text: 'Сдать журнал' }),
        ),
      );
      progress.textContent = 'Запишите показания по порядку.';
      inputs[0].focus();
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
    const W = 340, H = 200;
    const dpr = window.devicePixelRatio || 1;
    const canvas = h('canvas', { width: W * dpr, height: H * dpr, 'aria-label': 'Манометр' });
    const ctx = canvas.getContext('2d');
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
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        press();
      }
    };
    document.addEventListener('keydown', onKey);
    job.timers.push(() => document.removeEventListener('keydown', onKey));

    const cx = W / 2, cy = H - 20, r = 140;
    const ang = (x) => Math.PI + x * Math.PI;
    const draw = () => {
      if (S.job !== job || job.state !== 'playing') return;
      const pos = gaugePos(d, performance.now() - job.startedAt);
      ctx.clearRect(0, 0, W, H);
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
    workShell(job, h('div', { class: 'gauge-wrap' }, canvas, button, counter));
    requestAnimationFrame(draw);
  }

  // ---------------------------------------------------------------------------
  connect();
})();
