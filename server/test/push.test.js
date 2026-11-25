// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
// No manda nada de verdad: reemplaza el envío por uno falso que anota a quién le llegaría cada aviso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as webpush from 'web-push';
import { base, call, makeUser, port } from './helpers.js';
import { pool } from '../src/db.js';
import { transport } from '../src/push.js';

Object.assign(process.env, (({ publicKey, privateKey }) => ({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey }))(webpush.generateVAPIDKeys()));
process.env.ORIGIN ??= 'https://amigos.example';

const sent = []; // { endpoint, title, body, url, tag }
const gone = new Set(); // endpoints que el "navegador" dio de baja
transport.send = async (sub, payload) => {
  if (gone.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
  sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
};

async function subscribe(u) {
  const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
  const res = await call(u, '/push/subscribe', { json: { endpoint, keys: { p256dh: 'clave-p256dh', auth: 'clave-auth' } } });
  assert.equal(res.status, 204);
  return endpoint;
}
// Los avisos salen sin esperar a la respuesta: se espera un poco a que lleguen al envío falso.
const settle = () => new Promise((r) => setTimeout(r, 300));
const got = (endpoint, title) => sent.some((s) => s.endpoint === endpoint && s.title.includes(title));
const nameOf = (u) => `Test ${u.username}`;
async function post(u, body, scope = 'feed') {
  const form = new FormData();
  form.append('body', body);
  form.append('scope', scope);
  const res = await fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
  return (await res.json()).id;
}

test('push: clave pública y validación de la suscripción', async () => {
  const u = await makeUser();
  assert.equal((await (await call(u, '/push/key')).json()).key, process.env.VAPID_PUBLIC_KEY);
  assert.equal((await call(u, '/push/subscribe', { json: { endpoint: 'http://inseguro.test/x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
  assert.equal((await call(null, '/push/key')).status, 401);
});

test('push: posts del feed, comentarios, preferencias y sesión cerrada', async () => {
  const [ana, beto, caro] = [await makeUser(), await makeUser(), await makeUser()];
  const [epA, epB, epC] = [await subscribe(ana), await subscribe(beto), await subscribe(caro)];

  // Post en el feed: les llega a los demás, no a quien publicó.
  const postId = await post(ana, 'hola a todos');
  await settle();
  assert.ok(got(epB, `${nameOf(ana)} publicó`) && got(epC, `${nameOf(ana)} publicó`));
  assert.ok(!got(epA, `${nameOf(ana)} publicó`));
  assert.equal(sent.find((s) => s.endpoint === epB && s.title.includes(nameOf(ana))).body, 'hola a todos');

  // Post de perfil: no avisa a nadie.
  await post(beto, 'mi rincón', 'profile');
  await settle();
  assert.ok(!sent.some((s) => s.title.includes(`${nameOf(beto)} publicó`)));

  // Comentario: solo al autor del post, y no si comenta su propio post.
  await call(beto, `/posts/${postId}/comments`, { json: { body: 'buenísimo' } });
  await call(ana, `/posts/${postId}/comments`, { json: { body: 'gracias' } });
  await settle();
  assert.ok(got(epA, `${nameOf(beto)} comentó tu post`));
  assert.ok(!got(epC, `${nameOf(beto)} comentó`));
  assert.ok(!sent.some((s) => s.title.includes(`${nameOf(ana)} comentó`)));

  // Preferencias: caro apaga los posts.
  assert.equal((await call(caro, '/me/notifications', { method: 'PATCH', json: { posts: false } })).status, 204);
  assert.deepEqual(await (await call(caro, '/me/notifications')).json(), { posts: false, comments: true, chat: true, mentions: true });
  await post(beto, 'segundo post');
  await settle();
  assert.ok(got(epA, `${nameOf(beto)} publicó`));
  assert.ok(!got(epC, `${nameOf(beto)} publicó`), 'caro los apagó');

  // Al cerrar sesión, ese dispositivo deja de recibir avisos.
  await call(beto, '/logout', { method: 'POST' });
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?', [epB]);
  assert.equal(n, 0, 'la suscripción se fue con la sesión');

  // Si el navegador la dio de baja (410), se borra.
  gone.add(epC);
  await call(caro, '/me/notifications', { method: 'PATCH', json: { posts: true } });
  await post(ana, 'tercer post');
  await settle();
  const [[{ n: left }]] = await pool.execute('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?', [epC]);
  assert.equal(left, 0);
});

test('push: el chat avisa solo a quien no lo tiene abierto', async () => {
  const [ana, beto, caro] = [await makeUser(), await makeUser(), await makeUser()];
  const [epB, epC] = [await subscribe(beto), await subscribe(caro)];
  const connect = (u) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: u.token }));
      ws.onmessage = (e) => JSON.parse(e.data).type === 'ready' && resolve(ws);
    });
  const [wsAna, wsCaro] = [await connect(ana), await connect(caro)]; // caro tiene el chat abierto, beto no
  assert.equal((await call(ana, '/messages', { json: { body: '¿quién viene?' } })).status, 201);
  await settle();
  assert.ok(got(epB, `${nameOf(ana)} en el chat`));
  assert.equal(sent.find((s) => s.endpoint === epB && s.title.includes(nameOf(ana))).tag, 'chat');
  assert.ok(!got(epC, `${nameOf(ana)} en el chat`), 'caro lo está viendo');
  wsAna.close();
  wsCaro.close();
});
