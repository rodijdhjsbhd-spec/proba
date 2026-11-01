'use strict';

/*
 * Web Push без сторонних библиотек: только node:crypto и fetch.
 *   - VAPID (RFC 8292): ключ P-256 хранится в data/vapid.json, подпись ES256.
 *   - Шифрование содержимого (RFC 8291, aes128gcm по RFC 8188).
 * Сервер шлёт пуш только на адреса известных пуш-служб (PUSH_HOSTS расширяет список),
 * иначе любой жилец мог бы заставить сервер стучаться на произвольный адрес.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge, Android
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari, iPhone (web.push.apple.com)
  'notify.windows.com', // старый Edge
];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

/** Ключи VAPID: из файла, иначе создать и сохранить (только владельцу). */
function loadVapid(file, subject) {
  let jwk = null;
  try {
    jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* нет файла — создадим */
  }
  if (!jwk || jwk.kty !== 'EC' || !jwk.d) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  return vapidFromJwk(jwk, subject);
}

function vapidFromJwk(jwk, subject = 'mailto:zhek@localhost') {
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  return { privateKey, publicKey, subject };
}

/** Подпись VAPID для конкретной пуш-службы (aud — её origin). */
function vapidAuth(vapid, endpoint, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: vapid.subject }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/**
 * Зашифровать сообщение для подписки (RFC 8291). salt и asPrivate — только для проверки
 * по эталонному примеру; в работе они случайные на каждое сообщение.
 */
function encrypt(plaintext, keys, { salt = crypto.randomBytes(16), asPrivate = null } = {}) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh');
  if (authSecret.length !== 16) throw new Error('bad auth');
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, secret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Разрешённые пуш-службы: стандартные + PUSH_HOSTS (через запятую). */
function allowedHosts(extra = process.env.PUSH_HOSTS) {
  return [...DEFAULT_HOSTS, ...String(extra || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)];
}

/** Проверить подписку из браузера; вернуть чистую копию или null. */
function cleanSubscription(sub, hosts = allowedHosts()) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return null;
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  const keys = sub.keys || {};
  const p256dh = fromB64u(keys.p256dh);
  const auth = fromB64u(keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
  return { endpoint: url.href, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } };
}

/**
 * Отправить пуш. Возвращает 'ok' | 'gone' (подписка умерла — удалить) | 'error'.
 * fetchImpl подменяется в тестах.
 */
async function send(vapid, sub, message, { ttl = 3600, urgency = 'normal', topic = null, fetchImpl = globalThis.fetch } = {}) {
  const body = encrypt(JSON.stringify(message), sub.keys);
  const headers = {
    Authorization: vapidAuth(vapid, sub.endpoint),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.round(ttl))),
    Urgency: urgency,
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try {
    const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.status >= 200 && res.status < 300 ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

module.exports = { loadVapid, vapidFromJwk, vapidAuth, encrypt, cleanSubscription, allowedHosts, send };
