'use strict';

const fs = require('fs');
const path = require('path');

/** Файл мира есть, но прочитать его нельзя. Сервер в этом случае не стартует, чтобы не затереть дом пустым. */
class CorruptSaveError extends Error {}

/**
 * Загрузить сохранённый мир.
 * null — сохранения ещё нет (новый мир). Битый файл — исключение CorruptSaveError.
 */
function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CorruptSaveError(`Не удалось прочитать ${file}: ${err.message}`);
  }
  try {
    const state = JSON.parse(text);
    if (!state || typeof state !== 'object') throw new Error('внутри не объект');
    return state;
  } catch (err) {
    throw new CorruptSaveError(`Файл мира ${file} повреждён: ${err.message}`);
  }
}

/** Атомарная запись: сначала во временный файл, потом rename — чтобы не получить полфайла при падении. */
function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/**
 * Резервная копия текущего файла мира в dir (имя с датой и часом).
 * Хранятся последние keep копий. Возвращает путь копии или null, если копировать нечего.
 */
function backup(file, dir, keep = 48, now = new Date()) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const target = path.join(dir, `world-${stamp}.json`);
  fs.copyFileSync(file, target);
  const copies = fs
    .readdirSync(dir)
    .filter((f) => /^world-.*\.json$/.test(f))
    .sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) fs.unlinkSync(path.join(dir, old));
  return target;
}

/** Самая свежая резервная копия (для подсказки при битом сохранении). */
function latestBackup(dir) {
  try {
    const copies = fs.readdirSync(dir).filter((f) => /^world-.*\.json$/.test(f)).sort();
    return copies.length ? path.join(dir, copies[copies.length - 1]) : null;
  } catch {
    return null;
  }
}

module.exports = { load, save, backup, latestBackup, CorruptSaveError };
