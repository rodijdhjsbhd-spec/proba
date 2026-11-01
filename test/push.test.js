'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Push = require('../server/push');

const b = (s) => Buffer.from(s, 'base64url');

/** Телефон: ключи подписки и расшифровка сообщения (RFC 8291 со стороны браузера). */
function makeDevice() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    decrypt(body) {
      const salt = body.subarray(0, 16);
      const idlen = body[20];
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, info, 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain[plain.length - 1], 2, 'разделитель последней записи');
      return plain.subarray(0, plain.length - 1).toString();
    },
  };
}

test('шифрование пуша совпадает с примером из RFC 8291', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'));
  const out = Push.encrypt('When I grow up, I want to be a watermelon', { p256dh: ua.getPublicKey().toString('base64url'), auth: 'BTBZMqHH6r4Tts7J_aSIgg' }, {
    salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
    asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  });
  assert.equal(
    out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('подписка: только https и известные пуш-службы, ключи нужной длины', () => {
  const dev = makeDevice();
  const ok = Push.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: dev.keys, extra: 'мусор' });
  assert.deepEqual(Object.keys(ok).sort(), ['endpoint', 'keys']);
  assert.ok(Push.cleanSubscription({ endpoint: 'https://web.push.apple.com/QWE', keys: dev.keys }));
  assert.ok(Push.cleanSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys: dev.keys }));
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc', // не https
    'https://127.0.0.1/steal', // внутренний адрес
    'https://evil.example/fcm.googleapis.com', // служба только в пути
    'https://fcm.googleapis.com.evil.example/x', // похожее имя
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'не адрес',
  ]) assert.equal(Push.cleanSubscription({ endpoint, keys: dev.keys }), null, endpoint);
  assert.equal(Push.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AAAA', auth: dev.keys.auth } }), null);
  assert.equal(Push.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x' }), null);
  assert.equal(Push.cleanSubscription(null), null);
  // свои службы — через PUSH_HOSTS
  assert.ok(Push.cleanSubscription({ endpoint: 'https://push.example.ru/x', keys: dev.keys }, Push.allowedHosts('push.example.ru')));
});

test('отправка: подпись VAPID, телефон расшифровывает, 410 — подписка умерла', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const vapid = Push.vapidFromJwk(privateKey.export({ format: 'jwk' }), 'mailto:zhek@example.ru');
  const dev = makeDevice();
  const sub = Push.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: dev.keys });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { status: calls.length === 1 ? 201 : 410 };
  };
  assert.equal(await Push.send(vapid, sub, { title: 'СИРЕНА', body: 'дверь открыта' }, { urgency: 'high', topic: 'fog', fetchImpl }), 'ok');
  const { opts } = calls[0];
  assert.equal(opts.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(opts.headers.Urgency, 'high');
  assert.equal(opts.headers.Topic, 'fog');
  assert.deepEqual(JSON.parse(dev.decrypt(opts.body)), { title: 'СИРЕНА', body: 'дверь открыта' });
  // подпись VAPID проверяется открытым ключом сервера
  const [, jwt, k] = opts.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(b(c).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:zhek@example.ru');
  const pub = b(vapid.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b(s)));
  assert.equal(await Push.send(vapid, sub, { title: 'x' }, { fetchImpl }), 'gone');
  assert.equal(await Push.send(vapid, sub, { title: 'x' }, { fetchImpl: async () => { throw new Error('сеть'); } }), 'error');
});
