'use strict';

/*
 * Вид жильца изменениями — общий код сервера и браузера.
 *   diff(prevParts, view) → { parts, patch }: patch = null, если ничего не поменялось;
 *                           prevParts = null — первый раз, вид уходит целиком (patch.full).
 *   apply(oldView, patch) → новый вид (старый объект не меняется).
 * Сравниваем верхний уровень, а в разделах you / world / here — их поля по отдельности:
 * за секунду обычно меняются часы и параметры, остальное (журнал, памятка, разряды) — нет.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ViewPatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEEP = new Set(['you', 'world', 'here']);
  const isSection = (k, v) => DEEP.has(k) && v && typeof v === 'object' && !Array.isArray(v);

  function diff(prev, view) {
    const parts = new Map(); // путь → JSON
    for (const [k, v] of Object.entries(view)) {
      if (v === undefined) continue;
      if (isSection(k, v)) {
        parts.set(k, '{}');
        for (const [sk, sv] of Object.entries(v)) if (sv !== undefined) parts.set(`${k}.${sk}`, JSON.stringify(sv));
      } else parts.set(k, JSON.stringify(v));
    }
    if (!prev) return { parts, patch: { full: view } };
    const set = {};
    const del = [];
    for (const [path, json] of parts) {
      if (prev.get(path) === json) continue;
      const [a, b] = path.split('.');
      set[path] = b === undefined ? (isSection(a, view[a]) ? {} : view[a]) : view[a][b];
    }
    for (const path of prev.keys()) if (!parts.has(path)) del.push(path);
    return { parts, patch: Object.keys(set).length || del.length ? { set, del } : null };
  }

  function apply(old, patch) {
    if (patch.full) return patch.full;
    const v = { ...old };
    const fresh = new Set(); // разделы, уже скопированные: старый объект не трогаем
    const section = (a) => {
      if (!fresh.has(a)) {
        v[a] = v[a] && typeof v[a] === 'object' ? { ...v[a] } : {};
        fresh.add(a);
      }
      return v[a];
    };
    const set = patch.set || {};
    // сначала разделы целиком, потом их поля
    for (const path of Object.keys(set).sort((x, y) => x.split('.').length - y.split('.').length)) {
      const [a, b] = path.split('.');
      if (b === undefined) {
        v[a] = set[path];
        fresh.add(a);
      } else section(a)[b] = set[path];
    }
    for (const path of patch.del || []) {
      const [a, b] = path.split('.');
      if (b === undefined) delete v[a];
      else if (v[a] && typeof v[a] === 'object') delete section(a)[b];
    }
    return v;
  }

  return { diff, apply };
});
