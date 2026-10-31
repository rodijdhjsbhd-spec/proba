'use strict';

const fs = require('fs');
const path = require('path');

/** Загрузить сохранённый мир (или null, если сохранения нет / оно битое). */
function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[storage] Не удалось прочитать ${file}: ${err.message}`);
    return null;
  }
}

/** Атомарная запись: сначала во временный файл, потом rename — чтобы не получить полфайла при падении. */
function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

module.exports = { load, save };
