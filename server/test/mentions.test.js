// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
// Usa un envío de notificaciones falso (no manda nada de verdad).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as webpush from 'web-push';
import { base, call, makeUser } from './helpers.js';
import { pool } from '../src/db.js';
import { mentionedIds, transport } from '../src/push.js';

Object.assign(process.env, (({ publicKey, privateKey }) => ({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey }))(webpush.generateVAPIDKeys()));
process.env.ORIGIN ??= 'https://amigos.example';
const sent = [];
transport.send = async (sub, payload) => sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });

async function subscribe(u) {
  const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
  await call(u, '/push/subscribe', { json: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  return endpoint;
}
const settle = () => new Promise((r) => setTimeout(r, 300));
const titles = (ep) => sent.filter((s) => s.endpoint === ep).map((s) => s.title);
async function post(u, body, scope = 'feed') {
  const form = new FormData();
  form.append('body', body);
  form.append('scope', scope);
  return (await (await fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form })).json()).id;
}

test('menciones: qué cuenta como mención', async () => {
  const [a, b] = [await makeUser(), await makeUser()];
  const both = await mentionedIds(`hola @${a.username} y @${b.username.toUpperCase()}!`);
  assert.deepEqual(both.sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y), 'sin importar mayúsculas');
  assert.deepEqual(await mentionedIds(`escribime a mail@${a.username}.com`), [], 'un mail no es mención');
  assert.deepEqual(await mentionedIds(`(w)@${a.username}`), [a.id], 'después de una "w" también cuenta');
  assert.deepEqual(await mentionedIds('@no_existe_nadie_jamas'), []);
  assert.deepEqual(await mentionedIds(`@${a.username}`, [a.id]), [], 'se puede excluir al autor');

  const { users } = await (await call(a, '/users')).json();
  assert.ok(users.some((u) => u.username === b.username));
  assert.deepEqual(Object.keys(users[0]).sort(), ['avatar', 'display_name', 'id', 'username'], 'solo datos públicos');
  await pool.execute('UPDATE users SET deleted_at = NOW(), is_active = 0 WHERE id = ?', [b.id]);
  assert.ok(!(await (await call(a, '/users')).json()).users.some((u) => u.id === b.id), 'sin cuentas eliminadas');
});

test('menciones: avisos en posts y comentarios, sin duplicar', async () => {
  const [ana, beto, caro, dani] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
  const [epA, epB, epC, epD] = [await subscribe(ana), await subscribe(beto), await subscribe(caro), await subscribe(dani)];
  const nameOf = (u) => `Test ${u.username}`;

  // Post en el feed que menciona a beto: beto recibe "te mencionó" (no "publicó"); caro y dani, "publicó".
  const postId = await post(ana, `¿vamos @${beto.username}?`);
  await settle();
  assert.deepEqual(titles(epB), [`${nameOf(ana)} te mencionó`]);
  assert.deepEqual(titles(epC), [`${nameOf(ana)} publicó`]);
  assert.deepEqual(titles(epA), [], 'el autor no recibe nada');

  // Comentario de caro que menciona a ana (dueña del post) y a dani: ana solo "comentó tu post", dani "te mencionó".
  sent.length = 0;
  await call(caro, `/posts/${postId}/comments`, { json: { body: `@${ana.username} @${dani.username} yo llevo hielo` } });
  await settle();
  assert.deepEqual(titles(epA), [`${nameOf(caro)} comentó tu post`]);
  assert.deepEqual(titles(epD), [`${nameOf(caro)} te mencionó`]);

  // Post de perfil con mención: avisa al mencionado y lleva al perfil del autor.
  sent.length = 0;
  await post(dani, `gracias @${caro.username}`, 'profile');
  await settle();
  const toCaro = sent.find((s) => s.endpoint === epC);
  assert.equal(toCaro.title, `${nameOf(dani)} te mencionó`);
  assert.equal(toCaro.url, `/u/${dani.username}`);
  assert.deepEqual(titles(epB), [], 'un post de perfil no avisa al resto');

  // Si apagó las menciones, le llega el aviso general en lugar de ninguno.
  sent.length = 0;
  await call(beto, '/me/notifications', { method: 'PATCH', json: { mentions: false } });
  await post(ana, `otra vez @${beto.username}`);
  await settle();
  assert.deepEqual(titles(epB), [`${nameOf(ana)} publicó`]);
});
