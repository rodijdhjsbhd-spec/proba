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
        $('#login').hidden = true;
        $('#app').hidden = false;
        if (!A.built) build();
        renderLog();
        renderChat();
        renderSnapshot();
        break;
      case 'snapshot':
        A.snap = msg.snapshot;
        renderSnapshot();
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
    for (const tab of document.querySelectorAll('.admin-tabs .tab')) {
      tab.addEventListener('click', () => {
        for (const t of document.querySelectorAll('.admin-tabs .tab')) t.classList.toggle('active', t === tab);
        for (const page of document.querySelectorAll('.tab-page')) page.hidden = page.id !== `tab-${tab.dataset.tab}`;
      });
    }
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

    // --- Объявление ---
    const annTitle = h('input', { value: 'Объявление ЖЭК', maxlength: '80' });
    const annText = h('textarea', { maxlength: '500', placeholder: 'Уважаемые жильцы! В связи с…' });
    grid.append(card('Объявление по радиоточке', 'Всплывает у всех живых жильцов и попадает в общий чат.', '', field('Заголовок', annTitle), field('Текст', annText), actions(button('Объявить', () => cmd('announce', { title: annTitle.value, text: annText.value }), 'primary'))));

    // --- Шёпот ---
    const whTarget = targetPicker('player');
    const whFrom = h('input', { value: 'Голос за стеной', maxlength: '60' });
    const whText = h('textarea', { maxlength: '500', placeholder: 'Не открывай дверь…' });
    grid.append(
      card('Шёпот', 'Жуткое личное сообщение. Видит только адресат.', 'whisper-card', whTarget.el, field('От кого', whFrom), field('Текст', whText), actions(button('Шепнуть', () => cmd('whisper', { target: whTarget.get(), from: whFrom.value, text: whText.value }), 'primary'))),
    );

    // --- Произвольное событие ---
    grid.append(buildCustomEvent());
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

    const run = () => {
      const effect = Object.fromEntries(Object.entries(deltas).map(([k, input]) => [k, Number(input.value) || 0]));
      if (item.value) effect.items = { [item.value]: Number(itemCount.value) || 0 };
      if (condition.value) effect.condition = condition.value;
      if (cure.checked) effect.cure = true;
      if (kill.checked) effect.kill = true;
      if (kill.checked && !confirm('Событие убьёт всех, кого коснётся. Точно?')) return;
      cmd('custom', { target: target.get(), title: title.value, text: text.value, style: style.value, effect });
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
    renderPlayers();
    renderCard();
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
    const header = h('div', null, (A.card.title = h('h2')), (A.card.meta = h('div', { class: 'card-meta' })));
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

    // Смерть
    const cause = h('input', { placeholder: 'Причина смерти', maxlength: '120', 'aria-label': 'Причина смерти' });
    const deathSection = h(
      'div',
      { class: 'card-section' },
      h('h3', { text: 'Жизнь и смерть' }),
      h('div', { class: 'row' }, cause, button('Убить', () => confirm(`Убить ${p.name}?`) && cmd('kill', { id, cause: cause.value }), 'small danger')),
    );

    box.replaceChildren(header, dyn, statsSection, invSection, condSection, accSection, tpSection, whSection, deathSection);
  }

  function fillCard(p) {
    if (!A.card) return;
    A.card.title.textContent = p.name;
    A.card.meta.textContent = `кв. ${p.apartment.number} · ${p.online ? 'в сети' : 'не в сети'} · смен отработано: ${p.shifts}`;
    A.card.dyn.replaceChildren(
      h('p', { class: 'card-meta', text: `Где: ${whereText(p)}` }),
      p.alive
        ? h(
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
          )
        : null,
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
    const where = m.channel === 'global' ? 'ДОМ' : m.where || m.key || 'рядом';
    return h(
      'li',
      { class: m.from?.system ? 'sys' : '' },
      h('span', { class: 'where', text: `[${where}]` }),
      h('span', { class: 'from', text: `${m.from?.name || '?'}${m.from?.apt ? ` (${m.from.apt})` : ''}: ` }),
      m.text,
      m.hallucination ? h('span', { class: 'ghost-tag', text: ` — галлюцинация для ${nameOf(m.to)}` }) : null,
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

  connect();
})();
