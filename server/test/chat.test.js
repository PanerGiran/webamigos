// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, makeUser, port } from './helpers.js';

// Si un test falla a la mitad, igual se cierran las conexiones (si no, el proceso de tests no termina nunca).
const sockets = [];
after(() => sockets.forEach((ws) => ws.close()));

// Cliente de prueba: junta los mensajes y deja esperar uno de cierto tipo.
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const inbox = [];
  const waiters = new Set();
  ws.onmessage = (e) => {
    inbox.push(JSON.parse(e.data));
    [...waiters].forEach((w) => w());
  };
  const closed = new Promise((resolve) => (ws.onclose = (e) => resolve(e.code)));
  const opened = new Promise((resolve) => (ws.onopen = resolve));
  const next = (type, where = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => (waiters.delete(check), reject(new Error(`no llegó "${type}"`))), 3000);
      function check() {
        const i = inbox.findIndex((m) => m.type === type && where(m));
        if (i < 0) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(inbox.splice(i, 1)[0]);
      }
      waiters.add(check);
      check();
    });
  const send = (o) => ws.send(JSON.stringify(o));
  return { ws, opened, closed, next, send };
}

// Los mensajes se mandan por HTTP y llegan a todos por la conexión en vivo.
const say = (u, body, reply_to) => call(u, '/messages', { json: { body, ...(reply_to && { reply_to }) } });

test('chat: token inválido o sin autenticar → se cierra', async () => {
  const bad = client();
  await bad.opened;
  bad.send({ type: 'auth', token: 'cualquiera' });
  assert.equal(await bad.closed, 4001);

  const silent = client();
  await silent.opened;
  assert.equal(await silent.closed, 4001, 'se cierra a los 5 s si no se autentica');
});

test('chat: mensajes en vivo, historial y presencia', async () => {
  const [ana, beto] = [await makeUser(), await makeUser()];
  const a = client();
  const b = client();
  await Promise.all([a.opened, b.opened]);
  a.send({ type: 'auth', token: ana.token });
  b.send({ type: 'auth', token: beto.token });
  assert.equal((await a.next('ready')).user.id, ana.id);
  await b.next('ready');
  await a.next('presence', (m) => m.users.some((u) => u.id === beto.id) && m.users.some((u) => u.id === ana.id));

  assert.equal((await say(ana, '  hola grupo  ')).status, 201);
  const [toA, toB] = await Promise.all([a.next('message'), b.next('message')]);
  assert.equal(toB.message.body, 'hola grupo');
  assert.equal(toB.message.user_id, ana.id);
  assert.equal(toA.message.id, toB.message.id);

  const empty = await say(beto, '   ');
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /vacío/);
  assert.equal((await say(beto, 'x'.repeat(2001))).status, 400);

  const { messages } = await (await call(beto, '/messages')).json();
  assert.equal(messages.at(-1).id, toA.message.id, 'quedó en el historial');
  assert.equal(messages.at(-1).display_name, `Test ${ana.username}`);
  assert.equal((await call(null, '/messages')).status, 401);

  b.ws.close();
  await a.next('presence', (m) => !m.users.some((u) => u.id === beto.id));
  a.ws.close();
  await a.closed;
});

test('chat: límite de 10 mensajes cada 10 s por persona', async () => {
  const [u, otro] = [await makeUser(), await makeUser()];
  for (let i = 0; i < 10; i++) assert.equal((await say(u, `m${i}`)).status, 201);
  const slow = await say(u, 'uno más');
  assert.equal(slow.status, 429);
  assert.match((await slow.json()).error, /despacio/);
  assert.equal((await say(otro, 'hola')).status, 201, 'a los demás no los frena');
});

test('chat: responder y reaccionar, en vivo y en el historial', async () => {
  const [ana, beto] = [await makeUser(), await makeUser()];
  const a = client();
  const b = client();
  await Promise.all([a.opened, b.opened]);
  a.send({ type: 'auth', token: ana.token });
  b.send({ type: 'auth', token: beto.token });
  await Promise.all([a.next('ready'), b.next('ready')]);

  await say(ana, '¿pizza o asado?');
  const original = (await b.next('message', (m) => m.message.body === '¿pizza o asado?')).message;
  assert.equal(original.reply, null);
  assert.deepEqual(original.reactions, []);

  // Responder: llega con la cita del original.
  await say(beto, 'asado obvio', original.id);
  const reply = (await a.next('message', (m) => m.message.body === 'asado obvio')).message;
  assert.deepEqual(reply.reply, { id: original.id, body: '¿pizza o asado?', username: ana.username, display_name: `Test ${ana.username}` });

  // Responder a algo que no existe: se manda igual, sin cita.
  await say(beto, 'sin cita', 999999999);
  assert.equal((await a.next('message', (m) => m.message.body === 'sin cita')).message.reply, null);

  // Reaccionar: a los dos les llega el resumen con quién reaccionó.
  // De a uno y esperando cada aviso: si no, el orden entre las dos conexiones no está garantizado.
  const fireIs = (ids) => (m) => m.message_id === original.id && m.reactions[0]?.user_ids.slice().sort().join() === ids.slice().sort().join();
  b.send({ type: 'react', message_id: original.id, emoji: '🔥', on: true });
  await a.next('reactions', fireIs([beto.id]));
  a.send({ type: 'react', message_id: original.id, emoji: '🔥', on: true });
  const both = await a.next('reactions', fireIs([ana.id, beto.id]));
  assert.deepEqual(both.reactions[0].user_ids.sort(), [ana.id, beto.id].sort());
  b.send({ type: 'react', message_id: original.id, emoji: '🔥', on: false });
  const one = await a.next('reactions', fireIs([ana.id]));
  assert.deepEqual(one.reactions, [{ emoji: '🔥', count: 1, user_ids: [ana.id] }]);
  b.send({ type: 'react', message_id: original.id, emoji: '💩', on: true });
  assert.match((await b.next('error')).error, /inválida/);

  // El historial trae la cita y las reacciones.
  const { messages } = await (await call(beto, '/messages')).json();
  const h1 = messages.find((m) => m.id === original.id);
  const h2 = messages.find((m) => m.id === reply.id);
  assert.deepEqual(h1.reactions, [{ emoji: '🔥', count: 1, user_ids: [ana.id] }]);
  assert.equal(h2.reply.id, original.id);
  a.ws.close();
  b.ws.close();
  await Promise.all([a.closed, b.closed]);
});
