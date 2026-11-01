/**
 * Карты мира Гигахрущёвки. Общий модуль: работает и на сервере (require),
 * и в браузере (window.World).
 *
 * Каждая сцена — ASCII-схема. Вид сверху «три четверти»: верхняя стена видна
 * своей лицевой стороной (две строки), на ней висят двери, лифт, доски.
 *
 * Общие обозначения:
 *   #  стена            .  пол           (пробел) — пустота
 * Остальные символы описаны в legend каждой схемы. Одинаковые соседние
 * символы склеиваются в один объект (например, «LL» — лифт шириной 2 клетки).
 *
 * Чтобы перепланировать помещение — просто поправьте схему. Тест
 * test/world.test.js проверит, что все строки одной длины и до каждого
 * объекта можно дойти.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.World = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SPEED = 4; // клеток в секунду
  const RADIUS = 0.28; // «толщина» жильца
  const REACH = 1.5; // с какого расстояния можно взаимодействовать с предметом

  // ---------------------------------------------------------------------------
  // Схемы помещений
  // ---------------------------------------------------------------------------
  const TEMPLATES = {
    // Коридор этажа. Цифры 1–6 — двери квартир (на жилых этажах),
    // «ff» — вход в учреждение (на служебных этажах).
    corridor: {
      rows: [
        '######################################',
        '#LL##1###2##ff##3###4##G#B#5###6##HSS#',
        '#....................................#',
        '#....................................#',
        '#....................................#',
        '#......R..........R..........R.......#',
        '######################################',
      ],
      legend: {
        L: { type: 'lift', label: 'Лифт', wall: true },
        S: { type: 'stairs', label: 'Лестница', wall: true },
        1: { type: 'apt', index: 1, wall: true },
        2: { type: 'apt', index: 2, wall: true },
        3: { type: 'apt', index: 3, wall: true },
        4: { type: 'apt', index: 4, wall: true },
        5: { type: 'apt', index: 5, wall: true },
        6: { type: 'apt', index: 6, wall: true },
        x: { type: 'locked', label: 'Служебная дверь', wall: true },
        F: { type: 'facility', wall: true },
        B: { type: 'board', label: 'Доска объявлений', wall: true },
        G: { type: 'chute', label: 'Мусоропровод', wall: true },
        H: { type: 'hose', label: 'Пожарный кран', wall: true, decor: true },
        R: { type: 'radiator', decor: true },
      },
      lamps: [[4, 3.5], [10, 3.5], [16, 3.5], [22, 3.5], [28, 3.5], [34, 3.5]],
      style: { floor: 'linoleum', wallLow: '#3d6656', wallHigh: '#b9b5a6', ambient: 0.38 },
    },

    home: {
      rows: [
        '############',
        '###w##r##w##',
        '#b.....sk.W#',
        '#b.........#',
        '#..........#',
        '#....tt....#',
        '#..........#',
        '#..........#',
        '#####DD#####',
      ],
      legend: {
        w: { type: 'window', label: 'Окно', wall: true },
        r: { type: 'radio', label: 'Радиоточка', wall: true },
        b: { type: 'bed', label: 'Кровать' },
        s: { type: 'sink', label: 'Раковина', decor: true },
        k: { type: 'stove', label: 'Плитка', decor: true },
        W: { type: 'wardrobe', label: 'Шкаф' },
        t: { type: 'table', label: 'Стол', decor: true },
        D: { type: 'hermodoor', label: 'Гермодверь', wall: true, bottom: true },
      },
      lamps: [[6, 4.5]],
      style: { floor: 'parquet', wallLow: '#6f6554', wallHigh: '#8d846f', wallpaper: true, ambient: 0.32 },
    },

    canteen: {
      rows: [
        '##################',
        '###P####MM###XP#r#',
        '#.CCCCCCCCCC.....#',
        '#................#',
        '#..TT...TT...TT..#',
        '#................#',
        '#..TT...TT...TT..#',
        '#................#',
        '#..TT...TT...TT..#',
        '#................#',
        '########DD########',
      ],
      legend: {
        P: { type: 'poster', label: 'Плакат', wall: true, decor: true },
        M: { type: 'menu', label: 'Меню', wall: true, decor: true },
        X: { type: 'memorial', label: 'Стена памяти', wall: true },
        r: { type: 'radio', label: 'Радиоточка', wall: true },
        C: { type: 'counter', label: 'Раздача', shop: 'canteen' },
        T: { type: 'dtable', label: 'Стол', decor: true },
        D: { type: 'exit', label: 'Выход в коридор', wall: true, bottom: true },
      },
      lamps: [[4, 4.5], [10, 4.5], [15, 4.5], [4, 8], [10, 8], [15, 8]],
      style: { floor: 'tiles', wallLow: '#c3c7bd', wallHigh: '#cfc6a8', tiled: true, ambient: 0.22 },
    },

    medpost: {
      rows: [
        '##############',
        '##P###VV###P##',
        '#............#',
        '#..........cc#',
        '#k.........cc#',
        '#k...........#',
        '#............#',
        '#............#',
        '######DD######',
      ],
      legend: {
        P: { type: 'poster', label: 'Плакат', wall: true, decor: true },
        V: { type: 'window_med', label: 'Окошко фельдшера', wall: true, shop: 'medpost' },
        c: { type: 'couch', label: 'Кушетка', decor: true },
        k: { type: 'cabinet', label: 'Шкаф с лекарствами', decor: true },
        D: { type: 'exit', label: 'Выход в коридор', wall: true, bottom: true },
      },
      lamps: [[4, 4], [10, 5]],
      style: { floor: 'medtiles', wallLow: '#d5dbd7', wallHigh: '#e2e4dc', tiled: true, ambient: 0.16 },
    },

    factory: {
      rows: [
        '######################',
        '##P####JJ#####P####Q##',
        '#....................#',
        '#.==================.#',
        '#....................#',
        '#..11.....22.....33..#',
        '#..11.....22.....33..#',
        '#....................#',
        '#.MM.....MM.....MM...#',
        '#.MM.....MM.....MM...#',
        '#....................#',
        '##########DD##########',
      ],
      legend: {
        P: { type: 'poster', label: 'Плакат', wall: true, decor: true },
        J: { type: 'jobboard', label: 'Доска нарядов', wall: true },
        Q: { type: 'clock', label: 'Часы', wall: true, decor: true },
        '=': { type: 'conveyor', label: 'Конвейер', decor: true },
        1: { type: 'station', game: 'sort', label: 'Сортировочный стол' },
        2: { type: 'station', game: 'meter', label: 'Щит со счётчиками' },
        3: { type: 'station', game: 'gauge', label: 'Котёл с манометром' },
        M: { type: 'machine', label: 'Станок', decor: true },
        D: { type: 'exit', label: 'Выход в коридор', wall: true, bottom: true },
      },
      lamps: [[5, 4], [11, 4], [17, 4], [5, 9], [11, 9], [17, 9]],
      style: { floor: 'concrete', wallLow: '#5d625f', wallHigh: '#7b7f78', stripe: true, ambient: 0.4 },
    },

    lift: {
      rows: [
        '#######',
        '##N####',
        '#.....#',
        '#.....#',
        '#.....#',
        '#.....#',
        '##DDD##',
      ],
      legend: {
        N: { type: 'liftpanel', label: 'Панель лифта', wall: true, decor: true },
        D: { type: 'liftdoor', label: 'Двери лифта', wall: true, bottom: true, decor: true },
      },
      lamps: [[3.5, 3.5]],
      style: { floor: 'metal', wallLow: '#70777a', wallHigh: '#8b9194', ambient: 0.3 },
    },

    stairs: {
      rows: [
        '#########',
        '#########',
        '#^^^|vvv#',
        '#^^^|vvv#',
        '#^^^|vvv#',
        '#.......#',
        '#.......#',
        '#.......#',
        '#########',
      ],
      legend: {
        '^': { type: 'steps', walkable: true, decor: true },
        v: { type: 'steps', walkable: true, decor: true, down: true },
        '|': { type: 'railing', decor: true },
      },
      lamps: [[4.5, 5.5]],
      style: { floor: 'concrete', wallLow: '#3a556f', wallHigh: '#a9aca2', ambient: 0.5 },
    },
  };

  // Как выглядят технические этажи (ниже жилых, без учреждений)
  const TECHNICAL_STYLE = { floor: 'rawconcrete', wallLow: '#4b4f4c', wallHigh: '#696c66', ambient: 0.62, technical: true };

  // ---------------------------------------------------------------------------
  // Сборка сцены из схемы
  // ---------------------------------------------------------------------------
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Перепланировка ЖЭК: накладки на схемы (одни и те же на сервере и у жильцов)
  const OVERLAY_LEGEND = {
    Z: { type: 'rubble', label: 'Завал', decor: true },
    K: { type: 'closet', label: 'Кладовка', wall: true },
  };

  /** Применить накладки к строкам схемы: 'wall' — замуровать, 'rubble' — завал, 'closet' — кладовка в стене. */
  function applyOverlays(rows, list) {
    if (!list || !list.length) return rows;
    const grid = rows.map((r) => r.split(''));
    for (const ov of list) {
      const ch = ov.kind === 'wall' ? '#' : ov.kind === 'rubble' ? 'Z' : ov.kind === 'closet' ? 'K' : null;
      if (!ch) continue;
      for (const [x, y] of ov.tiles || []) if (grid[y] && grid[y][x] != null) grid[y][x] = ch;
    }
    return grid.map((r) => r.join(''));
  }

  /**
   * Достижимость: какие объекты (с точкой подхода) недоступны от точки from. Нужна, чтобы завал
   * не отрезал жильцов от дверей, лифта и лестницы.
   */
  function unreachableObjects(scene, from) {
    const W = scene.w;
    const seen = new Uint8Array(scene.w * scene.h);
    const sx = Math.floor(from.x), sy = Math.floor(from.y);
    if (isSolidTile(scene, sx, sy)) return scene.objects.filter((o) => o.spot && !o.decor);
    const stack = [[sx, sy]];
    seen[sy * W + sx] = 1;
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= scene.w || ny >= scene.h || seen[ny * W + nx] || isSolidTile(scene, nx, ny)) continue;
        seen[ny * W + nx] = 1;
        stack.push([nx, ny]);
      }
    }
    return scene.objects.filter((o) => o.spot && !o.decor && !seen[Math.floor(o.spot.y) * W + Math.floor(o.spot.x)]);
  }

  function buildScene(key, kind, rows, legend, extra) {
    legend = { ...OVERLAY_LEGEND, ...legend };
    rows = applyOverlays(rows, extra && extra.overlays);
    const h = rows.length;
    const w = rows[0].length;
    const solid = new Uint8Array(w * h);
    const objects = [];
    const seen = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
      if (rows[y].length !== w) throw new Error(`Сцена ${key}: строка ${y} длиной ${rows[y].length}, ожидалось ${w}`);
      for (let x = 0; x < w; x++) {
        const ch = rows[y][x];
        if (ch === '.') continue;
        if (ch === '#' || ch === ' ') {
          solid[y * w + x] = 1;
          continue;
        }
        const def = legend[ch];
        if (!def) throw new Error(`Сцена ${key}: неизвестный символ «${ch}» в (${x},${y})`);
        if (!def.walkable) solid[y * w + x] = 1;
        if (seen[y * w + x]) continue;
        // склеиваем одинаковые соседние клетки в один объект
        let minX = x, maxX = x, minY = y, maxY = y;
        const stack = [[x, y]];
        seen[y * w + x] = 1;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (seen[ny * w + nx] || rows[ny][nx] !== ch) continue;
            seen[ny * w + nx] = 1;
            stack.push([nx, ny]);
          }
        }
        objects.push({
          id: `${ch}${minX}_${minY}`,
          char: ch,
          ...def,
          ...((extra.objectProps && extra.objectProps(def, ch)) || {}),
          x: minX,
          y: minY,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
        });
      }
    }

    const scene = { key, kind, w, h, rows, legend, solid, objects, lamps: extra.lamps || [], style: extra.style, floor: extra.floor ?? null, seed: hash(key) };
    for (const o of scene.objects) o.spot = interactSpot(scene, o);
    return scene;
  }

  function isSolidTile(scene, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= scene.w || ty >= scene.h) return true;
    return scene.solid[ty * scene.w + tx] === 1;
  }

  /** Может ли жилец стоять в точке (x, y) — с учётом его «толщины». */
  function canStand(scene, x, y, r = RADIUS) {
    return (
      !isSolidTile(scene, Math.floor(x - r), Math.floor(y - r)) &&
      !isSolidTile(scene, Math.floor(x + r), Math.floor(y - r)) &&
      !isSolidTile(scene, Math.floor(x - r), Math.floor(y + r)) &&
      !isSolidTile(scene, Math.floor(x + r), Math.floor(y + r))
    );
  }

  /** Клетка, с которой удобнее всего подойти к объекту (центр клетки). */
  function interactSpot(scene, o) {
    const mid = (a, len) => a + Math.floor((len - 1) / 2);
    const candidates = [];
    const below = [], above = [], left = [], right = [];
    for (let x = o.x; x < o.x + o.w; x++) {
      below.push([x, o.y + o.h]);
      above.push([x, o.y - 1]);
    }
    for (let y = o.y; y < o.y + o.h; y++) {
      left.push([o.x - 1, y]);
      right.push([o.x + o.w, y]);
    }
    const byMiddle = (arr, axis) => arr.slice().sort((a, b) => Math.abs(a[axis] - mid(axis ? o.y : o.x, axis ? o.h : o.w)) - Math.abs(b[axis] - mid(axis ? o.y : o.x, axis ? o.h : o.w)));
    // двери в нижней стене открываются вверх (внутрь помещения)
    if (o.bottom) candidates.push(...byMiddle(above, 0));
    candidates.push(...byMiddle(below, 0), ...byMiddle(above, 0), ...byMiddle(left, 1), ...byMiddle(right, 1));
    for (const [tx, ty] of candidates) if (!isSolidTile(scene, tx, ty)) return { x: tx + 0.5, y: ty + 0.5 };
    return null;
  }

  /** Расстояние от точки до прямоугольника объекта. */
  function distToObject(o, x, y) {
    const dx = Math.max(o.x - x, 0, x - (o.x + o.w));
    const dy = Math.max(o.y - y, 0, y - (o.y + o.h));
    return Math.hypot(dx, dy);
  }

  function nearObject(o, pos, reach = REACH) {
    return !!pos && distToObject(o, pos.x, pos.y) <= reach;
  }

  // ---------------------------------------------------------------------------
  // Поиск пути (A* по клеткам, 8 направлений без срезания углов)
  // ---------------------------------------------------------------------------
  /** A*. opts.avoid(x, y) → доп. стоимость клетки (обходить опасности, если можно). */
  function findPath(scene, from, to, opts) {
    const avoid = opts && opts.avoid;
    const sx = Math.floor(from.x), sy = Math.floor(from.y);
    let tx = Math.floor(to.x), ty = Math.floor(to.y);
    if (isSolidTile(scene, tx, ty)) return null;
    const W = scene.w;
    const idx = (x, y) => y * W + x;
    const g = new Float32Array(scene.w * scene.h).fill(Infinity);
    const came = new Int32Array(scene.w * scene.h).fill(-1);
    const open = [[sx, sy]];
    g[idx(sx, sy)] = 0;
    const hfn = (x, y) => Math.hypot(x - tx, y - ty);
    const closed = new Uint8Array(scene.w * scene.h);
    while (open.length) {
      let best = 0;
      for (let i = 1; i < open.length; i++) {
        const [ax, ay] = open[i], [bx, by] = open[best];
        if (g[idx(ax, ay)] + hfn(ax, ay) < g[idx(bx, by)] + hfn(bx, by)) best = i;
      }
      const [cx, cy] = open.splice(best, 1)[0];
      if (cx === tx && cy === ty) break;
      closed[idx(cx, cy)] = 1;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (isSolidTile(scene, nx, ny) || closed[idx(nx, ny)]) continue;
          if (dx && dy && (isSolidTile(scene, cx + dx, cy) || isSolidTile(scene, cx, cy + dy))) continue;
          let cost = g[idx(cx, cy)] + (dx && dy ? Math.SQRT2 : 1);
          if (avoid && !(nx === tx && ny === ty)) cost += avoid(nx, ny) || 0;
          if (cost < g[idx(nx, ny)]) {
            g[idx(nx, ny)] = cost;
            came[idx(nx, ny)] = idx(cx, cy);
            if (!open.some(([ox, oy]) => ox === nx && oy === ny)) open.push([nx, ny]);
          }
        }
      }
    }
    if (g[idx(tx, ty)] === Infinity) return null;
    const path = [];
    for (let i = idx(tx, ty); i !== idx(sx, sy) && i !== -1; i = came[i]) path.push({ x: (i % W) + 0.5, y: Math.floor(i / W) + 0.5 });
    path.reverse();
    if (path.length) path[path.length - 1] = { x: to.x, y: to.y };
    return path;
  }

  // ---------------------------------------------------------------------------
  // Мир: какая сцена по какому ключу
  // ---------------------------------------------------------------------------
  /**
   * @param {object} config { firstResidentialFloor, facilities: { canteen: 100, ... }, facilityNames: {...} }
   */
  function create(config) {
    const cache = new Map();
    const facilityByFloor = {};
    for (const [key, floor] of Object.entries(config.facilities)) facilityByFloor[floor] = key;

    function floorKind(floor) {
      if (facilityByFloor[floor]) return 'service';
      if (floor >= config.firstResidentialFloor) return 'residential';
      return 'technical';
    }

    function corridor(key, floor) {
      const t = TEMPLATES.corridor;
      const kind = floorKind(floor);
      const facility = facilityByFloor[floor] || null;
      const rows = t.rows.map((row) =>
        row
          .replace(/[1-6]/g, (d) => (kind === 'residential' ? d : 'x'))
          .replace(/f/g, facility ? 'F' : '#'),
      );
      return buildScene(key, 'corridor', rows, t.legend, {
        overlays: (config.overlays || {})[key],
        floor,
        lamps: t.lamps,
        style: kind === 'technical' ? { ...t.style, ...TECHNICAL_STYLE } : t.style,
        objectProps(def) {
          if (def.type === 'apt') return { number: `${floor}${String(def.index).padStart(2, '0')}` };
          if (def.type === 'facility') return { facility, label: (config.facilityNames || {})[facility] || facility };
          return null;
        },
      });
    }

    function scene(key) {
      if (cache.has(key)) return cache.get(key);
      let s;
      const [kind, arg] = String(key).split(':');
      if (kind === 'corridor') s = corridor(key, Number(arg));
      else if (kind === 'home') {
        const t = TEMPLATES.home;
        s = buildScene(key, 'home', t.rows, t.legend, { overlays: (config.overlays || {})[key], lamps: t.lamps, style: t.style, floor: Math.floor(Number(arg) / 100) });
      } else if (TEMPLATES[kind]) {
        const t = TEMPLATES[kind];
        s = buildScene(key, kind, t.rows, t.legend, { overlays: (config.overlays || {})[key], lamps: t.lamps, style: t.style, floor: config.facilities[kind] ?? null });
      } else {
        throw new Error(`Нет сцены ${key}`);
      }
      if (cache.size > 2000) cache.clear();
      cache.set(key, s);
      return s;
    }

    /**
     * Где появляется жилец, войдя в сцену.
     * entry: 'lift' | 'stairs' | 'apt:10101' | 'facility' | 'exit' | 'default'
     */
    function spawn(key, entry = 'default') {
      const s = scene(key);
      let o = null;
      if (entry === 'lift') o = s.objects.find((x) => x.type === 'lift');
      else if (entry === 'stairs') o = s.objects.find((x) => x.type === 'stairs');
      else if (entry.startsWith('apt:')) o = s.objects.find((x) => x.type === 'apt' && x.number === entry.slice(4));
      else if (entry === 'facility') o = s.objects.find((x) => x.type === 'facility');
      else if (entry === 'bed') o = s.objects.find((x) => x.type === 'bed');
      if (!o) o = s.objects.find((x) => x.type === 'exit' || x.type === 'hermodoor' || x.type === 'liftdoor');
      if (!o) o = s.objects.find((x) => x.type === 'lift');
      if (o && o.spot) return { x: o.spot.x, y: o.spot.y };
      const cx = Math.floor(s.w / 2), cy = Math.floor(s.h / 2) + 1;
      if (!isSolidTile(s, cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (!isSolidTile(s, x, y)) return { x: x + 0.5, y: y + 0.5 };
      return { x: 1.5, y: 1.5 };
    }

    return { scene, spawn, floorKind, facilityByFloor };
  }

  return { SPEED, RADIUS, REACH, TEMPLATES, create, canStand, isSolidTile, distToObject, nearObject, findPath, hash, unreachableObjects };
});
