'use strict';

/* Пульт ЖЭК — админка «симулятор бога». */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

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

  const session = {
    get(k) {
      try { return sessionStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ }
    },
  };

  const fmtSec = (s) => (s == null ? 'бессрочно' : s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} с`);
  const STATS = [['health', 'Здоровье'], ['hunger', 'Сытость'], ['energy', 'Силы'], ['sanity', 'Рассудок']];

  const A = {
    ws: null,
    password: session.get('gh_admin'),
    content: null,
    snap: null,
    log: [],
    chat: [],
    reqId: 0,
    pending: new Map(),
    selected: null,
    rows: new Map(),
    memo: {},
    pickers: [],
    built: false,
    retry: 0,
  };

  // ---------------------------------------------------------------------------
  // Связь
  // ---------------------------------------------------------------------------
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/admin-ws`);
    A.ws = ws;
    ws.onopen = () => {
      A.retry = 0;
      $('#conn').hidden = true;
      if (A.password) send({ t: 'auth', password: A.password });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      if (A.ws !== ws) return;
      if (A.built) $('#conn').hidden = false;
      for (const [, r] of A.pending) r({ ok: false, error: 'Нет связи' });
      A.pending.clear();
      setTimeout(connect, Math.min(10000, 800 * 2 ** A.retry++));
    };
  }

  function send(msg) {
    if (A.ws && A.ws.readyState === WebSocket.OPEN) A.ws.send(JSON.stringify(msg));
  }

  function cmd(name, args = {}, okText) {
    return new Promise((resolve) => {
      const id = ++A.reqId;
      A.pending.set(id, resolve);
      send({ t: 'cmd', id, cmd: name, args });
    }).then((res) => {
      if (!res.ok) toast(res.error || 'Ошибка', 'error');
      else if (res.message || okText) toast(res.message || okText, 'good');
      return res;
    });
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'auth_error':
        A.password = null;
        session.set('gh_admin', null);
        $('#login').hidden = false;
        $('#app').hidden = true;
        $('#login-error').textContent = msg.error;
        break;
      case 'admin_init':
        A.content = msg.content;
        A.log = msg.log || [];
        A.chat = (msg.chat || []).slice();
        A.snap = msg.snapshot;
        A.players = new Map(msg.snapshot.players.map((p) => [p.id, p]));
        $('#login').hidden = true;
        $('#app').hidden = false;
        if (!A.built) build();
        else {
          // переподключились: палитра могла измениться, а Глазок — надо снова попросить
          rebuildContent();
          if (!$('#tab-eye').hidden) send({ t: 'watch', key: E.key });
        }
        renderLog();
        renderChat();
        renderSnapshot();
        break;
      case 'snapshot': {
        // сервер шлёт только изменившихся жильцов
        if (msg.full || !A.players) A.players = new Map();
        for (const p of msg.upsert || []) A.players.set(p.id, p);
        for (const id of msg.remove || []) A.players.delete(id);
        A.snap = { ...msg.snapshot, players: [...A.players.values()] };
        renderSnapshot();
        break;
      }
      case 'watch':
        onWatch(msg.scene);
        break;
      case 'admin_content':
        // палитра изменилась — пересобираем списки
        A.content = msg.content;
        if (A.built) rebuildContent();
        break;
      case 'log':
        A.log.push(msg.entry);
        if (A.log.length > 500) A.log.shift();
        appendLog(msg.entry);
        break;
      case 'chat':
        A.chat.push(msg.msg);
        if (A.chat.length > 300) A.chat.shift();
        appendChat(msg.msg);
        break;
      case 'chat_delete':
        A.chat = A.chat.filter((m) => m.id !== msg.id);
        renderChat();
        break;
      case 'res': {
        const r = A.pending.get(msg.id);
        A.pending.delete(msg.id);
        if (r) r(msg);
        break;
      }
      default:
    }
  }

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    A.password = $('#password').value;
    session.set('gh_admin', A.password);
    $('#login-error').textContent = '';
    if (A.ws && A.ws.readyState === WebSocket.OPEN) send({ t: 'auth', password: A.password });
  });

  function toast(text, style = 'info') {
    const el = h('div', { class: `toast ${style}`, text });
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 4000);
    while ($('#toasts').children.length > 5) $('#toasts').firstChild.remove();
  }

  // ---------------------------------------------------------------------------
  // Виджеты форм
  // ---------------------------------------------------------------------------
  const num = (value, attrs = {}) => h('input', { type: 'number', value: String(value), ...attrs });
  const field = (label, input) => h('label', { class: 'f' }, label, input);
  const select = (options, value) => {
    const s = h('select', null, options.map(([v, label]) => h('option', { value: v, text: label })));
    if (value != null) s.value = value;
    return s;
  };
  const opts = (obj, empty) => [...(empty ? [['', empty]] : []), ...Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : v.name])];

  function alivePlayers() {
    return (A.snap?.players || []).filter((p) => p.alive).sort((a, b) => a.apartment.number.localeCompare(b.apartment.number));
  }

  /** Выбор цели события: все / онлайн / этажи / место / жилец / случайные N. */
  function targetPicker(defaultType = 'all') {
    const type = select(
      [
        ['all', 'Все живые жильцы'],
        ['online', 'Только кто в сети'],
        ['floors', 'Кто сейчас на этажах…'],
        ['place', 'Кто сейчас в месте…'],
        ['player', 'Конкретный жилец…'],
        ['random', 'Случайные жильцы…'],
      ],
      defaultType,
    );
    const from = num(101, { min: 1, max: 999, 'aria-label': 'С этажа' });
    const to = num(105, { min: 1, max: 999, 'aria-label': 'По этаж' });
    const place = select(opts(A.content.places));
    const player = h('select', { 'aria-label': 'Жилец' });
    const count = num(1, { min: 1, max: 999, 'aria-label': 'Сколько' });
    const onlyOnline = h('input', { type: 'checkbox' });
    const rows = {
      floors: h('div', { class: 'row' }, 'с', from, 'по', to),
      place: h('div', { class: 'row' }, place),
      player: h('div', { class: 'row' }, player),
      random: h('div', { class: 'row' }, 'сколько:', count, h('label', { class: 'check' }, onlyOnline, 'только в сети')),
    };
    const sync = () => {
      for (const [k, r] of Object.entries(rows)) r.hidden = type.value !== k;
    };
    type.addEventListener('change', sync);
    sync();
    const picker = {
      el: h('div', { class: 'target' }, h('span', { class: 'target-title', text: 'Кого коснётся' }), type, Object.values(rows)),
      sig: '',
      refresh() {
        const list = alivePlayers();
        const sig = list.map((p) => `${p.id}:${p.name}`).join('|');
        if (sig === picker.sig) return;
        picker.sig = sig;
        const keep = player.value;
        player.replaceChildren(...list.map((p) => h('option', { value: p.id, text: `${p.name} · кв. ${p.apartment.number}` })));
        if (list.some((p) => p.id === keep)) player.value = keep;
      },
      get() {
        switch (type.value) {
          case 'floors': return { type: 'floors', from: from.value, to: to.value };
          case 'place': return { type: 'place', place: place.value };
          case 'player': return { type: 'player', id: player.value };
          case 'random': return { type: 'random', count: count.value, online: onlyOnline.checked };
          default: return { type: type.value };
        }
      },
    };
    A.pickers.push(picker);
    picker.refresh();
    return picker;
  }

  function card(title, hint, cls, ...body) {
    return h('section', { class: `panel event-card ${cls || ''}` }, h('h2', { text: title }), hint ? h('p', { class: 'hint', text: hint }) : null, ...body);
  }

  /**
   * Добавить к карточке события блок «⏱ Запланировать»: та же команда, но позже или по расписанию.
   * opts: { label, cmd, args: () => {...} | null, extra: [элементы выбора, если нужны] }
   */
  function withSchedule(cardEl, opts) {
    const mode = select([['in', 'через N минут'], ['at', 'в игровое время'], ['window', 'в случайный момент за N минут']], 'in');
    const value = h('input', { value: '10', 'aria-label': 'Минуты или время ЧЧ:ММ' });
    const repeat = select([['none', 'один раз'], ['every', 'каждые N минут'], ['daily', 'каждые игровые сутки']], 'none');
    const repeatMin = num(60, { min: 1, 'aria-label': 'Повтор, минут' });
    const sync = () => {
      if (mode.value === 'at' && !/:/.test(value.value)) value.value = '02:00';
      if (mode.value !== 'at' && /:/.test(value.value)) value.value = '10';
      repeatMin.disabled = repeat.value !== 'every';
    };
    mode.addEventListener('change', sync);
    repeat.addEventListener('change', sync);
    sync();
    const val = (x) => (typeof x === 'function' ? x() : x);
    cardEl.append(
      h(
        'details',
        { class: 'sched' },
        h('summary', { text: '⏱ Запланировать' }),
        ...(opts.extra || []),
        h('div', { class: 'grid2' }, field('Когда', mode), field('Минут или ЧЧ:ММ', value)),
        h('div', { class: 'grid2' }, field('Повтор', repeat), field('Каждые, мин', repeatMin)),
        actions(
          button('Поставить в расписание', () => {
            const args = opts.args();
            if (!args) return;
            cmd('schedule', { cmd: val(opts.cmd), args, label: val(opts.label), mode: mode.value, value: value.value, repeat: repeat.value, repeatMin: repeatMin.value });
          }),
        ),
      ),
    );
    return cardEl;
  }

  function actions(...buttons) {
    return h('div', { class: 'actions' }, buttons);
  }

  function button(label, onclick, cls = '') {
    return h('button', { class: `btn ${cls}`, text: label, type: 'button', onclick });
  }

  // ---------------------------------------------------------------------------
  // Сборка интерфейса (один раз после входа)
  // ---------------------------------------------------------------------------
  function build() {
    A.built = true;
    for (const tab of document.querySelectorAll('.admin-tabs .tab')) tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    $('#pause-btn').addEventListener('click', () => cmd('pause', { paused: !A.snap.world.paused }));
    $('#player-filter').addEventListener('input', renderPlayers);
    $('#show-dead').addEventListener('change', renderPlayers);
    $('#log-filter').addEventListener('change', renderLog);
    $('#admin-chat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#admin-chat-text').value.trim();
      if (!text) return;
      const res = await cmd('chat', { text, as: $('#admin-chat-as').value });
      if (res.ok) $('#admin-chat-text').value = '';
    });
    buildEvents();
    buildPalette();
    initEye();
  }

  function switchTab(name) {
    for (const t of document.querySelectorAll('.admin-tabs .tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const page of document.querySelectorAll('.tab-page')) page.hidden = page.id !== `tab-${name}`;
    // Глазок шлёт кадры сцены только пока на него смотрят
    send({ t: 'watch', key: name === 'eye' ? E.key : null });
  }

  /** Палитра добавила или убрала болезнь/случай/предмет — пересобрать всё, где есть списки. */
  function rebuildContent() {
    A.pickers = [];
    $('#event-grid').replaceChildren();
    buildEvents();
    renderPalette();
    fillEyeTools();
    A.memo.cardShell = null;
    renderSnapshot();
  }

  function buildEvents() {
    const C = A.content;
    const grid = $('#event-grid');
    const firstFloor = C.building.firstResidentialFloor;

    // --- Туман ---
    const fogFrom = num(firstFloor, { min: 1, max: 999 });
    const fogTo = num(firstFloor + 4, { min: 1, max: 999 });
    const fogWarn = num(30, { min: 0, max: 600 });
    const fogDur = num(3, { min: 0.5, max: 120, step: 0.5 });
    const fogPower = select([['0.5', 'Лёгкая дымка'], ['1', 'Обычный'], ['2', 'Густой'], ['4', 'Смертельный']], '1');
    grid.append(
      card(
        'Нашествие тумана',
        'Сирена предупреждает жильцов на этажах. Кто не за задраенной гермодверью — теряет здоровье и рассудок.',
        'fog-card',
        h('div', { class: 'grid2' }, field('С этажа', fogFrom), field('По этаж', fogTo)),
        h('div', { class: 'grid3' }, field('Сирена, сек', fogWarn), field('Длится, мин', fogDur), field('Плотность', fogPower)),
        actions(
          button('Наслать туман', () => cmd('fog', { from: fogFrom.value, to: fogTo.value, warnSec: fogWarn.value, durationMin: fogDur.value, intensity: fogPower.value }, 'Туман пошёл'), 'primary'),
          button('Развеять', () => cmd('fogEnd')),
        ),
      ),
    );

    withSchedule(grid.lastElementChild, {
      label: () => `Туман на этажах ${fogFrom.value}–${fogTo.value}`,
      cmd: 'fog',
      args: () => ({ from: fogFrom.value, to: fogTo.value, warnSec: fogWarn.value, durationMin: fogDur.value, intensity: fogPower.value }),
    });

    // --- Поломки ---
    A.breakdownRows = {};
    const bdRows = Object.entries(C.breakdowns).map(([key, def]) => {
      const reason = h('input', { placeholder: 'причина (необязательно)', maxlength: '200' });
      const dur = num(0, { min: 0, max: 600, title: 'Минут до самопочинки (0 — пока не почините)' });
      const state = h('span', { class: 'state' });
      const btn = button('Сломать', () => {
        const broken = !!A.snap.world.breakdowns[key];
        cmd('breakdown', { key, broken: !broken, reason: reason.value, durationMin: dur.value });
      });
      A.breakdownRows[key] = { state, btn };
      return h('div', null, h('div', { class: 'bd-row' }, h('b', { text: def.name }), state, btn), h('div', { class: 'row' }, reason, dur));
    });
    grid.append(card('Поломки оборудования', 'Минуты — через сколько починится само (0 — пока вы не почините).', 'warn-card', bdRows));

    const bdKey = select(opts(C.breakdowns));
    const bdDur = num(10, { min: 0, max: 600 });
    withSchedule(grid.lastElementChild, {
      label: () => `Поломка: ${C.breakdowns[bdKey.value].name}`,
      cmd: 'breakdown',
      args: () => ({ key: bdKey.value, broken: true, durationMin: bdDur.value }),
      extra: [h('div', { class: 'grid2' }, field('Что сломать', bdKey), field('Минут до починки (0 — ∞)', bdDur))],
    });

    // --- Свет ---
    const pwFrom = num(firstFloor, { min: 1, max: 999 });
    const pwTo = num(firstFloor + 9, { min: 1, max: 999 });
    const pwDur = num(0, { min: 0, max: 600 });
    grid.append(
      card(
        'Отключение света',
        'Темнота съедает рассудок у жильцов без фонарика. Учреждения на обесточенных этажах закрываются.',
        'warn-card',
        h('div', { class: 'grid3' }, field('С этажа', pwFrom), field('По этаж', pwTo), field('Минут (0 — ∞)', pwDur)),
        actions(button('Отключить свет', () => cmd('power', { on: false, from: pwFrom.value, to: pwTo.value, durationMin: pwDur.value })), button('Дать свет', () => cmd('power', { on: true }))),
      ),
    );

    withSchedule(grid.lastElementChild, {
      label: () => `Отключение света ${pwFrom.value}–${pwTo.value}`,
      cmd: 'power',
      args: () => ({ on: false, from: pwFrom.value, to: pwTo.value, durationMin: pwDur.value }),
    });

    // --- Ложки ---
    const steal = num(30, { min: 0, max: 100 });
    grid.append(
      card(
        'Кража столовых приборов',
        'Столовая теряет ложки: суп — только со своей. У части жильцов пропадают ложки и вилки из карманов.',
        'warn-card',
        field('Сколько процентов владельцев ограбить', steal),
        actions(button('Украсть', () => cmd('cutlery', { steal: true, percent: steal.value }), 'primary'), button('Вернуть ложки в столовую', () => cmd('cutlery', { steal: false }))),
      ),
    );

    withSchedule(grid.lastElementChild, { label: 'Кража столовых приборов', cmd: 'cutlery', args: () => ({ steal: true, percent: steal.value }) });

    // --- Снабжение и лампы ---
    A.supplyInfo = h('p', { class: 'hint' });
    const lampFrom = num(firstFloor, { min: 1, max: 999 });
    const lampTo = num(firstFloor + 4, { min: 1, max: 999 });
    const lampCount = num(3, { min: 1, max: 6 });
    grid.append(
      card(
        'Снабжение и лампы',
        'Завоз в 08:00: чем больше смен закрыли жильцы, тем больше привезут. Погасшие лампы жильцы могут вкрутить сами (лампочки — из мусоропровода).',
        'warn-card',
        A.supplyInfo,
        actions(button('Внеплановый завоз', () => cmd('supply', { mode: 'extra' }), 'small'), button('Недовоз в 08:00', () => cmd('supply', { mode: 'short' }), 'small'), button('Обычный завоз', () => cmd('supply', { mode: 'normal' }), 'small')),
        h('div', { class: 'grid3' }, field('С этажа', lampFrom), field('По этаж', lampTo), field('Сколько ламп', lampCount)),
        actions(button('Погасить лампы', () => cmd('lamps', { from: lampFrom.value, to: lampTo.value, count: lampCount.value }), 'small'), button('Заменить все', () => cmd('lamps', { from: lampFrom.value, to: lampTo.value, on: true }), 'small')),
      ),
    );
    withSchedule(grid.lastElementChild, { label: () => `Погасить лампы ${lampFrom.value}–${lampTo.value}`, cmd: 'lamps', args: () => ({ from: lampFrom.value, to: lampTo.value, count: lampCount.value }) });

    // --- Эпидемия ---
    const epiTarget = targetPicker('random');
    const epiCond = select(opts(C.conditions));
    const epiSilent = h('input', { type: 'checkbox' });
    grid.append(
      card(
        'Болезни и травмы',
        'Заразные болезни сами передаются тем, кто находится рядом.',
        'danger-card',
        epiTarget.el,
        field('Что', epiCond),
        h('label', { class: 'check' }, epiSilent, 'тихо (жилец узнает по симптомам)'),
        actions(button('Заразить', () => cmd('infect', { target: epiTarget.get(), condition: epiCond.value, silent: epiSilent.checked }), 'primary')),
      ),
    );

    withSchedule(grid.lastElementChild, {
      label: () => `Болезнь: ${C.conditions[epiCond.value].name}`,
      cmd: 'infect',
      args: () => ({ target: epiTarget.get(), condition: epiCond.value, silent: epiSilent.checked }),
    });

    // --- Несчастный случай ---
    const accTarget = targetPicker('random');
    const accSel = select(opts(C.accidents));
    const accText = h('p', { class: 'hint' });
    const syncAcc = () => (accText.textContent = `«${C.accidents[accSel.value].text}»`);
    accSel.addEventListener('change', syncAcc);
    syncAcc();
    grid.append(
      card('Несчастный случай', null, 'danger-card', accTarget.el, field('Что случится', accSel), accText, actions(button('Устроить', () => cmd('accident', { target: accTarget.get(), accident: accSel.value }), 'primary'))),
    );

    withSchedule(grid.lastElementChild, {
      label: () => `Несчастный случай: ${C.accidents[accSel.value].name}`,
      cmd: 'accident',
      args: () => ({ target: accTarget.get(), accident: accSel.value }),
    });

    // --- Гуманитарка ---
    const aidTarget = targetPicker('all');
    const aidMoney = num(3, { min: 0, max: 999 });
    const aidItem = select(opts(C.items, '— без предмета —'), 'bread');
    const aidCount = num(1, { min: 1, max: 99 });
    const aidTitle = h('input', { value: 'Гуманитарная помощь', maxlength: '80' });
    const aidText = h('input', { value: 'ЖЭК выдал паёк. Распишитесь в получении.', maxlength: '300' });
    grid.append(
      card(
        'Гуманитарная помощь',
        null,
        'good-card',
        aidTarget.el,
        h('div', { class: 'grid3' }, field('Талоны', aidMoney), field('Предмет', aidItem), field('Кол-во', aidCount)),
        field('Заголовок', aidTitle),
        field('Текст', aidText),
        actions(
          button('Выдать', () => cmd('aid', { target: aidTarget.get(), money: aidMoney.value, items: aidItem.value ? { [aidItem.value]: aidCount.value } : {}, title: aidTitle.value, text: aidText.value }), 'primary'),
        ),
      ),
    );

    withSchedule(grid.lastElementChild, {
      label: () => aidTitle.value || 'Гуманитарная помощь',
      cmd: 'aid',
      args: () => ({ target: aidTarget.get(), money: aidMoney.value, items: aidItem.value ? { [aidItem.value]: aidCount.value } : {}, title: aidTitle.value, text: aidText.value }),
    });

    // --- Объявление ---
    const annTitle = h('input', { value: 'Объявление ЖЭК', maxlength: '80' });
    const annText = h('textarea', { maxlength: '500', placeholder: 'Уважаемые жильцы! В связи с…' });
    grid.append(card('Объявление по радиоточке', 'Всплывает у всех живых жильцов и попадает в общий чат.', '', field('Заголовок', annTitle), field('Текст', annText), actions(button('Объявить', () => cmd('announce', { title: annTitle.value, text: annText.value }), 'primary'))));

    withSchedule(grid.lastElementChild, {
      label: () => `Объявление: ${annText.value.slice(0, 40)}`,
      cmd: 'announce',
      args: () => (annText.value.trim() ? { title: annTitle.value, text: annText.value } : (toast('Сначала напишите текст объявления', 'error'), null)),
    });

    // --- Шёпот ---
    const whTarget = targetPicker('player');
    const whFrom = h('input', { value: 'Голос за стеной', maxlength: '60' });
    const whText = h('textarea', { maxlength: '500', placeholder: 'Не открывай дверь…' });
    grid.append(
      card('Шёпот', 'Жуткое личное сообщение. Видит только адресат.', 'whisper-card', whTarget.el, field('От кого', whFrom), field('Текст', whText), actions(button('Шепнуть', () => cmd('whisper', { target: whTarget.get(), from: whFrom.value, text: whText.value }), 'primary'))),
    );

    withSchedule(grid.lastElementChild, {
      label: () => `Шёпот: ${whText.value.slice(0, 40)}`,
      cmd: 'whisper',
      args: () => (whText.value.trim() ? { target: whTarget.get(), from: whFrom.value, text: whText.value } : (toast('Сначала напишите, что шепнуть', 'error'), null)),
    });

    // --- Дилемма ---
    const askTarget = targetPicker('player');
    const askFrom = h('input', { value: 'ЖЭК', maxlength: '40' });
    const askQ = h('textarea', { maxlength: '300', placeholder: 'Ваш сосед из 10103 нарушает режим. Сообщить?' });
    const askOpts = h('textarea', { maxlength: '200', rows: '3', placeholder: 'Да, сообщу\nНет\nПромолчу' });
    const askTimeout = num(5, { min: 1, max: 600 });
    const askArgs = () => ({ target: askTarget.get(), from: askFrom.value, question: askQ.value, options: askOpts.value.split('\n'), timeoutMin: askTimeout.value });
    grid.append(
      card(
        'Дилемма',
        'Вопрос жильцу с 2–3 вариантами (по строке на вариант). Ответы — в журнале, фильтр «Ответы». Последствия решаете вы.',
        'whisper-card',
        askTarget.el,
        field('От кого', askFrom),
        field('Вопрос', askQ),
        field('Варианты ответа (по строке)', askOpts),
        field('Сколько минут вопрос ждёт ответа', askTimeout),
        actions(button('Спросить', () => cmd('ask', askArgs()), 'primary')),
      ),
    );
    withSchedule(grid.lastElementChild, { label: () => `Дилемма: ${askQ.value.slice(0, 40)}`, cmd: 'ask', args: askArgs });

    // --- Опасность на клетке ---
    const hzKind = select(opts(C.hazards), 'steam');
    const hzWhere = select([['player', 'Под ногами у жильца'], ['corridor', 'В коридоре этажа'], ['canteen', 'В столовой'], ['medpost', 'В медпункте'], ['factory', 'В цеху']], 'player');
    const hzPlayer = h('select', { 'aria-label': 'Жилец' });
    const hzFloor = num(firstFloor, { min: 1, max: 999, 'aria-label': 'Этаж' });
    const hzMin = num(0, { min: 0, max: 1440 });
    const hzPickerRow = h('div', { class: 'row' }, hzPlayer);
    const hzFloorRow = h('div', { class: 'row' }, 'этаж', hzFloor);
    const syncHz = () => {
      hzPickerRow.hidden = hzWhere.value !== 'player';
      hzFloorRow.hidden = hzWhere.value !== 'corridor';
    };
    hzWhere.addEventListener('change', syncHz);
    syncHz();
    // список жильцов обновляется вместе с остальными выборами
    const hzPicker = {
      sig: '',
      refresh() {
        const list = alivePlayers();
        const sig = list.map((p) => `${p.id}:${p.name}`).join('|');
        if (sig === hzPicker.sig) return;
        hzPicker.sig = sig;
        const keep = hzPlayer.value;
        hzPlayer.replaceChildren(...list.map((p) => h('option', { value: p.id, text: `${p.name} · кв. ${p.apartment.number}` })));
        if (list.some((p) => p.id === keep)) hzPlayer.value = keep;
      },
    };
    A.pickers.push(hzPicker);
    hzPicker.refresh();
    const hzArgs = () => {
      const base = { kind: hzKind.value, minutes: hzMin.value };
      if (hzWhere.value === 'player') return hzPlayer.value ? { ...base, playerId: hzPlayer.value } : (toast('Некого выбрать', 'error'), null);
      return { ...base, scene: hzWhere.value === 'corridor' ? `corridor:${hzFloor.value}` : hzWhere.value };
    };
    A.hazardList = h('ul', { class: 'hazard-list' });
    grid.append(
      card(
        'Опасность на клетке',
        'Видимая беда на полу: кто наступит — обожжётся, получит удар током, провалится или будет укушен. Соседи могут её огородить. Точно в клетку — кликом во вкладке «Глазок».',
        'danger-card',
        h('div', { class: 'grid2' }, field('Что', hzKind), field('На сколько минут (0 — пока не уберут)', hzMin)),
        field('Где', hzWhere),
        hzPickerRow,
        hzFloorRow,
        actions(button('Поставить', () => {
          const a = hzArgs();
          if (a) cmd('hazard', a);
        }, 'primary'), button('Убрать все', () => cmd('hazardClear', {})), button('Стереть все следы', () => confirm('Стереть копоть, налёт, мел и записки погибших во всём доме?') && cmd('scarsClear', {}))),
        A.hazardList,
      ),
    );
    withSchedule(grid.lastElementChild, { label: () => `Опасность: ${C.hazards[hzKind.value]}`, cmd: 'hazard', args: hzArgs });

    // --- Радиоточка ---
    const radioText = h('textarea', { maxlength: '300', placeholder: 'Говорит ЖЭК. Сегодня в 22:00 — проверка гермодверей.' });
    const radioSilence = num(10, { min: 1, max: 1440 });
    A.radioInfo = h('div', { class: 'radio-info' });
    grid.append(
      card(
        'Радиоточка',
        'Свой эфир: слышат только те, кто сейчас у радиоточки (дома или в столовой). Между передачами — новости дома и обычные реплики. У кого пошатнулся рассудок — эфир сбоит. «Тишина в эфире» — хороший предвестник.',
        'warn-card',
        field('Текст передачи', radioText),
        actions(
          button('В эфир сейчас', () => radioText.value.trim() && cmd('radio', { text: radioText.value, now: true }).then((r) => r.ok && (radioText.value = '')), 'primary'),
          button('В очередь', () => radioText.value.trim() && cmd('radio', { text: radioText.value }).then((r) => r.ok && (radioText.value = ''))),
        ),
        h('div', { class: 'row' }, 'Тишина на', radioSilence, 'мин', button('Тишина в эфире', () => cmd('radioSilence', { minutes: radioSilence.value }), 'small'), button('Вернуть эфир', () => cmd('radioSilence', { minutes: 0 }), 'small')),
        A.radioInfo,
      ),
    );
    withSchedule(grid.lastElementChild, { label: () => `Радиоточка: ${radioText.value.slice(0, 40)}`, cmd: 'radio', args: () => (radioText.value.trim() ? { text: radioText.value, now: true } : (toast('Сначала напишите текст передачи', 'error'), null)) });

    // --- Записка под дверь ---
    const noteTarget = targetPicker('player');
    noteTarget.el.querySelector('select').disabled = true; // только конкретному жильцу
    const noteFrom = h('input', { maxlength: '40', placeholder: 'пусто — без подписи' });
    const noteText = h('textarea', { maxlength: '300', placeholder: 'Не выходи завтра на смену.' });
    const noteArgs = () => {
      const t = noteTarget.get();
      if (!noteText.value.trim()) return toast('Сначала напишите записку', 'error'), null;
      return { id: t.id, text: noteText.value, from: noteFrom.value };
    };
    grid.append(
      card(
        'Записка под дверь',
        'Жилец найдёт её, когда будет дома. Подпись — любая или никакой; в журнале видно, что это ЖЭК.',
        'whisper-card',
        noteTarget.el,
        field('Подпись', noteFrom),
        field('Текст', noteText),
        actions(button('Подбросить', () => {
          const a = noteArgs();
          if (a) cmd('plantNote', a).then((r) => r.ok && (noteText.value = ''));
        }, 'primary')),
      ),
    );
    withSchedule(grid.lastElementChild, { label: () => `Записка: ${noteText.value.slice(0, 40)}`, cmd: 'plantNote', args: noteArgs });

    // --- Произвольное событие ---
    grid.append(buildCustomEvent());
    withSchedule(grid.lastElementChild, { label: () => A.customEvent.label(), cmd: 'custom', args: () => A.customEvent.args() });
  }

  // Заготовки для произвольного события
  const PRESETS = {
    pipe: { title: 'Прорвало трубу', text: 'Из стены с рёвом бьёт кипяток. Пар заполняет коридор.', style: 'danger', target: 'floors', effect: { health: -10, sanity: -5 } },
    parcel: { title: 'Посылка', text: 'Под дверью стоит коробка без обратного адреса. Внутри — банка тушёнки.', style: 'good', target: 'random', effect: {}, item: ['stew', 1] },
    fee: { title: 'Сбор на ремонт лифта', text: 'ЖЭК удержал взнос на ремонт лифта. Лифт, разумеется, не починят.', style: 'announce', target: 'all', effect: { money: -2 } },
    silence: { title: 'Тишина', text: 'На целую минуту все звуки в доме исчезли. Даже ваше дыхание.', style: 'whisper', target: 'online', effect: { sanity: -15 } },
    feast: { title: 'Праздничный обед', text: 'В честь годовщины корпуса всем выдали по пирожку с капустой.', style: 'good', target: 'all', effect: { hunger: 30, sanity: 10 } },
    mold: { title: 'Чёрная плесень', text: 'Стены покрылись чёрными пятнами. Дышать тяжело, в горле першит.', style: 'danger', target: 'floors', effect: { health: -5 }, condition: 'cough' },
  };

  function buildCustomEvent() {
    const C = A.content;
    const preset = select([['', '— заготовки —'], ...Object.entries(PRESETS).map(([k, v]) => [k, v.title])]);
    const target = targetPicker('all');
    const title = h('input', { placeholder: 'Название', maxlength: '80' });
    const text = h('textarea', { maxlength: '500', placeholder: 'Что видит жилец' });
    const style = select([['danger', 'Тревожное'], ['warn', 'Предупреждение'], ['good', 'Хорошее'], ['whisper', 'Жуткое'], ['announce', 'Объявление']], 'danger');
    const deltas = Object.fromEntries([...STATS, ['money', 'Талоны']].map(([k]) => [k, num(0, { 'aria-label': k })]));
    const item = select(opts(C.items, '— предмет —'));
    const itemCount = num(1, { 'aria-label': 'Количество (минус — забрать)' });
    const condition = select(opts(C.conditions, '— без болезни —'));
    const cure = h('input', { type: 'checkbox' });
    const kill = h('input', { type: 'checkbox' });

    preset.addEventListener('change', () => {
      const p = PRESETS[preset.value];
      if (!p) return;
      title.value = p.title;
      text.value = p.text;
      style.value = p.style;
      for (const [k, input] of Object.entries(deltas)) input.value = p.effect[k] || 0;
      item.value = p.item ? p.item[0] : '';
      itemCount.value = p.item ? p.item[1] : 1;
      condition.value = p.condition || '';
      cure.checked = false;
      kill.checked = false;
      const typeSel = target.el.querySelector('select');
      typeSel.value = p.target;
      typeSel.dispatchEvent(new Event('change'));
    });

    const collect = () => {
      const effect = Object.fromEntries(Object.entries(deltas).map(([k, input]) => [k, Number(input.value) || 0]));
      if (item.value) effect.items = { [item.value]: Number(itemCount.value) || 0 };
      if (condition.value) effect.condition = condition.value;
      if (cure.checked) effect.cure = true;
      if (kill.checked) effect.kill = true;
      if (kill.checked && !confirm('Событие убьёт всех, кого коснётся. Точно?')) return null;
      return { target: target.get(), title: title.value, text: text.value, style: style.value, effect };
    };
    A.customEvent = { args: collect, label: () => title.value || 'Своё событие' };
    const run = () => {
      const args = collect();
      if (args) cmd('custom', args);
    };

    return card(
      'Своё событие',
      'Любое происшествие: текст + изменения параметров. Отрицательные числа отнимают.',
      'danger-card',
      field('Заготовка', preset),
      target.el,
      field('Название', title),
      field('Текст', text),
      field('Тон уведомления', style),
      h('div', { class: 'grid5' }, Object.entries(deltas).map(([k, input]) => field({ health: '❤', hunger: '🍞', energy: '⚡', sanity: '🧠', money: '₸' }[k], input))),
      h('div', { class: 'grid2' }, field('Предмет', item), field('Кол-во (−забрать)', itemCount)),
      field('Наслать болезнь/травму', condition),
      h('div', { class: 'row' }, h('label', { class: 'check' }, cure, 'исцелить'), h('label', { class: 'check' }, kill, 'убить')),
      actions(button('Устроить', run, 'primary')),
    );
  }

  // ---------------------------------------------------------------------------
  // Отрисовка состояния
  // ---------------------------------------------------------------------------
  function memo(key, data, fn) {
    const s = JSON.stringify(data);
    if (A.memo[key] === s) return;
    A.memo[key] = s;
    fn();
  }

  function renderSnapshot() {
    const s = A.snap;
    if (!s || !A.built) return;
    const alive = s.players.filter((p) => p.alive).length;
    $('#clock').textContent = s.clock.label + (s.world.paused ? ' ⏸' : '');
    $('#counts').textContent = `в сети ${s.online} · живых ${alive} · погибших ${s.players.length - alive}`;
    $('#pause-btn').textContent = s.world.paused ? '▶ Запустить время' : '⏸ Пауза мира';
    renderStatus();
    renderSchedule();
    if (A.supplyInfo) {
      const st = s.world.stock || {};
      const short = Object.entries(st).flatMap(([shop, items]) => Object.entries(items).filter(([, n]) => n <= 2).map(([k, n]) => `${A.content.items[k]?.name || k}: ${n}`));
      A.supplyInfo.textContent = `Смен за сутки: ${s.world.shiftsToday}. Следующий завоз: ${Math.round((s.world.supplyNext ?? 1) * 100)}% от расчёта.${short.length ? ` Заканчивается: ${short.join(', ')}.` : ''}${s.world.lampsOutFloors ? ` Этажей с погасшими лампами: ${s.world.lampsOutFloors}.` : ''}`;
    }
    renderPlayers();
    renderCard();
    renderDirector();
    renderHazards();
    renderRadio();
    renderEyeSide();
    for (const picker of A.pickers) picker.refresh();
    for (const [key, row] of Object.entries(A.breakdownRows || {})) {
      const b = s.world.breakdowns[key];
      row.state.textContent = b ? `сломано · ${fmtSec(b.endsInSec)}` : 'работает';
      row.state.className = `state${b ? ' broken' : ''}`;
      row.btn.textContent = b ? 'Починить' : 'Сломать';
    }
  }

  function renderStatus() {
    const w = A.snap.world;
    const C = A.content;
    const chips = [];
    if (w.paused) chips.push({ key: 'pause', cls: 'warn', label: '⏸ Мир на паузе', btn: ['Запустить', () => cmd('pause', { paused: false })] });
    if (w.fog) {
      chips.push({
        key: 'fog',
        cls: 'fog',
        label: `🌫 Туман ${w.fog.from}–${w.fog.to} · сила ${w.fog.intensity}`,
        timer: () => (A.snap.world.fog ? (A.snap.world.fog.phase === 'warning' ? `сирена, придёт через ${A.snap.world.fog.inSec} с` : `рассеется через ${fmtSec(A.snap.world.fog.endsInSec)}`) : ''),
        btn: ['Развеять', () => cmd('fogEnd')],
      });
    }
    if (w.power) {
      chips.push({
        key: 'power',
        cls: 'warn',
        label: `💡 Нет света ${w.power.from}–${w.power.to}`,
        timer: () => fmtSec(A.snap.world.power?.endsInSec ?? null),
        btn: ['Дать свет', () => cmd('power', { on: true })],
      });
    }
    for (const [key, b] of Object.entries(w.breakdowns)) {
      if (!b) continue;
      chips.push({
        key: `bd-${key}`,
        cls: 'danger',
        label: `🔧 ${C.breakdowns[key].name}: сломано`,
        timer: () => fmtSec(A.snap.world.breakdowns[key]?.endsInSec ?? null),
        btn: ['Починить', () => cmd('breakdown', { key, broken: false })],
      });
    }
    if (w.cutleryStolen) chips.push({ key: 'cutlery', cls: 'warn', label: '🥄 Ложки украдены', btn: ['Вернуть', () => cmd('cutlery', { steal: false })] });

    memo('status', chips.map((c) => [c.key, c.label]), () => {
      A.statusTimers = [];
      $('#status').replaceChildren(
        ...(chips.length
          ? chips.map((c) => {
              const t = c.timer ? h('span', { class: 't' }) : null;
              if (t) A.statusTimers.push([t, c.timer]);
              return h('span', { class: `chip ${c.cls}` }, c.label, t, button(c.btn[0], c.btn[1], 'small'));
            })
          : [h('span', { class: 'calm', text: 'В доме спокойно. Пока.' })]),
      );
    });
    for (const [el, fn] of A.statusTimers || []) el.textContent = fn();
  }

  function renderSchedule() {
    const list = A.snap.schedule || [];
    const fmt = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} ч ${Math.floor((sec % 3600) / 60)} мин` : fmtSec(sec));
    memo('schedule', list.map((e) => [e.id, e.label, e.repeatSec, e.runs]), () => {
      A.schedTimers = [];
      $('#schedule-list').replaceChildren(
        ...(list.length
          ? list.map((e) => {
              const t = h('span', { class: 't' });
              A.schedTimers.push([t, e.id]);
              return h(
                'li',
                null,
                h('b', { text: e.label }),
                ' · ',
                t,
                e.repeatSec
                  ? h('span', { class: 'muted', text: ` · ${e.repeatSec === 1440 ? 'каждые игровые сутки (24 мин)' : `каждые ${Math.round(e.repeatSec / 60)} мин`} · срабатывало: ${e.runs}` })
                  : null,
                button('Отменить', () => cmd('unschedule', { id: e.id }), 'small'),
              );
            })
          : [h('li', { class: 'empty', text: 'Ничего не запланировано. Откройте «⏱ Запланировать» в любой карточке на вкладке «События дома».' })]),
      );
    });
    const byId = new Map(list.map((e) => [e.id, e]));
    for (const [el, id] of A.schedTimers || []) {
      const e = byId.get(id);
      if (e) el.textContent = `через ${fmt(e.inSec)}${A.snap.world.paused ? ' (пауза)' : ''}`;
    }
    const tab = document.querySelector('.admin-tabs .tab[data-tab="schedule"]');
    if (tab) tab.textContent = list.length ? `Расписание (${list.length})` : 'Расписание';
  }

  function whereText(p) {
    if (!p.alive) return `☠ ${p.deathCause || ''}`;
    let s = p.location.title;
    if (p.location.place !== 'home' && p.location.place !== 'corridor' && p.location.floor != null) s += ` (${p.location.floor})`;
    if (p.travel) s = `${p.travel.via === 'lift' ? 'лифт' : 'лестница'} → ${p.travel.toFloor}${p.travel.stuck ? ' · ЗАСТРЯЛ' : ''}`;
    if (p.sealed) s += ' 🔒';
    if (p.sleeping) s += ' 💤';
    if (p.homeward && !p.online) s += ' · бредёт домой';
    if (p.working) s += ' 🔧';
    return s;
  }

  function setCell(td, text, cls = '') {
    if (td.textContent !== text) td.textContent = text;
    if (td.className !== cls) td.className = cls;
  }

  function renderPlayers() {
    const filter = $('#player-filter').value.trim().toLowerCase();
    const showDead = $('#show-dead').checked;
    const all = A.snap.players;
    const list = all
      .filter((p) => (showDead || p.alive) && (!filter || p.name.toLowerCase().includes(filter) || p.apartment.number.includes(filter)))
      .sort((a, b) => b.alive - a.alive || b.online - a.online || a.apartment.number.localeCompare(b.apartment.number));
    const body = $('#players-body');
    const seen = new Set();
    list.forEach((p, i) => {
      let tr = A.rows.get(p.id);
      if (!tr) {
        tr = h('tr', { onclick: () => selectPlayer(p.id) });
        for (let c = 0; c < 9; c++) tr.append(h('td'));
        A.rows.set(p.id, tr);
      }
      const td = tr.children;
      setCell(td[0], `${p.online ? '●' : '○'} ${p.name}`, p.online ? 'on' : '');
      td[0].style.color = p.online ? 'var(--green)' : '';
      setCell(td[1], p.apartment.number, 'num');
      setCell(td[2], whereText(p));
      STATS.forEach(([k], j) => setCell(td[3 + j], String(p.stats[k]), `num${p.alive && p.stats[k] <= 20 ? ' low' : ''}`));
      setCell(td[7], String(p.money), 'num');
      setCell(td[8], p.conditions.map((c) => c.name).join(', '), 'conds');
      tr.classList.toggle('dead', !p.alive);
      tr.classList.toggle('selected', p.id === A.selected);
      if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null);
      seen.add(p.id);
    });
    for (const [id, tr] of A.rows) {
      if (seen.has(id)) continue;
      tr.remove();
      if (!all.some((p) => p.id === id)) A.rows.delete(id);
    }
    $('#players-empty').hidden = all.length > 0;
  }

  function selectPlayer(id) {
    A.selected = id;
    A.memo.cardShell = null;
    renderPlayers();
    renderCard();
  }

  // ---- карточка жильца ----
  function renderCard() {
    const box = $('#player-card');
    const p = A.snap.players.find((x) => x.id === A.selected);
    if (!p) {
      if (A.selected) {
        A.selected = null;
        A.memo.cardShell = null;
      }
      memo('cardShell', 'none', () => box.replaceChildren(h('p', { class: 'empty', text: 'Выберите жильца в таблице, чтобы решить его судьбу.' })));
      return;
    }
    memo('cardShell', [p.id, p.alive], () => buildCard(box, p));
    memo('cardDyn', p, () => fillCard(p));
  }

  function buildCard(box, p) {
    const C = A.content;
    const id = p.id;
    A.card = {};
    A.memo.cardDyn = null;
    const header = h('div', null, (A.card.title = h('h2')), (A.card.meta = h('div', { class: 'card-meta' })), (A.card.harm = h('div', { class: 'card-meta' })));
    const dyn = (A.card.dyn = h('div'));

    if (!p.alive) {
      const kids = [header, dyn];
      kids.push(
        h(
          'div',
          { class: 'card-section' },
          h('h3', { text: 'Жизнь и смерть' }),
          actions(
            button('Воскресить', () => cmd('revive', { id }, 'Жилец очнулся'), 'primary'),
            button('Стереть из домовой книги', () => confirm(`Стереть ${p.name} навсегда?`) && cmd('erase', { id }, 'Стёрт'), 'danger'),
          ),
        ),
      );
      box.replaceChildren(...kids);
      return;
    }

    // Параметры
    const statInputs = Object.fromEntries([...STATS, ['money', 'Талоны']].map(([k]) => [k, h('input', { type: 'number', min: '0', max: k === 'money' ? '9999' : '100' })]));
    const fillStats = () => {
      const cur = A.snap.players.find((x) => x.id === id);
      if (!cur) return;
      for (const [k] of STATS) statInputs[k].value = cur.stats[k];
      statInputs.money.value = cur.money;
    };
    fillStats();
    const statsSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Задать параметры' }),
      h('div', { class: 'stat-inputs' }, [...STATS, ['money', 'Талоны']].map(([k, label]) => h('label', null, label, statInputs[k]))),
      actions(
        button('Применить', () => cmd('setStats', { id, stats: Object.fromEntries(Object.entries(statInputs).map(([k, i]) => [k, i.value])) }, 'Готово'), 'primary small'),
        button('Текущие значения', fillStats, 'small'),
        button('Полностью исцелить', () => {
          cmd('setStats', { id, stats: { health: 100, hunger: 100, energy: 100, sanity: 100 } });
          cmd('cure', { id, condition: 'all' });
        }, 'small'),
      ),
    );

    // Карманы
    const giveItem = select(opts(C.items));
    const giveCount = num(1, { min: 1, max: 99 });
    const giveSilent = h('input', { type: 'checkbox' });
    const moneyDelta = num(5);
    const invSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Карманы' }),
      (A.card.inv = h('div', { class: 'tags' })),
      h('div', { class: 'row', style: 'margin-top:8px' }, giveItem, giveCount),
      h(
        'div',
        { class: 'row' },
        button('Подбросить', () => cmd('give', { id, item: giveItem.value, count: giveCount.value, silent: giveSilent.checked }), 'small'),
        button('Отнять', () => cmd('give', { id, item: giveItem.value, count: -Math.abs(giveCount.value), silent: giveSilent.checked }), 'small'),
        h('label', { class: 'check' }, giveSilent, 'тайно'),
      ),
      h(
        'div',
        { class: 'row' },
        'Талоны:',
        moneyDelta,
        button('Начислить', () => cmd('money', { id, delta: Math.abs(moneyDelta.value), silent: giveSilent.checked }), 'small'),
        button('Списать', () => cmd('money', { id, delta: -Math.abs(moneyDelta.value), silent: giveSilent.checked }), 'small'),
      ),
    );

    // Болезни
    const condSel = select(opts(C.conditions));
    const condSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Болезни и травмы' }),
      (A.card.conds = h('div', { class: 'tags' })),
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        condSel,
        button('Наслать', () => cmd('infect', { target: { type: 'player', id }, condition: condSel.value }), 'small'),
        button('Вылечить всё', () => cmd('cure', { id, condition: 'all' }), 'small'),
      ),
    );

    // Несчастный случай
    const accSel = select(opts(C.accidents));
    const accSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Несчастный случай' }),
      h('div', { class: 'row' }, accSel, button('Устроить', () => cmd('accident', { id, accident: accSel.value }), 'small danger')),
    );

    // Перемещение
    const placeSel = select(opts(C.places), 'corridor');
    const floorIn = num(p.location.floor || C.building.firstResidentialFloor, { min: 1, max: 999 });
    const tpSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Переместить' }),
      h('div', { class: 'row' }, placeSel, floorIn, button('Переместить', () => cmd('teleport', { id, place: placeSel.value, floor: floorIn.value }), 'small')),
    );

    // Шёпот
    const whFrom = h('input', { value: 'Голос за стеной', maxlength: '60', 'aria-label': 'От кого' });
    const whText = h('textarea', { maxlength: '500', placeholder: 'Что услышит жилец', 'aria-label': 'Текст шёпота' });
    const whSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Шёпот' }),
      h('div', { class: 'row' }, whFrom),
      whText,
      actions(
        button('Шепнуть', async () => {
          const res = await cmd('whisper', { target: { type: 'player', id }, from: whFrom.value, text: whText.value });
          if (res.ok) whText.value = '';
        }, 'small'),
      ),
    );

    // Модерация
    const renameInp = h('input', { maxlength: '20', placeholder: 'Паспортный стол: новое имя', 'aria-label': 'Новое имя' });
    const muteMin = num(30, { min: 1, max: 10080, 'aria-label': 'Минут заглушки' });
    const banMin = num(0, { min: 0, 'aria-label': 'Минут бана (0 — навсегда)' });
    const banReason = h('input', { placeholder: 'Причина (для бана и смены имени — жилец увидит)', maxlength: '200', 'aria-label': 'Причина' });
    const banIp = h('input', { type: 'checkbox' });
    const modSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Модерация' }),
      h('div', { class: 'row' }, 'Заглушить на', muteMin, 'мин', button('Заглушить', () => cmd('mute', { id, minutes: muteMin.value }), 'small'), button('Снять', () => cmd('unmute', { id }, 'Заглушка снята'), 'small')),
      h('div', { class: 'row' }, banReason),
      h(
        'div',
        { class: 'row' },
        'Бан, мин (0 — навсегда)',
        banMin,
        h('label', { class: 'check' }, banIp, 'и адрес'),
      ),
      h(
        'div',
        { class: 'row' },
        button('Забанить', () => confirm(`Забанить ${p.name}? Его выкинет из игры.`) && cmd('ban', { id, minutes: banMin.value, reason: banReason.value, ip: banIp.checked }), 'small danger'),
        button('Разбанить', () => cmd('unban', { id }), 'small'),
      ),
      p.alive
        ? h(
            'div',
            { class: 'row' },
            renameInp,
            button('Сменить имя', async () => {
              if (!renameInp.value.trim()) return toast('Впишите новое имя', 'error');
              const res = await cmd('rename', { id, name: renameInp.value, reason: banReason.value });
              if (res.ok) renameInp.value = '';
            }, 'small'),
          )
        : null,
    );

    // Смерть
    const cause = h('input', { placeholder: 'Причина смерти', maxlength: '120', 'aria-label': 'Причина смерти' });
    const deathSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Жизнь и смерть' }),
      h('div', { class: 'row' }, cause, button('Убить', () => confirm(`Убить ${p.name}?`) && cmd('kill', { id, cause: cause.value }), 'small danger')),
    );

    box.replaceChildren(header, dyn, statsSection, invSection, condSection, accSection, tpSection, whSection, modSection, deathSection);
  }

  function fillCard(p) {
    if (!A.card) return;
    A.card.title.textContent = p.name;
    A.card.meta.textContent = `кв. ${p.apartment.number} · ${p.online ? 'в сети' : 'не в сети'} · смен отработано: ${p.shifts} · ${p.account ? `паспорт «${p.account}»` : 'без паспорта'}${p.newbie ? ' · новосёл' : ''}${p.mutedMin ? ` · заглушён ещё ${p.mutedMin} мин` : ''}${p.banned ? ' · ЗАБАНЕН' : ''}`;
    A.card.meta.textContent += p.ranks ? ` · разряды: ${Object.values(p.ranks).join('/')}` : '';
    A.card.harm.textContent = p.harmsHour ? `Бед от ЖЭК за час: ${p.harmsHour}${p.harmsHour >= 3 ? ' — не слишком ли часто одному?' : ''}` : '';
    A.card.harm.className = `card-meta${p.harmsHour >= 3 ? ' harm-warn' : ''}`;
    A.card.dyn.replaceChildren(
      h('p', { class: 'card-meta', text: `Где: ${whereText(p)}` }),
      ...(p.alive
        ? [h(
            'div',
            null,
            STATS.map(([k, label]) =>
              h(
                'div',
                { class: `stat${p.stats[k] <= 20 ? ' low' : ''}` },
                h('div', { class: 'stat-head' }, h('span', { text: label }), h('b', { text: p.stats[k] })),
                h('div', { class: `bar ${k}` }, h('i', { style: `width:${p.stats[k]}%` })),
              ),
            ),
            h('p', { class: 'card-meta', text: `Талоны: ${p.money}` }),
          )]
        : []),
    );
    if (A.card.inv) {
      const entries = Object.entries(p.inventory);
      A.card.inv.replaceChildren(
        ...(entries.length
          ? entries.map(([item, n]) =>
              h('span', { class: 'tag' }, `${A.content.items[item]?.name || item} ×${n}`, h('button', { title: 'Отнять одну', text: '✕', onclick: () => cmd('give', { id: p.id, item, count: -1, silent: true }) })),
            )
          : [h('span', { class: 'empty', text: 'пусто' })]),
      );
    }
    if (A.card.conds) {
      A.card.conds.replaceChildren(
        ...(p.conditions.length
          ? p.conditions.map((c) =>
              h('span', { class: 'tag' }, `${c.name}${c.remainingSec != null ? ` · ${fmtSec(c.remainingSec)}` : ''}`, h('button', { title: 'Вылечить', text: '✕', onclick: () => cmd('cure', { id: p.id, condition: c.id }) })),
            )
          : [h('span', { class: 'empty', text: 'здоров' })]),
      );
    }
  }

  // ---- журнал ----
  function logItem(e) {
    return h('li', { class: e.kind }, h('span', { class: 'clock-s', text: `${new Date(e.ts).toLocaleTimeString('ru-RU')} · ${e.clock}` }), e.text);
  }

  function renderLog() {
    const f = $('#log-filter').value;
    $('#log').replaceChildren(...A.log.filter((e) => !f || e.kind === f).reverse().map(logItem));
  }

  function appendLog(e) {
    const f = $('#log-filter').value;
    if (f && e.kind !== f) return;
    const list = $('#log');
    list.prepend(logItem(e));
    while (list.children.length > 500) list.lastChild.remove();
  }

  // ---- чаты ----
  function chatItem(m) {
    if (m.channel === 'note') {
      return h(
        'li',
        { class: 'note-feed' },
        h('span', { class: 'where', text: `[под дверь кв. ${m.to}]` }),
        h('span', { class: 'from', text: `${m.from.name} (${m.from.apt})${m.anon ? ' — анонимно' : ''}: ` }),
        m.parcel ? `передачка: ${m.parcel}${m.text ? `. «${m.text}»` : ''}` : `«${m.text}»`,
      );
    }
    if (m.channel === 'board') {
      return h(
        'li',
        { class: 'note-feed' },
        h('span', { class: 'where', text: `[доска ${m.floor} эт.]` }),
        h('span', { class: 'from', text: `${m.from.name} (${m.from.apt}): ` }),
        `«${m.text}» `,
        h('button', { class: 'btn small', type: 'button', text: 'Снять', onclick: () => cmd('unpin', { id: m.noteId }) }),
      );
    }
    const where = m.channel === 'global' ? 'ДОМ' : m.where || m.key || 'рядом';
    const fromPlayer = m.from && m.from.id && !m.hallucination;
    return h(
      'li',
      { class: m.from?.system ? 'sys' : '' },
      h('span', { class: 'where', text: `[${where}]` }),
      h('span', { class: 'from', text: `${m.from?.name || '?'}${m.from?.apt ? ` (${m.from.apt})` : ''}: ` }),
      m.text,
      m.hallucination ? h('span', { class: 'ghost-tag', text: ` — галлюцинация для ${nameOf(m.to)}` }) : null,
      fromPlayer
        ? h(
            'span',
            { class: 'mod-tools' },
            button('Удалить', () => cmd('deleteMessage', { id: m.id }), 'small'),
            button('Заглушить 30 мин', () => cmd('mute', { id: m.from.id, minutes: 30 }), 'small'),
          )
        : null,
    );
  }

  function nameOf(id) {
    return A.snap?.players.find((p) => p.id === id)?.name || id;
  }

  function renderChat() {
    const log = $('#admin-chat');
    log.replaceChildren(...A.chat.map(chatItem));
    log.scrollTop = log.scrollHeight;
  }

  function appendChat(m) {
    const log = $('#admin-chat');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(chatItem(m));
    while (log.children.length > 300) log.firstChild.remove();
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Режиссёр: подсказки «куда смотреть» и шкала напряжения
  // ---------------------------------------------------------------------------
  A.hiddenHints = (() => {
    try { return JSON.parse(session.get('gh_hidden_hints') || '{}'); } catch { return {}; }
  })();

  function sceneOfPlayer(id) {
    return A.snap?.players.find((p) => p.id === id)?.scene || null;
  }

  function openPlayer(id) {
    switchTab('players');
    selectPlayer(id);
  }

  function renderDirector() {
    const d = A.snap.director;
    if (!d) return;
    const bar = $('#tension-bar');
    bar.style.width = `${d.tension}%`;
    bar.className = d.tension >= 70 ? 'hot' : d.tension >= 35 ? 'warm' : '';
    $('#tension-val').textContent = d.tension;
    const now = Date.now();
    for (const [id, until] of Object.entries(A.hiddenHints)) if (until < now) delete A.hiddenHints[id];
    const hints = d.hints.filter((x) => !A.hiddenHints[x.id]);
    memo('director', hints.map((x) => [x.id, x.text]), () => {
      $('#director-hints').replaceChildren(
        ...(hints.length
          ? hints.map((x) => {
              const scene = x.scene || (x.playerId ? sceneOfPlayer(x.playerId) : null);
              return h(
                'li',
                { class: `hint-${x.level}` },
                h('span', { class: 'txt', text: x.text }),
                x.playerId ? button('Жилец', () => openPlayer(x.playerId), 'small') : null,
                scene ? button('Глазок', () => watchScene(scene), 'small') : null,
                button('Скрыть', () => {
                  A.hiddenHints[x.id] = Date.now() + 10 * 60000;
                  session.set('gh_hidden_hints', JSON.stringify(A.hiddenHints));
                  A.memo.director = null;
                  renderDirector();
                }, 'small ghost'),
              );
            })
          : [h('li', { class: 'calm', text: 'Режиссёру нечего подсказать.' })]),
      );
    });
  }

  function renderRadio() {
    const r = A.snap.world.radio;
    if (!A.radioInfo || !r) return;
    memo('radio', [r.queue.map((q) => q.id), r.silenceSec > 0, (r.log || []).map((l) => l.ts)], () => {
      A.radioInfo.replaceChildren(
        r.silenceSec > 0 ? h('p', { class: 'note bad', text: 'В эфире тишина.' }) : null,
        r.queue.length
          ? h('ul', { class: 'hazard-list' }, r.queue.map((q) => h('li', null, h('span', { class: 'txt', text: `В очереди: ${q.text}` }), button('✕', () => cmd('radioRemove', { id: q.id }), 'small'))))
          : null,
        (r.log || []).length ? h('ul', { class: 'hazard-list' }, r.log.slice(-4).map((l) => h('li', { class: 'fenced' }, h('span', { class: 'txt' }, h('small', { text: `${l.clock} ` }), l.text)))) : null,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Опасности на клетках
  // ---------------------------------------------------------------------------
  function hazardRow(hz) {
    return h(
      'li',
      { class: hz.fenced ? 'fenced' : '' },
      h('span', { class: 'txt' }, h('b', { text: hz.name }), ` — ${hz.title}`, hz.fenced ? h('small', { text: ` · огорожено${hz.fencedBy ? ` (${hz.fencedBy})` : ''}` }) : null, hz.until ? h('small', { text: ' · временно' }) : null),
      button('Глазок', () => watchScene(hz.scene), 'small'),
      button('Убрать', () => cmd('hazardClear', { scene: hz.scene, id: hz.id }), 'small'),
    );
  }

  function renderHazards() {
    const list = A.snap.hazards || [];
    memo('hazards', list.map((x) => [x.id, x.fenced]), () => {
      const rows = list.length ? list.map(hazardRow) : [h('li', { class: 'calm', text: 'Опасностей нет.' })];
      if (A.hazardList) A.hazardList.replaceChildren(...rows);
      $('#eye-hazards').replaceChildren(...(list.length ? list.map(hazardRow) : [h('li', { class: 'calm', text: 'Опасностей нет.' })]));
    });
  }

  // ---------------------------------------------------------------------------
  // Глазок ЖЭК: любое помещение глазами жильцов
  // ---------------------------------------------------------------------------
  const E = { key: null, scene: null, renderer: null, map: null, actors: new Map(), hover: null, last: 0 };
  const EXTRA_PLACES = { lift: 'Лифт', stairs: 'Лестница' };

  function sceneTitle(key) {
    const [kind, arg] = String(key).split(':');
    if (kind === 'corridor') return `Коридор ${arg} этажа`;
    if (kind === 'home') return `Кв. ${arg}`;
    return A.content.places[kind] || EXTRA_PLACES[kind] || kind;
  }

  function sceneFloor(key) {
    const [kind, arg] = String(key).split(':');
    if (kind === 'corridor') return Number(arg);
    if (kind === 'home') return Math.floor(Number(arg) / 100);
    return A.content.facilities?.[kind]?.floor ?? -1;
  }

  function initEye() {
    E.renderer = new Renderer($('#eye-view'), { fitAll: true });
    new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      E.renderer.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
    }).observe($('#eye-stage'));
    E.map = World.create(A.content.world);
    $('#eye-arg').value = String(A.content.building.firstResidentialFloor);
    $('#eye-place').addEventListener('change', () => {
      const pl = $('#eye-place').value;
      $('#eye-arg').disabled = pl !== 'corridor' && pl !== 'home';
      $('#eye-arg').placeholder = pl === 'home' ? '10101' : String(A.content.building.firstResidentialFloor);
    });
    $('#eye-go').addEventListener('submit', (e) => {
      e.preventDefault();
      const place = $('#eye-place').value;
      const arg = $('#eye-arg').value.trim();
      if ((place === 'corridor' || place === 'home') && !/^\d+$/.test(arg)) {
        toast(place === 'home' ? 'Укажите номер квартиры' : 'Укажите этаж', 'error');
        return;
      }
      watchScene(place === 'corridor' || place === 'home' ? `${place}:${arg}` : place);
    });
    const canvas = $('#eye-view');
    canvas.addEventListener('click', onEyeClick);
    canvas.addEventListener('mousemove', (e) => {
      const pt = E.renderer.toWorld(e.offsetX, e.offsetY);
      E.hover = { x: Math.floor(pt.x), y: Math.floor(pt.y) };
    });
    canvas.addEventListener('mouseleave', () => (E.hover = null));
    $('#eye-clear').addEventListener('click', () => E.key && cmd('hazardClear', { scene: E.key }));
    $('#eye-scars').addEventListener('click', () => E.key && cmd('scarsClear', { scene: E.key }));
    fillEyeTools();
    requestAnimationFrame(eyeFrame);
  }

  function fillEyeTools() {
    const sel = $('#eye-tool');
    const keep = sel.value;
    sel.replaceChildren(h('option', { value: '', text: 'ничего не ставит' }), ...Object.entries(A.content.hazards).map(([k, n]) => h('option', { value: k, text: `ставит: ${n}` })));
    sel.value = A.content.hazards[keep] ? keep : '';
  }

  function watchScene(key) {
    let scene;
    try {
      scene = E.map.scene(key);
    } catch {
      toast('Нет такого помещения', 'error');
      return;
    }
    E.key = key;
    E.scene = null;
    E.actors.clear();
    E.renderer.setScene(scene);
    $('#eye-title').textContent = sceneTitle(key);
    $('#eye-meta').textContent = 'подключаемся…';
    A.memo.eyeSide = null;
    switchTab('eye');
    renderEyeSide();
  }

  function onWatch(snap) {
    if (!snap) {
      $('#eye-meta').textContent = 'такого помещения нет';
      E.scene = null;
      return;
    }
    if (snap.key !== E.key) return;
    E.scene = snap;
    const seen = new Set();
    for (const a of snap.actors) {
      seen.add(a.id);
      const cur = E.actors.get(a.id);
      if (cur) Object.assign(cur, { ...a, x: cur.x, y: cur.y, tx: a.x, ty: a.y });
      else E.actors.set(a.id, { ...a, tx: a.x, ty: a.y, look: lookFor(a.id), phase: Math.random() * 6 });
    }
    for (const id of [...E.actors.keys()]) if (!seen.has(id)) E.actors.delete(id);
    const bits = [`жильцов: ${snap.actors.length}`];
    if (snap.dark) bits.push('темно');
    if (snap.lampsOut.length) bits.push(`погасло ламп: ${snap.lampsOut.length}`);
    if (snap.fog) bits.push(snap.fog === 'window' ? 'туман за окном' : 'туман!');
    if (snap.sealed) bits.push('гермодверь задраена');
    if (snap.hazards.length) bits.push(`опасностей: ${snap.hazards.length}`);
    if ((snap.scars || []).length) bits.push(`следов: ${snap.scars.length}`);
    $('#eye-meta').textContent = bits.join(' · ');
  }

  function eyeFrame(ts) {
    requestAnimationFrame(eyeFrame);
    if ($('#tab-eye').hidden || !E.renderer.scene) return;
    const dt = Math.min(0.1, (ts - (E.last || ts)) / 1000);
    E.last = ts;
    for (const a of E.actors.values()) {
      const k = Math.min(1, dt * 10);
      a.x += (a.tx - a.x) * k;
      a.y += (a.ty - a.y) * k;
    }
    const sc = E.scene;
    const minutes = sc ? sc.gameMinutes : 12 * 60;
    const hour = Math.floor(minutes / 60);
    try {
      E.renderer.draw({
        you: null,
        actors: [...E.actors.values()],
        time: ts / 1000,
        now: Date.now(),
        god: true,
        gameMinutes: minutes,
        dark: !!(sc && sc.dark),
        night: hour >= 22 || hour < 6,
        lampsOut: sc ? sc.lampsOut : [],
        hazards: sc ? sc.hazards : [],
        scars: sc ? sc.scars || [] : [],
        fog: sc ? sc.fog : null,
        fogOutside: !!(sc && sc.fog),
        liftBroken: !!(sc && sc.liftBroken),
        sealed: !!(sc && sc.sealed),
        residents: sc ? sc.residents : {},
        hover: null,
      });
      if (E.hover && $('#eye-tool').value) {
        // рамка клетки, куда встанет опасность
        const r = E.renderer;
        const g = r.ctx;
        const TD = r.T * r.dpr;
        g.strokeStyle = 'rgba(224,90,79,0.9)';
        g.lineWidth = Math.max(1, 2 * r.dpr);
        g.strokeRect(E.hover.x * TD - r.cam.x, E.hover.y * TD - r.cam.y, TD, TD);
      }
    } catch (err) {
      console.error(err);
    }
  }

  function onEyeClick(e) {
    if (!E.key) return;
    const pt = E.renderer.toWorld(e.offsetX, e.offsetY);
    // жилец под курсором — открыть его карточку
    let best = null;
    let bd = 0.6;
    for (const a of E.actors.values()) {
      const d = Math.hypot(a.x - pt.x, a.y - 0.4 - pt.y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    if (best) {
      openPlayer(best.id);
      return;
    }
    const kind = $('#eye-tool').value;
    if (kind) {
      cmd('hazard', { scene: E.key, kind, x: pt.x, y: pt.y, minutes: $('#eye-minutes').value });
      return;
    }
    const hz = (E.scene?.hazards || []).find((z) => Math.hypot(z.x - pt.x, z.y - pt.y) < 0.6);
    if (hz && confirm(`Убрать опасность «${A.content.hazards[hz.kind]}»?`)) cmd('hazardClear', { scene: E.key, id: hz.id });
  }

  /** «Дом в разрезе»: где сейчас кто, этажи сверху вниз. */
  function renderEyeSide() {
    const groups = new Map();
    const add = (k) => groups.get(k) || groups.set(k, []).get(k);
    for (const p of alivePlayers()) if (p.scene) add(p.scene).push(p);
    for (const hz of A.snap.hazards || []) add(hz.scene);
    for (const f of ['canteen', 'medpost', 'factory']) add(f);
    if (E.key) add(E.key);
    const hzCount = {};
    for (const hz of A.snap.hazards || []) hzCount[hz.scene] = (hzCount[hz.scene] || 0) + 1;
    const keys = [...groups.keys()].sort((a, b) => sceneFloor(b) - sceneFloor(a) || a.localeCompare(b));
    const data = keys.map((k) => [k, groups.get(k).map((p) => [p.id, p.name, p.online, !!p.down]), hzCount[k] || 0]);
    memo('eyeSide', [data, E.key], () => {
      $('#eye-scenes').replaceChildren(
        ...keys.map((k) => {
          const ps = groups.get(k);
          const online = ps.filter((p) => p.online).length;
          return h(
            'li',
            { class: k === E.key ? 'active' : '' },
            h(
              'button',
              { type: 'button', onclick: () => watchScene(k) },
              h('span', { class: 'sc-title', text: sceneTitle(k) }),
              h('span', { class: 'sc-count', text: ps.length ? `${online}/${ps.length}` : '' }),
              hzCount[k] ? h('span', { class: 'sc-hz', title: 'Опасности', text: `⚠${hzCount[k]}` }) : null,
              ps.length ? h('span', { class: 'sc-names', text: ps.map((p) => `${p.down ? '✚' : ''}${p.name}`).join(', ') }) : null,
            ),
          );
        }),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Палитра бед: свои болезни, несчастные случаи и предметы
  // ---------------------------------------------------------------------------
  const STAT_NAMES = { health: 'Здоровье', hunger: 'Сытость', energy: 'Силы', sanity: 'Рассудок' };

  function statInputs(lo, hi) {
    const inputs = Object.fromEntries(Object.keys(STAT_NAMES).map((k) => [k, num(0, { min: lo, max: hi })]));
    return {
      el: h('div', { class: 'grid4' }, Object.entries(inputs).map(([k, inp]) => field(STAT_NAMES[k], inp))),
      get: () => Object.fromEntries(Object.entries(inputs).map(([k, inp]) => [k, Number(inp.value) || 0]).filter(([, v]) => v)),
      reset: () => Object.values(inputs).forEach((inp) => (inp.value = '0')),
    };
  }

  function buildPalette() {
    const grid = $('#palette-grid');
    grid.replaceChildren();

    // болезнь или травма
    const cName = h('input', { maxlength: '40', placeholder: 'Лифтовая икота' });
    const cKind = select([['disease', 'Болезнь'], ['injury', 'Травма']], 'disease');
    const cDur = num(30, { min: 0, max: 600 });
    const cCont = num(0, { min: 0, max: 1, step: 0.05 });
    const cStats = statInputs(-20, 20);
    const cWork = h('input', { type: 'checkbox' });
    const cStairs = h('input', { type: 'checkbox' });
    const cSymptom = h('input', { maxlength: '40', placeholder: 'икает' });
    grid.append(
      card(
        'Своя болезнь или травма',
        'Изменения в минуту. Заразность — шанс в минуту передаться соседу рядом (0–1). 0 минут — пока не вылечат.',
        'danger-card',
        h('div', { class: 'grid2' }, field('Название', cName), field('Вид', cKind)),
        h('div', { class: 'grid3' }, field('Длится, мин', cDur), field('Заразность', cCont), field('Симптом (в чате)', cSymptom)),
        h('p', { class: 'sub-h', text: 'В минуту:' }),
        cStats.el,
        h('div', { class: 'row' }, h('label', { class: 'check' }, cWork, 'не может работать'), h('label', { class: 'check' }, cStairs, 'не может по лестнице')),
        actions(
          button('Добавить в палитру', async () => {
            const res = await cmd('paletteAdd', {
              type: 'conditions',
              def: { name: cName.value, kind: cKind.value, durationMin: cDur.value, contagious: cCont.value, perMin: cStats.get(), blocks: [cWork.checked && 'work', cStairs.checked && 'stairs'].filter(Boolean), symptom: cSymptom.value },
            });
            if (res.ok) {
              cName.value = '';
              cSymptom.value = '';
              cStats.reset();
            }
          }, 'primary'),
        ),
      ),
    );

    // несчастный случай
    const aName = h('input', { maxlength: '40', placeholder: 'Упала люстра' });
    const aText = h('textarea', { maxlength: '300', placeholder: 'С потолка с грохотом рушится люстра…' });
    const aStats = statInputs(-200, 200);
    const aCond = h('select', { 'aria-label': 'Состояние после' });
    const aKill = h('input', { type: 'checkbox' });
    A.paletteCondSelects = [aCond];
    grid.append(
      card(
        'Свой несчастный случай',
        'Появится в списках «Несчастный случай» и в карточке жильца.',
        'danger-card',
        field('Название', aName),
        field('Что увидит жилец', aText),
        h('p', { class: 'sub-h', text: 'Сразу:' }),
        aStats.el,
        h('div', { class: 'grid2' }, field('Состояние после', aCond), h('label', { class: 'check' }, aKill, 'смертельно')),
        actions(
          button('Добавить в палитру', async () => {
            const res = await cmd('paletteAdd', { type: 'accidents', def: { name: aName.value, text: aText.value, effect: aStats.get(), condition: aCond.value || undefined, kill: aKill.checked } });
            if (res.ok) {
              aName.value = '';
              aText.value = '';
              aKill.checked = false;
              aStats.reset();
            }
          }, 'primary'),
        ),
      ),
    );

    // предмет
    const iName = h('input', { maxlength: '40', placeholder: 'Настойка боярышника' });
    const iDesc = h('input', { maxlength: '120', placeholder: 'Горькая. Помогает от всего.' });
    const iStats = statInputs(-100, 100);
    const iCure = h('select', { multiple: true, size: '4', 'aria-label': 'Лечит' });
    A.paletteCondSelects.push(iCure);
    grid.append(
      card(
        'Свой предмет',
        'Без эффекта — просто вещь (на обмен, в передачку). С эффектом — его можно употребить. Выдаётся через гуманитарку или карточку жильца.',
        'good-card',
        h('div', { class: 'grid2' }, field('Название', iName), field('Описание', iDesc)),
        h('p', { class: 'sub-h', text: 'Если употребить:' }),
        iStats.el,
        field('Лечит (Ctrl — несколько)', iCure),
        actions(
          button('Добавить в палитру', async () => {
            const res = await cmd('paletteAdd', { type: 'items', def: { name: iName.value, desc: iDesc.value, use: iStats.get(), cure: [...iCure.selectedOptions].map((o) => o.value) } });
            if (res.ok) {
              iName.value = '';
              iDesc.value = '';
              iStats.reset();
            }
          }, 'primary'),
        ),
      ),
    );

    A.paletteList = h('ul', { class: 'palette-list' });
    grid.append(card('Что уже в палитре', 'Удалённое исчезнет из списков. У кого уже есть такая болезнь или предмет — пропадёт.', '', A.paletteList));
    renderPalette();
  }

  function renderPalette() {
    if (!A.paletteList) return;
    const C = A.content;
    for (const sel of A.paletteCondSelects || []) {
      const keep = [...sel.selectedOptions].map((o) => o.value);
      sel.replaceChildren(...(sel.multiple ? [] : [h('option', { value: '', text: '— нет —' })]), ...Object.entries(C.conditions).map(([k, v]) => h('option', { value: k, text: v.name })));
      for (const o of sel.options) o.selected = keep.includes(o.value);
    }
    const TYPES = { conditions: 'Болезнь/травма', accidents: 'Случай', items: 'Предмет' };
    const rows = [];
    for (const [type, label] of Object.entries(TYPES)) {
      for (const [id, def] of Object.entries((C.palette || {})[type] || {})) {
        rows.push(
          h(
            'li',
            null,
            h('span', { class: 'tag', text: label }),
            h('b', { text: def.name }),
            h('small', { text: ` ${id}` }),
            button('Удалить', () => confirm(`Удалить «${def.name}» из палитры?`) && cmd('paletteRemove', { type, id }), 'small'),
          ),
        );
      }
    }
    A.paletteList.replaceChildren(...(rows.length ? rows : [h('li', { class: 'calm', text: 'Палитра пуста — пока только стандартные беды.' })]));
  }

  connect();
})();
