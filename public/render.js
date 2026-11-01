'use strict';

/**
 * Отрисовка мира Гигахрущёвки на canvas. Вся графика — процедурная:
 * никаких файлов с картинками, всё рисуется кодом из схем public/shared/world.js.
 *
 * Слои кадра:
 *   1. статика сцены (пол, стены, двери, мебель) — рисуется один раз в offscreen-canvas;
 *   2. живые детали (табло лифта, таблички с именами, конвейер, пар над супом, часы);
 *   3. жильцы (сортировка по глубине);
 *   4. свет: темнота + «дыры» от ламп и фонарика;
 *   5. туман, тревога, имена, облачка реплик, подсветка цели.
 */
(function (global) {
  const W = global.World;

  // ---------------------------------------------------------------------------
  // Палитры и мелкие помощники
  // ---------------------------------------------------------------------------
  const COATS = ['#5b4636', '#3e4a5c', '#4d5a3a', '#6a3b3b', '#3b5856', '#5a5a5a', '#6b5a2f', '#4a3f5c', '#2f3b46', '#704c2c'];
  const SKINS = ['#e0b896', '#c99d78', '#a87b5a', '#f0cfb0', '#d6a985'];
  const HAIRS = ['#2b2118', '#4a3424', '#8a6a3a', '#b8b0a0', '#1d1d1d', '#6b3a22'];
  const SCARVES = ['#8d2f2a', '#2f5d8d', '#c9a227', '#3e6b3a'];

  function lookFor(id) {
    const h = W.hash(String(id));
    return {
      coat: COATS[h % COATS.length],
      skin: SKINS[(h >>> 5) % SKINS.length],
      hair: HAIRS[(h >>> 9) % HAIRS.length],
      hat: (h >>> 13) % 4 === 0,
      scarf: (h >>> 15) % 3 === 0 ? SCARVES[(h >>> 17) % SCARVES.length] : null,
    };
  }

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) % 100000) / 100000;
    };
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, v + amt));
    return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /** Кисть в клеточных координатах: всё рисуем в долях клетки. */
  function brush(g, T) {
    return {
      g,
      T,
      rect(x, y, w, h, color) {
        g.fillStyle = color;
        g.fillRect(x * T, y * T, w * T, h * T);
      },
      rrect(x, y, w, h, r, color) {
        g.fillStyle = color;
        roundRect(g, x * T, y * T, w * T, h * T, r * T);
        g.fill();
      },
      circle(x, y, r, color) {
        g.fillStyle = color;
        g.beginPath();
        g.arc(x * T, y * T, r * T, 0, Math.PI * 2);
        g.fill();
      },
      line(x1, y1, x2, y2, color, width = 0.03) {
        g.strokeStyle = color;
        g.lineWidth = Math.max(1, width * T);
        g.beginPath();
        g.moveTo(x1 * T, y1 * T);
        g.lineTo(x2 * T, y2 * T);
        g.stroke();
      },
      text(str, x, y, size, color, align = 'center', weight = '700') {
        g.fillStyle = color;
        g.font = `${weight} ${Math.max(6, size * T)}px "PT Sans Narrow", "PT Sans", Arial, sans-serif`;
        g.textAlign = align;
        g.textBaseline = 'middle';
        g.fillText(str, x * T, y * T);
      },
      /** Ящик с видимой передней гранью — для мебели в виде «три четверти». */
      box(x, y, w, h, top, front, frontH = 0.25) {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect((x + 0.05) * T, (y + h - 0.02) * T, w * T, 0.12 * T);
        g.fillStyle = front;
        g.fillRect(x * T, (y + h - frontH) * T, w * T, frontH * T);
        g.fillStyle = top;
        g.fillRect(x * T, y * T, w * T, (h - frontH) * T);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(x * T, y * T, w * T, Math.max(1, 0.03 * T));
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Классификация клеток
  // ---------------------------------------------------------------------------
  function charAt(scene, x, y) {
    if (x < 0 || y < 0 || x >= scene.w || y >= scene.h) return '#';
    return scene.rows[y][x];
  }

  function isWallish(scene, x, y) {
    const ch = charAt(scene, x, y);
    if (ch === '#' || ch === ' ') return true;
    const def = scene.legend[ch];
    return !!(def && def.wall);
  }

  /** 'low' — нижняя крашеная часть стены, 'high' — верхняя побелка, 'cap' — торец стены сверху. */
  function wallKind(scene, x, y) {
    if (y + 1 < scene.h && !isWallish(scene, x, y + 1)) return 'low';
    if (y + 2 < scene.h && isWallish(scene, x, y + 1) && !isWallish(scene, x, y + 2)) return 'high';
    return 'cap';
  }

  // ---------------------------------------------------------------------------
  // Пол
  // ---------------------------------------------------------------------------
  function drawFloor(b, x, y, style, R) {
    const { g } = b;
    switch (style.floor) {
      case 'linoleum': {
        b.rect(x, y, 1, 1, (x + y) % 2 ? '#6a5843' : '#655340');
        for (let i = 0; i < 4; i++) b.rect(x + R() * 0.9, y + R() * 0.9, 0.05, 0.05, 'rgba(0,0,0,0.12)');
        if (R() < 0.08) b.rrect(x + R() * 0.5, y + R() * 0.5, 0.3, 0.2, 0.08, 'rgba(0,0,0,0.12)');
        b.rect(x, y + 0.98, 1, 0.02, 'rgba(0,0,0,0.15)');
        break;
      }
      case 'parquet': {
        for (let i = 0; i < 4; i++) {
          const off = (i % 2) * 0.5 + (x % 2) * 0.25;
          const tone = 120 + Math.floor(R() * 25);
          b.rect(x, y + i * 0.25, 1, 0.25, `rgb(${tone},${Math.floor(tone * 0.72)},${Math.floor(tone * 0.46)})`);
          b.rect(x + (off % 1), y + i * 0.25, 0.02, 0.25, 'rgba(0,0,0,0.25)');
          b.rect(x, y + i * 0.25 + 0.235, 1, 0.015, 'rgba(0,0,0,0.25)');
        }
        break;
      }
      case 'tiles': {
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) b.rect(x + i * 0.5, y + j * 0.5, 0.5, 0.5, (i + j + x + y) % 2 ? '#a39883' : '#8a7f6a');
        b.rect(x, y, 1, 0.015, 'rgba(0,0,0,0.2)');
        b.rect(x, y, 0.015, 1, 'rgba(0,0,0,0.2)');
        break;
      }
      case 'medtiles': {
        b.rect(x, y, 1, 1, '#c6ccc8');
        for (let i = 1; i < 3; i++) {
          b.rect(x + i / 3, y, 0.012, 1, '#a7afab');
          b.rect(x, y + i / 3, 1, 0.012, '#a7afab');
        }
        b.rect(x, y, 1, 0.012, '#a7afab');
        b.rect(x, y, 0.012, 1, '#a7afab');
        break;
      }
      case 'metal': {
        b.rect(x, y, 1, 1, '#5d6366');
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) b.rect(x + i * 0.25 + ((j % 2) * 0.125), y + j * 0.25 + 0.1, 0.08, 0.03, 'rgba(255,255,255,0.12)');
        break;
      }
      case 'rawconcrete':
      case 'concrete':
      default: {
        const base = style.floor === 'rawconcrete' ? '#474a47' : '#595d5a';
        b.rect(x, y, 1, 1, base);
        for (let i = 0; i < 6; i++) b.rect(x + R(), y + R(), 0.04, 0.04, R() < 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.06)');
        if (R() < 0.07) b.line(x + R(), y + R(), x + R(), y + R(), 'rgba(0,0,0,0.3)', 0.015);
        if (style.floor === 'rawconcrete' && R() < 0.06) b.rrect(x + 0.1, y + 0.2, 0.7, 0.4, 0.2, 'rgba(30,40,45,0.5)');
      }
    }
    g.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Стены
  // ---------------------------------------------------------------------------
  function drawWall(b, scene, x, y, R) {
    const st = scene.style;
    const kind = wallKind(scene, x, y);
    const { g, T } = b;
    if (kind === 'low') {
      const grad = g.createLinearGradient(0, y * T, 0, (y + 1) * T);
      grad.addColorStop(0, shade(st.wallLow, 12));
      grad.addColorStop(1, shade(st.wallLow, -14));
      g.fillStyle = grad;
      g.fillRect(x * T, y * T, T, T);
      b.rect(x, y + 0.04, 1, 0.05, 'rgba(0,0,0,0.28)'); // граница покраски
      if (st.tiled) {
        for (let i = 1; i < 4; i++) b.rect(x, y + 0.1 + i * 0.22, 1, 0.012, 'rgba(0,0,0,0.12)');
        b.rect(x + 0.5, y + 0.1, 0.012, 0.8, 'rgba(0,0,0,0.12)');
      }
      if (st.stripe) {
        for (let i = 0; i < 4; i++) {
          b.rect(x + i * 0.25, y + 0.74, 0.125, 0.14, '#c9a227');
          b.rect(x + i * 0.25 + 0.125, y + 0.74, 0.125, 0.14, '#222');
        }
      }
      if (R() < 0.25) b.rect(x + R() * 0.9, y + 0.1, 0.02, 0.2 + R() * 0.4, 'rgba(0,0,0,0.12)'); // подтёки
      b.rect(x, y + 0.9, 1, 0.1, '#2a2622'); // плинтус
    } else if (kind === 'high') {
      const grad = g.createLinearGradient(0, y * T, 0, (y + 1) * T);
      grad.addColorStop(0, shade(st.wallHigh, -40));
      grad.addColorStop(0.35, shade(st.wallHigh, -6));
      grad.addColorStop(1, st.wallHigh);
      g.fillStyle = grad;
      g.fillRect(x * T, y * T, T, T);
      if (st.wallpaper) {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) b.circle(x + 0.17 + i * 0.33, y + 0.2 + j * 0.3, 0.035, 'rgba(90,60,40,0.28)');
      }
      if (st.technical) {
        b.rect(x, y + 0.3, 1, 0.12, '#6e5a46');
        b.rect(x, y + 0.31, 1, 0.03, 'rgba(255,255,255,0.12)');
        b.rect(x, y + 0.55, 1, 0.08, '#5d6466');
        if (x % 3 === 0) b.rect(x + 0.4, y + 0.26, 0.08, 0.4, '#3d4142');
      }
      if (R() < 0.18) b.rrect(x + R() * 0.6, y + 0.3 + R() * 0.4, 0.3, 0.2, 0.1, 'rgba(70,60,40,0.12)'); // пятна
    } else {
      b.rect(x, y, 1, 1, '#1f2221');
      const edge = '#3b403e';
      if (!isWallish(scene, x, y - 1) && y > 0) b.rect(x, y, 1, 0.06, edge);
      if (y + 1 < scene.h && !isWallish(scene, x, y + 1)) b.rect(x, y + 0.94, 1, 0.06, edge);
      if (!isWallish(scene, x - 1, y)) b.rect(x, y, 0.06, 1, edge);
      if (!isWallish(scene, x + 1, y)) b.rect(x + 0.94, y, 0.06, 1, edge);
    }
  }

  // ---------------------------------------------------------------------------
  // Предметы (статичная часть)
  // ---------------------------------------------------------------------------
  const POSTERS = [
    ['#9e2b25', '#e3c35a', 'ТРУД'],
    ['#2c4f7a', '#e9e3d0', 'НЕ ВХОДИ В ТУМАН'],
    ['#9e2b25', '#e9e3d0', 'ХЛЕБ — ВСЕМУ ГОЛОВА'],
    ['#4f6b3a', '#e9e3d0', 'МОЙ РУКИ'],
    ['#7a2f5a', '#e3c35a', 'ПЛАН — ЗАКОН'],
  ];

  function drawObject(b, scene, o, R) {
    const { x, y, w, h } = o;
    switch (o.type) {
      case 'apt':
      case 'locked': {
        const top = y - 0.62;
        b.rect(x + 0.07, top - 0.05, 0.86, 1.67, '#2a1f17');
        if (o.type === 'apt') {
          const grad = b.g.createLinearGradient(0, top * b.T, 0, (y + 1) * b.T);
          grad.addColorStop(0, '#6a4430');
          grad.addColorStop(1, '#4b2f20');
          b.g.fillStyle = grad;
          b.g.fillRect((x + 0.12) * b.T, top * b.T, 0.76 * b.T, 1.6 * b.T);
          for (let i = 0; i < 4; i++) for (let j = 0; j < 7; j++) b.circle(x + 0.22 + i * 0.19, top + 0.15 + j * 0.21, 0.018, '#c9a46a');
          b.circle(x + 0.5, top + 0.2, 0.03, '#111');
          b.rect(x + 0.32, top + 0.32, 0.36, 0.13, '#d8d0b8');
          b.text(o.number, x + 0.5, top + 0.39, 0.11, '#222');
        } else {
          b.rect(x + 0.12, top, 0.76, 1.6, '#55605a');
          for (const [rx, ry] of [[0.2, 0.1], [0.8, 0.1], [0.2, 1.5], [0.8, 1.5]]) b.circle(x + rx, top + ry, 0.025, '#3a413d');
          b.rect(x + 0.3, top + 0.35, 0.4, 0.14, '#a33a30');
          b.text('СЛУЖ.', x + 0.5, top + 0.42, 0.1, '#eee');
        }
        b.rect(x + 0.74, top + 0.85, 0.08, 0.1, '#c9b27a');
        break;
      }
      case 'facility': {
        const top = y - 0.65;
        b.rect(x + 0.05, top - 0.05, w - 0.1, 1.7, '#4a3220');
        for (let i = 0; i < 2; i++) {
          const lx = x + 0.12 + i * (w / 2 - 0.05);
          b.rect(lx, top, w / 2 - 0.14, 1.6, '#7a5634');
          b.rect(lx + 0.08, top + 0.12, w / 2 - 0.3, 0.8, 'rgba(170,200,195,0.65)');
          b.rect(lx + 0.08, top + 1.05, w / 2 - 0.3, 0.06, '#c9b27a');
        }
        b.rect(x + 0.1, y - 1.0, w - 0.2, 0.32, '#1c2421');
        b.text(String(o.label || '').toUpperCase(), x + w / 2, y - 0.84, 0.17, '#e9e3d0');
        break;
      }
      case 'lift': {
        const top = y - 0.62;
        b.rect(x + 0.05, top - 0.06, w - 0.1, 1.68, '#7d8487');
        const grad = b.g.createLinearGradient(x * b.T, 0, (x + w) * b.T, 0);
        grad.addColorStop(0, '#8e979a');
        grad.addColorStop(0.5, '#b5bdbf');
        grad.addColorStop(1, '#8e979a');
        b.g.fillStyle = grad;
        b.g.fillRect((x + 0.14) * b.T, top * b.T, (w - 0.28) * b.T, 1.6 * b.T);
        b.rect(x + w / 2 - 0.015, top, 0.03, 1.6, '#4b5254');
        b.rect(x + w / 2 - 0.35, y - 0.98, 0.7, 0.26, '#0e0f0f');
        b.rect(x + w - 0.04, y - 0.1, 0.12, 0.2, '#555');
        b.circle(x + w + 0.02, y, 0.04, '#d9b45a');
        break;
      }
      case 'stairs': {
        const top = y - 0.62;
        b.rect(x + 0.05, top - 0.05, w - 0.1, 1.67, '#202326');
        for (let i = 0; i < 8; i++) {
          const t = i / 8;
          b.rect(x + 0.15, top + 0.1 + t * 1.4, w - 0.3, 0.12, `rgba(${120 - i * 8},${125 - i * 8},${120 - i * 8},1)`);
        }
        b.line(x + 0.3, top + 0.1, x + 0.3, y + 0.95, '#8a8f8c', 0.04);
        b.rect(x + 0.2, y - 1.0, w - 0.4, 0.24, '#2f5d8d');
        b.text('ЛЕСТНИЦА', x + w / 2, y - 0.88, 0.14, '#e9e3d0');
        break;
      }
      case 'board': {
        b.rect(x + 0.05, y - 0.55, 0.9, 0.9, '#5a3d24');
        b.rect(x + 0.1, y - 0.5, 0.8, 0.8, '#a07850');
        for (let i = 0; i < 5; i++) {
          const px = x + 0.14 + R() * 0.45, py = y - 0.46 + R() * 0.45;
          b.rect(px, py, 0.26, 0.22, R() < 0.5 ? '#e9e3d0' : '#e3d58a');
          b.rect(px + 0.03, py + 0.06, 0.18, 0.015, '#666');
          b.rect(px + 0.03, py + 0.11, 0.15, 0.015, '#666');
          b.circle(px + 0.13, py + 0.02, 0.02, '#b33');
        }
        break;
      }
      case 'chute': {
        b.rect(x + 0.35, y - 1.0, 0.3, 1.3, '#5d6466');
        b.rect(x + 0.15, y - 0.2, 0.7, 0.55, '#6f7576');
        b.rect(x + 0.2, y - 0.15, 0.6, 0.45, '#585e60');
        b.rect(x + 0.35, y - 0.12, 0.3, 0.06, '#2e3233');
        break;
      }
      case 'hose': {
        b.rect(x + 0.15, y - 0.5, 0.7, 0.75, '#a3302a');
        b.rect(x + 0.2, y - 0.45, 0.6, 0.65, '#b8382f');
        b.text('ПК', x + 0.5, y - 0.12, 0.25, '#f2e9dc');
        break;
      }
      case 'window': {
        b.rect(x + 0.08, y - 0.7, 0.84, 1.2, '#d8d4c8');
        b.rect(x + 0.14, y - 0.64, 0.72, 1.08, '#3d4246');
        for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) b.rect(x + 0.2 + i * 0.22, y - 0.58 + j * 0.25, 0.12, 0.14, R() < 0.35 ? '#d9b45a' : '#2a2e31');
        b.rect(x + 0.49, y - 0.64, 0.03, 1.08, '#d8d4c8');
        b.rect(x + 0.04, y + 0.48, 0.92, 0.1, '#c9c4b5');
        break;
      }
      case 'radio': {
        b.rect(x + 0.25, y - 0.35, 0.5, 0.42, '#6b4a2e');
        for (let i = 0; i < 5; i++) b.rect(x + 0.3, y - 0.3 + i * 0.06, 0.28, 0.025, '#3a2818');
        b.circle(x + 0.66, y - 0.12, 0.05, '#c9b27a');
        b.line(x + 0.5, y - 0.35, x + 0.5, y - 0.9, '#2a2a2a', 0.02);
        break;
      }
      case 'poster': {
        const [bg, fg, txt] = POSTERS[(scene.seed + x) % POSTERS.length];
        b.rect(x + 0.12, y - 0.75, 0.76, 1.0, bg);
        b.rect(x + 0.18, y - 0.68, 0.64, 0.4, shade(bg, 25));
        b.circle(x + 0.5, y - 0.48, 0.12, fg);
        const words = txt.split(' ');
        words.slice(0, 3).forEach((wd, i) => b.text(wd, x + 0.5, y - 0.15 + i * 0.12, 0.11, fg));
        break;
      }
      case 'menu': {
        b.rect(x + 0.1, y - 0.75, w - 0.2, 1.0, '#4a3220');
        b.rect(x + 0.16, y - 0.69, w - 0.32, 0.88, '#1f2a22');
        b.text('МЕНЮ', x + w / 2, y - 0.55, 0.18, '#e9e3d0');
        for (let i = 0; i < 4; i++) b.rect(x + 0.3, y - 0.36 + i * 0.13, w - 0.9, 0.03, 'rgba(233,227,208,0.7)');
        break;
      }
      case 'window_med': {
        b.rect(x + 0.1, y - 0.8, w - 0.2, 1.2, '#d6dbd7');
        b.rect(x + 0.2, y - 0.7, w - 0.4, 0.75, 'rgba(150,180,175,0.8)');
        b.rect(x + w / 2 - 0.35, y - 0.15, 0.7, 0.3, '#2a2e2c');
        b.rect(x + w / 2 - 0.06, y - 0.62, 0.12, 0.34, '#c0392b');
        b.rect(x + w / 2 - 0.17, y - 0.51, 0.34, 0.12, '#c0392b');
        b.text('ФЕЛЬДШЕР', x + w / 2, y - 0.92, 0.15, '#c0392b');
        break;
      }
      case 'jobboard': {
        b.rect(x + 0.1, y - 0.75, w - 0.2, 1.0, '#2a2e2c');
        b.text('НАРЯДЫ', x + w / 2, y - 0.6, 0.17, '#c9a227');
        for (let i = 0; i < 4; i++) b.rect(x + 0.25 + i * 0.4, y - 0.45, 0.3, 0.45, '#e9e3d0');
        break;
      }
      case 'clock': {
        b.circle(x + 0.5, y - 0.35, 0.34, '#2a2e2c');
        b.circle(x + 0.5, y - 0.35, 0.29, '#e9e3d0');
        break;
      }
      case 'liftpanel': {
        b.rect(x + 0.2, y - 0.7, 0.6, 0.9, '#3d4244');
        b.rect(x + 0.28, y - 0.62, 0.44, 0.2, '#0e0f0f');
        for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) b.circle(x + 0.38 + j * 0.24, y - 0.25 + i * 0.13, 0.045, '#9aa3a6');
        break;
      }
      case 'bed': {
        b.box(x + 0.04, y + 0.02, 0.92, h - 0.06, '#6b4a2c', '#4a3220', 0.18);
        b.rect(x + 0.1, y + 0.08, 0.8, h - 0.32, '#cfc8b5');
        b.rrect(x + 0.16, y + 0.12, 0.68, 0.32, 0.08, '#ebe6d9');
        b.rect(x + 0.1, y + 0.6, 0.8, h - 0.84, '#4f5e4a');
        b.rect(x + 0.1, y + 0.6, 0.8, 0.06, '#5f705a');
        break;
      }
      case 'sink': {
        b.box(x + 0.1, y + 0.05, 0.8, 0.7, '#dcdfdb', '#a9aeab', 0.18);
        b.rrect(x + 0.22, y + 0.12, 0.56, 0.35, 0.1, '#b8bdba');
        b.circle(x + 0.5, y + 0.3, 0.04, '#555');
        break;
      }
      case 'stove': {
        b.box(x + 0.08, y + 0.05, 0.84, 0.75, '#e6e1d4', '#b5b0a3', 0.2);
        b.circle(x + 0.32, y + 0.3, 0.13, '#2a2a2a');
        b.circle(x + 0.68, y + 0.3, 0.13, '#2a2a2a');
        b.circle(x + 0.68, y + 0.3, 0.08, '#4a3a2a');
        break;
      }
      case 'wardrobe': {
        b.box(x + 0.05, y - 0.35, 0.9, 1.25, '#6b4a2c', '#5a3d24', 0.85);
        b.rect(x + 0.49, y + 0.08, 0.02, 0.75, '#2e2015');
        b.circle(x + 0.42, y + 0.45, 0.03, '#c9b27a');
        b.circle(x + 0.58, y + 0.45, 0.03, '#c9b27a');
        break;
      }
      case 'table': {
        b.box(x + 0.1, y + 0.1, w - 0.2, 0.8, '#7a5a3a', '#5a4028', 0.22);
        b.rrect(x + 0.25, y + 0.15, w - 0.5, 0.45, 0.04, '#c9c3b4');
        b.circle(x + 0.6, y + 0.35, 0.08, '#e6e1d4');
        b.circle(x + 0.6, y + 0.35, 0.05, '#7a4a2a');
        b.rrect(x + 1.05, y + 0.25, 0.4, 0.2, 0.08, '#b5824a');
        break;
      }
      case 'counter': {
        b.box(x, y + 0.05, w, 0.85, '#a9b0b2', '#7e8587', 0.3);
        for (let i = 0; i < w; i += 2) {
          b.circle(x + i + 0.55, y + 0.3, 0.24, '#8b8f90');
          b.circle(x + i + 0.55, y + 0.3, 0.19, i % 4 ? '#b4723a' : '#c9b06a');
          b.rect(x + i + 1.1, y + 0.18, 0.6, 0.28, '#c9c3b4');
        }
        break;
      }
      case 'dtable': {
        b.box(x + 0.08, y + 0.1, w - 0.16, 0.8, '#c9c3b4', '#7a5a3a', 0.2);
        for (let i = 0; i < (w - 0.16) / 0.2; i++) for (let j = 0; j < 3; j++) if ((i + j) % 2) b.rect(x + 0.08 + i * 0.2, y + 0.1 + j * 0.2, 0.2, 0.2, 'rgba(164,74,63,0.55)');
        b.circle(x + w / 2, y + 0.35, 0.05, '#e9e3d0');
        break;
      }
      case 'couch': {
        b.box(x + 0.1, y + 0.05, w - 0.2, h - 0.1, '#5d7f6e', '#3f5a4c', 0.25);
        b.rrect(x + 0.18, y + 0.12, w - 0.36, 0.45, 0.1, '#6f9381');
        break;
      }
      case 'cabinet': {
        b.box(x + 0.08, y - 0.2, 0.84, h + 0.1, '#e5e7e2', '#c9ccc6', 0.9);
        b.rect(x + 0.18, y + 0.15, 0.64, 0.5, 'rgba(150,180,175,0.7)');
        b.rect(x + 0.45, y + 0.8, 0.1, 0.3, '#c0392b');
        b.rect(x + 0.35, y + 0.9, 0.3, 0.1, '#c0392b');
        break;
      }
      case 'conveyor': {
        b.rect(x, y + 0.12, w, 0.76, '#5e6361');
        b.rect(x, y + 0.2, w, 0.6, '#2e3130');
        break;
      }
      case 'station': {
        if (o.game === 'sort') {
          b.box(x + 0.1, y + 0.1, w - 0.2, h - 0.2, '#7a7d76', '#555850', 0.3);
          const bins = ['#8f9496', '#c9a24a', '#a7b0b4', '#a33a30'];
          bins.forEach((c, i) => b.rect(x + 0.25 + i * 0.38, y + 0.3, 0.32, 0.5, c));
          for (let i = 0; i < 6; i++) b.circle(x + 0.3 + R() * 1.3, y + 1.0 + R() * 0.4, 0.04, '#bbb');
        } else if (o.game === 'meter') {
          b.box(x + 0.1, y - 0.1, w - 0.2, h, '#4f6a5f', '#3c5249', 0.6);
          for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
            b.rect(x + 0.25 + i * 0.52, y + 0.05 + j * 0.42, 0.42, 0.26, '#0e1310');
            b.rect(x + 0.29 + i * 0.52, y + 0.12 + j * 0.42, 0.34, 0.1, '#3f7a4a');
          }
        } else {
          b.circle(x + 1, y + 1.05, 0.88, 'rgba(0,0,0,0.3)');
          b.circle(x + 1, y + 0.95, 0.85, '#8a8f8c');
          b.circle(x + 1, y + 0.95, 0.7, '#9da29f');
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            b.circle(x + 1 + Math.cos(a) * 0.78, y + 0.95 + Math.sin(a) * 0.78, 0.035, '#5d625f');
          }
          b.circle(x + 1, y + 0.8, 0.3, '#2a2e2c');
          b.circle(x + 1, y + 0.8, 0.26, '#e9e3d0');
          b.rect(x + 1.7, y + 0.2, 0.2, 1.4, '#6f5a46');
        }
        break;
      }
      case 'machine': {
        b.box(x + 0.1, y + 0.05, w - 0.2, h - 0.1, '#6e7470', '#545956', 0.4);
        b.rect(x + 0.3, y + 0.3, w - 0.6, 0.35, '#c26b2a');
        b.circle(x + 0.55, y + 0.95, 0.2, '#3d4244');
        b.rect(x + 0.9, y + 0.85, 0.8, 0.12, '#9aa3a6');
        break;
      }
      case 'radiator': {
        b.rect(x + 0.08, y + 0.55, 0.84, 0.4, '#8d9290');
        for (let i = 0; i < 7; i++) b.rect(x + 0.12 + i * 0.115, y + 0.55, 0.05, 0.4, '#6f7472');
        b.rect(x + 0.08, y + 0.55, 0.84, 0.04, '#b0b5b3');
        break;
      }
      case 'steps': {
        for (let i = 0; i < 4; i++) {
          const tone = o.down ? 70 + i * 6 : 112 - i * 6;
          b.rect(x, y + i * 0.25, w, 0.25, `rgb(${tone},${tone + 3},${tone})`);
          b.rect(x, y + i * 0.25 + 0.22, w, 0.03, 'rgba(0,0,0,0.3)');
        }
        break;
      }
      case 'railing': {
        b.rect(x + 0.4, y, 0.2, h, '#2a2d2c');
        b.rect(x + 0.45, y, 0.1, h, '#8a8f8c');
        break;
      }
      case 'hermodoor': {
        b.rect(x, y, w, 1, '#1f2221');
        b.rect(x + 0.1, y + 0.05, w - 0.2, 0.9, '#7c8486');
        for (let i = 0; i < 6; i++) b.circle(x + 0.2 + i * ((w - 0.4) / 5), y + 0.12, 0.025, '#4f5759');
        for (let i = 0; i < 6; i++) b.circle(x + 0.2 + i * ((w - 0.4) / 5), y + 0.88, 0.025, '#4f5759');
        b.circle(x + w / 2, y + 0.5, 0.28, '#4f5759');
        b.circle(x + w / 2, y + 0.5, 0.22, '#7c8486');
        break;
      }
      case 'exit': {
        b.rect(x, y, w, 1, '#1f2221');
        b.rect(x + 0.1, y, w - 0.2, 1, '#2d2a26');
        b.rect(x + 0.2, y + 0.1, w - 0.4, 0.5, '#3a3a36');
        b.rect(x + w / 2 - 0.4, y + 0.66, 0.8, 0.24, '#2f6b3a');
        b.text('ВЫХОД', x + w / 2, y + 0.78, 0.15, '#e9e3d0');
        break;
      }
      case 'liftdoor': {
        b.rect(x, y, w, 1, '#1f2221');
        b.rect(x + 0.1, y + 0.1, w - 0.2, 0.8, '#9aa3a6');
        b.rect(x + w / 2 - 0.015, y + 0.1, 0.03, 0.8, '#4b5254');
        break;
      }
      default:
    }
  }

  function buildStatic(scene, T) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(scene.w * T);
    c.height = Math.ceil(scene.h * T);
    const g = c.getContext('2d');
    const b = brush(g, T);
    const R = rng(scene.seed);
    for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) if (!isWallish(scene, x, y)) drawFloor(b, x, y, scene.style, R);
    if (scene.kind === 'corridor') b.rect(1, 3, scene.w - 2, 2, 'rgba(255,240,210,0.035)'); // протоптанная дорожка
    for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) if (isWallish(scene, x, y)) drawWall(b, scene, x, y, R);
    const order = scene.objects.slice().sort((a, b2) => a.y + a.h - (b2.y + b2.h));
    for (const o of order) drawObject(b, scene, o, R);
    return c;
  }

  // ---------------------------------------------------------------------------
  // Жильцы
  // ---------------------------------------------------------------------------
  function drawCharacter(b, a, t) {
    // жилец не в сети (бредёт домой или спит) — полупрозрачный
    if (a.away) b.g.globalAlpha = 0.55;
    try {
      drawCharacterBody(b, a, t);
    } finally {
      b.g.globalAlpha = 1;
    }
  }

  function drawCharacterBody(b, a, t) {
    const { x, y } = a;
    const L = a.look;
    const walk = a.m ? Math.sin(t * 11 + (a.phase || 0)) : 0;
    const bob = a.m ? Math.abs(walk) * 0.03 : 0;
    const dir = a.d || 'down';
    // тень
    b.g.fillStyle = 'rgba(0,0,0,0.35)';
    b.g.beginPath();
    b.g.ellipse(x * b.T, y * b.T, 0.24 * b.T, 0.09 * b.T, 0, 0, Math.PI * 2);
    b.g.fill();
    if (a.self) {
      b.g.strokeStyle = 'rgba(227,161,59,0.8)';
      b.g.lineWidth = Math.max(1, 0.03 * b.T);
      b.g.beginPath();
      b.g.ellipse(x * b.T, y * b.T, 0.3 * b.T, 0.12 * b.T, 0, 0, Math.PI * 2);
      b.g.stroke();
    }
    if (a.down) {
      // без сознания: лежит на полу, рука откинута
      b.g.fillStyle = 'rgba(90,20,15,0.35)';
      b.g.beginPath();
      b.g.ellipse((x + 0.05) * b.T, (y - 0.12) * b.T, 0.42 * b.T, 0.16 * b.T, 0.2, 0, Math.PI * 2);
      b.g.fill();
      b.rrect(x - 0.36, y - 0.3, 0.6, 0.26, 0.1, L.coat);
      b.rrect(x + 0.18, y - 0.2, 0.3, 0.08, 0.04, shade(L.coat, -12));
      b.rect(x - 0.3, y - 0.08, 0.32, 0.08, '#2a2622');
      b.circle(x - 0.38, y - 0.18, 0.13, '#c9b9a4');
      return;
    }
    if (a.sleep) {
      // спит: лежит
      b.rrect(x - 0.32, y - 0.32, 0.64, 0.26, 0.1, L.coat);
      b.circle(x - 0.3, y - 0.2, 0.13, a.sick ? '#b9c49a' : L.skin);
      const z = (t * 0.6) % 1;
      b.text('z', x + 0.1 + z * 0.2, y - 0.5 - z * 0.4, 0.22 * (1 - z * 0.4), `rgba(233,227,208,${1 - z})`, 'center', '400');
      return;
    }
    // ноги
    b.rect(x - 0.13, y - 0.24 + walk * 0.05, 0.1, 0.24 - walk * 0.05, '#2a2622');
    b.rect(x + 0.03, y - 0.24 - walk * 0.05, 0.1, 0.24 + walk * 0.05, '#2a2622');
    const by = y - bob;
    // пальто
    b.rrect(x - 0.22, by - 0.72, 0.44, 0.52, 0.12, L.coat);
    b.rect(x - 0.22, by - 0.3, 0.44, 0.08, shade(L.coat, -25));
    if (dir !== 'up') b.rect(x - 0.012, by - 0.66, 0.024, 0.42, shade(L.coat, -35));
    // руки
    const arm = a.m ? walk * 0.06 : 0;
    b.rrect(x - 0.3, by - 0.66 - arm, 0.1, 0.36, 0.05, shade(L.coat, -12));
    b.rrect(x + 0.2, by - 0.66 + arm, 0.1, 0.36, 0.05, shade(L.coat, -12));
    if (a.hurt) b.rect(x + 0.2, by - 0.52 + arm, 0.1, 0.1, '#eeeeee');
    if (L.scarf) b.rrect(x - 0.17, by - 0.76, 0.34, 0.1, 0.04, L.scarf);
    // голова
    const skin = a.sick ? '#b9c49a' : L.skin;
    b.circle(x, by - 0.9, 0.18, skin);
    if (dir === 'up') {
      b.circle(x, by - 0.92, 0.18, L.hair);
    } else {
      b.g.fillStyle = L.hair;
      b.g.beginPath();
      b.g.arc(x * b.T, (by - 0.92) * b.T, 0.185 * b.T, Math.PI * 1.05, Math.PI * 1.95);
      b.g.fill();
      const ex = dir === 'left' ? -0.07 : dir === 'right' ? 0.07 : 0;
      if (a.mask) {
        b.circle(x + ex, by - 0.86, 0.11, '#5d6466');
        b.circle(x + ex - 0.06, by - 0.92, 0.04, '#bcd');
        b.circle(x + ex + 0.06, by - 0.92, 0.04, '#bcd');
        b.circle(x + ex, by - 0.8, 0.05, '#3a3f40');
      } else {
        if (dir !== 'right') b.circle(x - 0.06 + ex, by - 0.9, 0.022, '#1a1a1a');
        if (dir !== 'left') b.circle(x + 0.06 + ex, by - 0.9, 0.022, '#1a1a1a');
      }
    }
    if (L.hat) {
      b.rrect(x - 0.21, by - 1.12, 0.42, 0.16, 0.06, '#5a4330');
      b.rrect(x - 0.24, by - 1.0, 0.1, 0.16, 0.04, '#6b5240');
      b.rrect(x + 0.14, by - 1.0, 0.1, 0.16, 0.04, '#6b5240');
    }
  }

  function wrapText(g, text, maxW) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = test;
      if (lines.length >= 3) break;
    }
    if (line && lines.length < 3) lines.push(line);
    if (lines.length === 3 && words.join(' ').length > lines.join(' ').length) lines[2] = `${lines[2].slice(0, -1)}…`;
    return lines;
  }

  // ---------------------------------------------------------------------------
  // Рендерер
  // ---------------------------------------------------------------------------
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.scene = null;
      this.static = null;
      this.staticT = 0;
      this.T = 40; // CSS-пикселей на клетку
      this.dpr = 1;
      this.cssW = 0;
      this.cssH = 0;
      this.cam = { x: 0, y: 0 };
      this.light = document.createElement('canvas');
      this.fogSprite = this.makeFogSprite();
    }

    makeFogSprite() {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      grad.addColorStop(0, 'rgba(214,222,218,0.9)');
      grad.addColorStop(0.5, 'rgba(205,214,209,0.45)');
      grad.addColorStop(1, 'rgba(200,210,205,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
      return c;
    }

    resize(cssW, cssH) {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr) return;
      this.cssW = cssW;
      this.cssH = cssH;
      this.dpr = dpr;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.light.width = this.canvas.width;
      this.light.height = this.canvas.height;
      this.fitTile();
    }

    fitTile() {
      if (!this.scene || !this.cssW) return;
      // сколько клеток видно по ширине: на телефоне — меньше, зато всё крупнее
      const cols = this.cssW < 520 ? 9 : 12;
      const T = Math.min(this.cssW / Math.min(this.scene.w, cols), this.cssH / Math.min(this.scene.h + 0.3, 9.6));
      this.T = Math.max(22, Math.min(80, T));
      const TD = this.T * this.dpr;
      if (Math.abs(TD - this.staticT) > 0.5) {
        this.static = buildStatic(this.scene, TD);
        this.staticT = TD;
      }
    }

    setScene(scene) {
      if (this.scene && this.scene.key === scene.key) return;
      this.scene = scene;
      this.staticT = 0;
      this.fitTile();
    }

    /** CSS-координаты клика → клетки мира. */
    toWorld(cssX, cssY) {
      return { x: (cssX * this.dpr + this.cam.x) / (this.T * this.dpr), y: (cssY * this.dpr + this.cam.y) / (this.T * this.dpr) };
    }

    /** Объект под точкой мира (у настенных предметов кликабельна и часть стены над ними). */
    objectAt(pt, filter) {
      if (!this.scene) return null;
      for (const o of this.scene.objects) {
        if (filter && !filter(o)) continue;
        const up = o.wall && !o.bottom ? 0.75 : 0;
        if (pt.x >= o.x && pt.x <= o.x + o.w && pt.y >= o.y - up && pt.y <= o.y + o.h) return o;
      }
      return null;
    }

    /**
     * Нарисовать кадр.
     * s: { you, actors, time, gameMinutes, dark, flashlight, fog: null|'outside'|'leak'|'window', siren,
     *      liftFloor, liftBroken, sealed, residents, target, hover, bubbles, pathEnd, sanity }
     */
    draw(s) {
      const scene = this.scene;
      if (!scene || !this.static) return;
      const ctx = this.ctx;
      const TD = this.T * this.dpr;
      const vw = this.canvas.width, vh = this.canvas.height;
      const t = s.time;

      // камера следует за жильцом
      const sw = scene.w * TD, sh = scene.h * TD;
      const focus = s.you || { x: scene.w / 2, y: scene.h / 2 };
      this.cam.x = sw <= vw ? (sw - vw) / 2 : Math.max(0, Math.min(sw - vw, focus.x * TD - vw / 2));
      this.cam.y = sh <= vh ? (sh - vh) / 2 : Math.max(0, Math.min(sh - vh, focus.y * TD - vh / 2));
      const shake = s.sanity != null && s.sanity < 10 ? Math.sin(t * 37) * 1.5 * this.dpr : 0;
      const cx = Math.round(this.cam.x + shake), cy = Math.round(this.cam.y);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0b0c0c';
      ctx.fillRect(0, 0, vw, vh);
      ctx.drawImage(this.static, -cx, -cy);

      ctx.setTransform(1, 0, 0, 1, -cx, -cy);
      const b = brush(ctx, TD);
      this.drawLive(b, s, t);

      // жильцы — по глубине
      const people = [...(s.actors || [])];
      if (s.you) people.push(s.you);
      people.sort((p1, p2) => p1.y - p2.y);
      for (const a of people) drawCharacter(b, a, t);

      // свет
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawLight(s, cx, cy, TD, t);
      if (s.fog) this.drawFog(s, cx, cy, TD, t);
      if (s.siren) {
        const pulse = (Math.sin(t * 6) + 1) / 2;
        const grad = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.3, vw / 2, vh / 2, Math.max(vw, vh) * 0.75);
        grad.addColorStop(0, 'rgba(160,20,15,0)');
        grad.addColorStop(1, `rgba(170,25,18,${0.15 + pulse * 0.3})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, vw, vh);
      }
      if (s.sanity != null && s.sanity < 25) {
        const k = (25 - s.sanity) / 25;
        const grad = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.25, vw / 2, vh / 2, Math.max(vw, vh) * 0.7);
        grad.addColorStop(0, 'rgba(40,0,50,0)');
        grad.addColorStop(1, `rgba(40,0,50,${0.35 * k + Math.sin(t * 2) * 0.08 * k})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, vw, vh);
      }

      // подписи поверх света
      ctx.setTransform(1, 0, 0, 1, -cx, -cy);
      this.drawOverlay(b, s, people, t);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    /** Живые детали сцены. */
    drawLive(b, s, t) {
      const scene = this.scene;
      for (const o of scene.objects) {
        if (o.type === 'lift') {
          const broken = s.liftBroken;
          const blink = Math.floor(t * 2) % 2;
          b.text(broken ? (blink ? '--' : '') : String(scene.floor), o.x + o.w / 2, o.y - 0.85, 0.19, broken ? '#e05a4f' : '#e3a13b', 'center');
          if (broken) {
            b.g.save();
            b.g.translate((o.x + o.w / 2) * b.T, (o.y - 0.15) * b.T);
            b.g.rotate(-0.08);
            b.rect(-0.7, -0.17, 1.4, 0.34, '#e9e3d0');
            b.text('НЕ РАБОТАЕТ', 0, 0, 0.17, '#b22', 'center');
            b.g.restore();
          }
        } else if (o.type === 'liftpanel') {
          b.text(s.liftFloor != null ? String(s.liftFloor) : '—', o.x + 0.5, o.y - 0.52, 0.15, '#e3a13b');
        } else if (o.type === 'apt' && s.residents) {
          const r = s.residents[o.number];
          if (r && r.name) {
            const label = r.you ? 'ВЫ' : r.name.length > 9 ? `${r.name.slice(0, 8)}…` : r.name;
            b.rrect(o.x - 0.12, o.y - 1.02, 1.24, 0.28, 0.06, 'rgba(20,20,18,0.8)');
            b.text(label, o.x + 0.5, o.y - 0.875, 0.19, r.you ? '#e3a13b' : r.online ? '#cfe9c8' : '#a8a597');
          }
        } else if (o.type === 'hermodoor') {
          const a = s.sealed ? 0.6 : 0;
          b.g.save();
          b.g.translate((o.x + o.w / 2) * b.T, (o.y + 0.5) * b.T);
          b.g.rotate(a);
          for (let i = 0; i < 4; i++) {
            b.g.rotate(Math.PI / 4);
            b.rect(-0.02, -0.24, 0.04, 0.48, '#3e4547');
          }
          b.g.restore();
          b.circle(o.x + o.w - 0.25, o.y + 0.22, 0.07, s.sealed ? '#e05a4f' : '#6fcf6a');
          b.circle(o.x + o.w - 0.25, o.y + 0.22, 0.16, s.sealed ? 'rgba(224,90,79,0.25)' : 'rgba(111,207,106,0.18)');
        } else if (o.type === 'conveyor') {
          const off = (t * 0.8) % 1;
          for (let i = -1; i < o.w; i++) b.rect(o.x + i + off, o.y + 0.22, 0.06, 0.56, '#4b4f4d');
          for (let i = 0; i < o.w; i += 3) b.rect(o.x + ((i + t * 0.8) % o.w), o.y + 0.35, 0.3, 0.3, '#8d9496');
        } else if (o.type === 'counter') {
          for (let i = 0; i < o.w; i += 4) {
            const ph = t * 0.9 + i;
            for (let k = 0; k < 3; k++) {
              const p = (ph + k / 3) % 1;
              b.circle(o.x + i + 0.55 + Math.sin(p * 6 + k) * 0.08, o.y + 0.2 - p * 0.9, 0.06 + p * 0.08, `rgba(230,230,225,${0.25 * (1 - p)})`);
            }
          }
        } else if (o.type === 'clock' && s.gameMinutes != null) {
          const m = s.gameMinutes % 720;
          const cx = o.x + 0.5, cy = o.y - 0.35;
          const ha = (m / 720) * Math.PI * 2 - Math.PI / 2;
          const ma = ((m % 60) / 60) * Math.PI * 2 - Math.PI / 2;
          b.line(cx, cy, cx + Math.cos(ha) * 0.16, cy + Math.sin(ha) * 0.16, '#222', 0.04);
          b.line(cx, cy, cx + Math.cos(ma) * 0.24, cy + Math.sin(ma) * 0.24, '#222', 0.025);
        } else if (o.type === 'window' && s.fogOutside) {
          b.rect(o.x + 0.14, o.y - 0.64, 0.72, 1.08, `rgba(215,222,218,${0.75 + Math.sin(t + o.x) * 0.1})`);
        } else if (o.type === 'window' && s.night) {
          // ночью окна дома напротив гаснут — горит одно-два
          b.rect(o.x + 0.14, o.y - 0.64, 0.72, 1.08, 'rgba(8,10,14,0.72)');
          b.rect(o.x + 0.42, o.y - 0.33, 0.12, 0.14, '#d9b45a');
        } else if (o.type === 'radio') {
          b.circle(o.x + 0.66, o.y - 0.28, 0.025, Math.sin(t * 3) > 0 ? '#e3a13b' : '#5a4020');
        } else if (o.type === 'station' && o.game === 'gauge') {
          const a = Math.PI * (0.8 + 0.5 * Math.sin(t * 1.7) + 0.2 * Math.sin(t * 4.1));
          b.line(o.x + 1, o.y + 0.8, o.x + 1 + Math.cos(a) * 0.2, o.y + 0.8 + Math.sin(a) * 0.2, '#b22', 0.03);
        }
      }
      if (s.pathEnd) {
        const p = (t * 2) % 1;
        b.g.strokeStyle = `rgba(227,161,59,${1 - p})`;
        b.g.lineWidth = Math.max(1, 0.03 * b.T);
        b.g.beginPath();
        b.g.ellipse(s.pathEnd.x * b.T, s.pathEnd.y * b.T, (0.1 + p * 0.25) * b.T, (0.05 + p * 0.1) * b.T, 0, 0, Math.PI * 2);
        b.g.stroke();
      }
    }

    drawLight(s, cx, cy, TD, t) {
      const scene = this.scene;
      const g = this.light.getContext('2d');
      const vw = this.light.width, vh = this.light.height;
      // ночью (22:00–06:00) в коридорах горит каждая вторая лампа и всё чуть темнее
      const ambient = s.dark ? 0.93 : Math.min(0.85, scene.style.ambient + (s.night ? 0.12 : 0));
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, vw, vh);
      g.fillStyle = `rgba(3,4,7,${ambient})`;
      g.fillRect(0, 0, vw, vh);
      g.globalCompositeOperation = 'destination-out';
      const hole = (wx, wy, r, k) => {
        const x = wx * TD - cx, y = wy * TD - cy;
        const grad = g.createRadialGradient(x, y, 0, x, y, r * TD);
        grad.addColorStop(0, `rgba(0,0,0,${k})`);
        grad.addColorStop(0.55, `rgba(0,0,0,${k * 0.6})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(x - r * TD, y - r * TD, r * TD * 2, r * TD * 2);
      };
      const lamps = s.dark ? [] : s.night && scene.kind === 'corridor' ? scene.lamps.filter((_, i) => i % 2 === 0) : scene.lamps;
      const broken = scene.kind === 'corridor' || scene.style.technical ? scene.seed % Math.max(1, lamps.length) : -1;
      const intensities = lamps.map((_, i) => {
        if (i === broken || (scene.style.technical && i % 2 === 0)) {
          const n = Math.sin(t * 13 + i * 7) + Math.sin(t * 29 + i);
          return n > 0.6 ? 0.15 : n > -0.4 ? 0.9 : 0.5;
        }
        return 0.95 + Math.sin(t * 50 + i) * 0.03;
      });
      lamps.forEach(([lx, ly], i) => hole(lx, ly, 3.6, intensities[i]));
      if (s.you) {
        hole(s.you.x, s.you.y - 0.5, s.dark ? 1.1 : 1.4, s.dark ? 0.55 : 0.35);
        if (s.flashlight && s.dark) {
          const d = s.you.d;
          const dx = d === 'left' ? -1.6 : d === 'right' ? 1.6 : 0;
          const dy = d === 'up' ? -1.6 : d === 'down' ? 1.6 : 0;
          hole(s.you.x + dx, s.you.y - 0.4 + dy, 3.2, 0.95);
          hole(s.you.x, s.you.y - 0.4, 1.8, 0.8);
        }
      }
      g.globalCompositeOperation = 'source-over';
      const ctx = this.ctx;
      ctx.drawImage(this.light, 0, 0);
      // тёплый отсвет ламп
      ctx.globalCompositeOperation = 'lighter';
      lamps.forEach(([lx, ly], i) => {
        const x = lx * TD - cx, y = ly * TD - cy;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 2.6 * TD);
        grad.addColorStop(0, `rgba(255,214,150,${0.09 * intensities[i]})`);
        grad.addColorStop(1, 'rgba(255,214,150,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - 2.6 * TD, y - 2.6 * TD, 5.2 * TD, 5.2 * TD);
      });
      ctx.globalCompositeOperation = 'source-over';
    }

    drawFog(s, cx, cy, TD, t) {
      const ctx = this.ctx;
      const vw = this.canvas.width, vh = this.canvas.height;
      const mode = s.fog;
      if (mode === 'window') return; // туман только за окном — нарисован в drawLive
      const strong = mode === 'outside';
      ctx.fillStyle = `rgba(200,210,205,${strong ? 0.38 : 0.16})`;
      ctx.fillRect(0, 0, vw, vh);
      const n = strong ? 16 : 8;
      const sceneW = this.scene.w * TD, sceneH = this.scene.h * TD;
      for (let i = 0; i < n; i++) {
        const seed = W.hash(`fog${i}`);
        const speed = 0.15 + (seed % 100) / 400;
        const size = (2.5 + ((seed >>> 7) % 100) / 30) * TD;
        const span = sceneW + size * 2;
        const wx = (((seed % 1000) / 1000) * span + t * speed * TD) % span - size;
        let wy = (((seed >>> 10) % 1000) / 1000) * sceneH + Math.sin(t * 0.3 + i) * TD * 0.6;
        if (!strong) wy = sceneH - TD * (1 + ((seed >>> 3) % 3)); // сочится от двери
        ctx.globalAlpha = strong ? 0.55 : 0.4;
        ctx.drawImage(this.fogSprite, wx - cx - size, wy - cy - size, size * 2, size * 2);
      }
      ctx.globalAlpha = 1;
    }

    drawOverlay(b, s, people, t) {
      const g = b.g;
      const TD = b.T;
      // цель взаимодействия
      const target = s.target || s.hover;
      if (target) {
        const up = target.wall && !target.bottom ? 0.7 : 0;
        g.strokeStyle = s.target ? 'rgba(227,161,59,0.95)' : 'rgba(227,161,59,0.5)';
        g.lineWidth = Math.max(1, 0.035 * TD);
        g.setLineDash([0.12 * TD, 0.08 * TD]);
        g.lineDashOffset = -t * 0.3 * TD;
        g.strokeRect((target.x - 0.04) * TD, (target.y - up - 0.04) * TD, (target.w + 0.08) * TD, (target.h + up + 0.08) * TD);
        g.setLineDash([]);
      }
      // имена
      const fontPx = Math.max(10 * this.dpr, 0.24 * TD);
      g.font = `700 ${fontPx}px "PT Sans", Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      for (const a of people) {
        if (a.sleep && !a.down) continue;
        const label = a.down ? `${a.name} · без сознания` : a.away ? `${a.name} · не в сети` : a.name;
        const nx = a.x * TD, ny = (a.down ? a.y - 0.45 : a.y - 1.15) * TD;
        const wName = g.measureText(label).width + 8 * this.dpr;
        g.fillStyle = 'rgba(10,11,11,0.6)';
        roundRect(g, nx - wName / 2, ny - fontPx - 2 * this.dpr, wName, fontPx + 4 * this.dpr, 4 * this.dpr);
        g.fill();
        g.fillStyle = a.down ? '#ff9b90' : a.self ? '#e3a13b' : a.away ? '#a8a597' : '#e9e3d0';
        g.fillText(label, nx, ny + this.dpr);
      }
      // облачка реплик
      const now = s.now;
      const bubbleFont = Math.max(11 * this.dpr, 0.26 * TD);
      g.font = `400 ${bubbleFont}px "PT Sans", Arial, sans-serif`;
      for (const a of people) {
        const bub = s.bubbles && s.bubbles.get(a.id);
        if (!bub || bub.until < now) continue;
        const fade = Math.min(1, (bub.until - now) / 600);
        const lines = wrapText(g, bub.text, 3.6 * TD);
        const lh = bubbleFont * 1.2;
        const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + 14 * this.dpr;
        const bh = lines.length * lh + 10 * this.dpr;
        const bx = a.x * TD - bw / 2, by = (a.y - 1.5) * TD - bh - fontPx;
        g.globalAlpha = fade;
        g.fillStyle = bub.ghost ? 'rgba(40,20,50,0.92)' : 'rgba(236,232,220,0.95)';
        roundRect(g, bx, by, bw, bh, 6 * this.dpr);
        g.fill();
        g.beginPath();
        g.moveTo(a.x * TD - 5 * this.dpr, by + bh);
        g.lineTo(a.x * TD + 5 * this.dpr, by + bh);
        g.lineTo(a.x * TD, by + bh + 7 * this.dpr);
        g.fill();
        g.fillStyle = bub.ghost ? '#d9cbe8' : '#1d1f1e';
        g.textBaseline = 'top';
        lines.forEach((l, i) => g.fillText(l, a.x * TD, by + 5 * this.dpr + i * lh));
        g.textBaseline = 'bottom';
        g.globalAlpha = 1;
      }
    }
  }

  global.Renderer = Renderer;
  global.lookFor = lookFor;
})(typeof window !== 'undefined' ? window : globalThis);
