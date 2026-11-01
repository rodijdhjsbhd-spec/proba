'use strict';

/*
 * Боты-нагрузчики: сколько жильцов выдержит дом на этой машине.
 *
 *   node scripts/loadtest.js [--bots 200] [--seconds 60] [--out 0.6] [--chat 40] [--idle 1] [--crowd 1] [--profile папка]
 *
 * Скрипт создаёт временный мир с N жильцами (обычное заселение, только без паспортов — иначе упрёмся
 * в лимит проверок пароля), запускает настоящий сервер на свободном порту и подключает ботов по их
 * ордерам. Боты ведут себя как браузер: шлют позицию 10 раз в секунду, ходят по комнате, выходят в
 * коридор (доля --out), ездят на лифте на соседние этажи, раз в --chat секунд что-нибудь говорят.
 * Каждые 5 секунд печатается /healthz сервера: время тика и рассылки позиций, сохранение, задержка
 * цикла событий, процессор, память — и сколько данных уходит ботам.
 * --idle 1 — боты только подключены и стоят (как жилец, отошедший от экрана).
 * --crowd 1 — все идут в столовую и толкутся там: проверка толпы в одном помещении.
 * --profile — снять профиль процессора сервера (.cpuprofile, открывается в Chrome DevTools).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');
const World = require('../public/shared/world');
const ViewPatch = require('../public/shared/viewpatch');
const storage = require('../server/storage');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BOTS = Number(args.bots) || 200;
const SECONDS = Number(args.seconds) || 60;
const OUT = args.out != null ? Number(args.out) : 0.6;
const CHAT_SEC = Number(args.chat) || 40;
const IDLE = args.idle === '1';
const CROWD = args.crowd === '1';
const { FACILITIES } = require('../server/content');

const SYL = ['ба', 'ве', 'го', 'ду', 'жа', 'зо', 'ки', 'ло', 'ма', 'ну', 'по', 'ре', 'са', 'ту', 'фе', 'ха'];
/** Уникальное имя без цифр (имена жильцов — только буквы). */
const botName = (i) => `Бот ${[...String(i.toString(16))].map((c) => SYL[parseInt(c, 16)]).join('')}`;
const PHRASES = ['Кто брал мою ложку?', 'Лифт опять гудит.', 'Есть хлеб на обмен?', 'Сирену слышали?', 'Смену отработал.', 'Свет мигает на этаже.'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/** Мир с N жильцами: заселение через обычный Game.register. */
function seedWorld(file, n) {
  const { Game } = require('../server/game');
  const game = new Game(null);
  const tokens = [];
  for (let i = 0; i < n; i++) {
    const res = game.register(botName(i + 1));
    if (!res.ok) throw new Error(`не заселить бота ${i + 1}: ${res.error}`);
    tokens.push(res.token);
  }
  storage.save(file, game.state);
  return tokens;
}

const traffic = { bytes: 0, msgs: 0 };
const errors = new Map();
const countError = (e) => errors.set(e, (errors.get(e) || 0) + 1);

/** Один бот: ордер → подключение → ходит, ездит, болтает. */
function startBot(port, token, i) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const bot = { ws, map: null, view: null, key: null, posSeq: null, me: null, path: null, waitUntil: 0, pending: false, nextChat: Date.now() + Math.random() * CHAT_SEC * 1000 };
  let reqId = 0;
  const act = (action, a = {}) => {
    bot.pending = true;
    ws.send(JSON.stringify({ t: 'act', id: ++reqId, action, args: a }));
  };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })));
  ws.on('message', (raw) => {
    traffic.bytes += raw.length;
    traffic.msgs++;
    const m = JSON.parse(raw);
    if (m.t === 'welcome') bot.map = World.create(m.world);
    else if (m.t === 'view' || m.t === 'vpatch') {
      if (m.t === 'vpatch' && !bot.view) return;
      bot.view = m.t === 'view' ? m.view : ViewPatch.apply(bot.view, m);
      const v = bot.view;
      if (v.here.key !== bot.key || v.you.posSeq !== bot.posSeq) {
        bot.key = v.here.key;
        bot.posSeq = v.you.posSeq;
        bot.me = { x: v.you.pos.x, y: v.you.pos.y };
        bot.path = null;
      }
    } else if (m.t === 'pos_fix') {
      bot.me = { x: m.x, y: m.y };
      bot.path = null;
    } else if (m.t === 'res') {
      bot.pending = false;
      if (!m.ok) countError(m.error);
    }
  });
  ws.on('error', (e) => countError(`сокет: ${e.message}`));

  const walkTo = (spot) => {
    const scene = bot.map.scene(bot.key);
    const p = World.findPath(scene, bot.me, spot);
    bot.path = p && p.length ? p : null;
  };
  const randomFloorSpot = (scene) => {
    for (let k = 0; k < 30; k++) {
      const x = 1 + Math.random() * (scene.w - 2);
      const y = 1 + Math.random() * (scene.h - 2);
      if (World.canStand(scene, x, y)) return { x, y };
    }
    return null;
  };
  const near = (o) => o && o.spot && Math.hypot(o.spot.x - bot.me.x, o.spot.y - bot.me.y) < 0.4;
  let goal = null; // { obj, then }

  bot.timer = setInterval(() => {
    if (IDLE || !bot.map || !bot.view || !bot.me || ws.readyState !== ws.OPEN) return;
    const v = bot.view;
    if (!v.you.alive || v.you.travel || v.you.down || bot.pending) return;
    const now = Date.now();
    // шаг по пути, как браузер: 10 раз в секунду
    if (bot.path) {
      let left = World.SPEED * 0.85 * 0.1;
      while (left > 0 && bot.path.length) {
        const t = bot.path[0];
        const d = Math.hypot(t.x - bot.me.x, t.y - bot.me.y);
        if (d <= left) {
          bot.me = { x: t.x, y: t.y };
          bot.path.shift();
          left -= d;
        } else {
          bot.me = { x: bot.me.x + ((t.x - bot.me.x) / d) * left, y: bot.me.y + ((t.y - bot.me.y) / d) * left };
          left = 0;
        }
      }
      ws.send(JSON.stringify({ t: 'pos', x: Math.round(bot.me.x * 100) / 100, y: Math.round(bot.me.y * 100) / 100, d: 'down' }));
      if (!bot.path.length) bot.path = null;
      return;
    }
    if (goal && near(goal.obj)) {
      const g = goal;
      goal = null;
      g.then();
      return;
    }
    if (now < bot.waitUntil) return;
    if (now > bot.nextChat) {
      bot.nextChat = now + CHAT_SEC * 1000 * (0.5 + Math.random());
      act('chat', { channel: Math.random() < 0.15 ? 'global' : 'local', text: PHRASES[Math.floor(Math.random() * PHRASES.length)] });
      return;
    }
    const scene = bot.map.scene(bot.key);
    const find = (type, extra = () => true) => scene.objects.find((o) => o.type === type && o.spot && extra(o));
    const roll = Math.random();
    if (CROWD && v.here.place !== 'canteen') {
      // все — в столовую: из квартиры в коридор, на лифте на её этаж, в дверь
      const floor = FACILITIES.canteen.floor;
      if (v.here.place === 'home') goal = { obj: find('hermodoor'), then: () => act('move', { place: 'corridor' }) };
      else if (v.here.place === 'corridor' && v.here.floor !== floor) goal = { obj: find('lift'), then: () => act('move', { place: 'corridor', floor, via: 'lift' }) };
      else if (v.here.place === 'corridor') goal = { obj: find('facility', (o) => o.facility === 'canteen'), then: () => act('move', { place: 'canteen' }) };
    } else if (CROWD) {
      // в столовой просто бродим
    } else if (v.here.place === 'home' && i < BOTS * OUT && roll < 0.3) {
      goal = { obj: find('hermodoor'), then: () => act('move', { place: 'corridor' }) };
    } else if (v.here.place === 'corridor' && roll < 0.12) {
      const floor = Math.max(101, v.here.floor + Math.floor(Math.random() * 7) - 3);
      if (floor !== v.here.floor) goal = { obj: find('lift'), then: () => act('move', { place: 'corridor', floor, via: 'lift' }) };
    } else if (v.here.place === 'corridor' && v.here.floor === v.you.apartment.floor && roll < 0.2) {
      goal = { obj: find('apt', (o) => o.number === v.you.apartment.number), then: () => act('move', { place: 'home' }) };
    }
    if (goal && goal.obj) walkTo(goal.obj.spot);
    else {
      goal = null;
      const spot = randomFloorSpot(scene);
      if (spot) walkTo(spot);
    }
    bot.waitUntil = now + 500 + Math.random() * 2500;
  }, 100);
  return bot;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-load-'));
  const file = path.join(dir, 'world.json');
  const t0 = Date.now();
  const tokens = seedWorld(file, BOTS);
  console.log(`Мир с ${BOTS} жильцами создан за ${Date.now() - t0} мс (${Math.round(fs.statSync(file).size / 1024)} КБ).`);
  const port = await freePort();
  const nodeArgs = args.profile ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(args.profile)}`] : [];
  const proc = spawn(process.execPath, [...nodeArgs, path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: file, ADMIN_PASSWORD: 'load-test', REGISTER_LIMIT: '0', PUSH: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[сервер] ${d}`));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('сервер не запустился')), 20000);
    proc.stdout.on('data', (d) => String(d).includes('запущена') && (clearTimeout(t), resolve()));
    proc.on('exit', (code) => reject(new Error(`сервер вышел: ${code}`)));
  });
  const bots = [];
  for (let i = 0; i < tokens.length; i++) {
    bots.push(startBot(port, tokens[i], i));
    if (i % 50 === 49) await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`Подключено ботов: ${bots.length}. Гоняем ${SECONDS} с…\n`);
  console.log('  с   в сети  тик мс (ср/макс)  позиции мс (ср/макс)  задержка цикла p99/макс  ЦП %  память МБ  сохранение мс/КБ  ботам КБ/с');
  const rows = [];
  let lastBytes = 0;
  let lastAt = Date.now();
  const start = Date.now();
  while (Date.now() - start < SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await getJson(`http://127.0.0.1:${port}/healthz`);
    const p = h.perf;
    const kbs = Math.round((traffic.bytes - lastBytes) / 1024 / ((Date.now() - lastAt) / 1000));
    lastBytes = traffic.bytes;
    lastAt = Date.now();
    rows.push({ ...p, kbs, online: h.online });
    const f = (x) => (x ? `${x.avg}/${x.max}` : '—');
    console.log(
      `${String(Math.round((Date.now() - start) / 1000)).padStart(4)}  ${String(h.online).padStart(6)}  ${f(p.tickMs).padStart(16)}  ${f(p.actorsMs).padStart(20)}  ${(p.loopLagMs ? `${p.loopLagMs.p99}/${p.loopLagMs.max}` : '—').padStart(23)}  ${String(p.cpuPct).padStart(4)}  ${String(p.heapMb).padStart(9)}  ${(p.saveMs ? `${p.saveMs.max}/${p.saveKb}` : '—').padStart(16)}  ${String(kbs).padStart(10)}`,
    );
  }
  for (const b of bots) {
    clearInterval(b.timer);
    b.ws.close();
  }
  proc.kill('SIGTERM');
  await new Promise((r) => proc.on('exit', r));
  fs.rmSync(dir, { recursive: true, force: true });
  const steady = rows.slice(Math.min(2, rows.length - 1));
  const avg = (k) => Math.round((steady.reduce((s, r) => s + (r[k] && r[k].avg != null ? r[k].avg : r[k] || 0), 0) / steady.length) * 10) / 10;
  const max = (k, sub = 'max') => Math.max(...steady.map((r) => (r[k] ? r[k][sub] : 0)));
  console.log(`\nИтого (${BOTS} ботов, без первых 10 с): тик в среднем ${avg('tickMs')} мс (худший ${max('tickMs')}), рассылка позиций ${avg('actorsMs')} мс (худшая ${max('actorsMs')}), задержка цикла p99 до ${max('loopLagMs', 'p99')} мс, ЦП ~${avg('cpuPct')}%, ботам ~${avg('kbs')} КБ/с.`);
  if (errors.size) console.log('Отказы сервера ботам (обычные игровые «нельзя»):', Object.fromEntries([...errors].sort((a, b) => b[1] - a[1]).slice(0, 8)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
