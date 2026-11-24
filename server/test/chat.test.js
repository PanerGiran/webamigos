// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, makeUser, port } from './helpers.js';

// Cliente de prueba: junta los mensajes y deja esperar uno de cierto tipo.
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

  a.send({ type: 'message', body: '  hola grupo  ' });
  const [toA, toB] = await Promise.all([a.next('message'), b.next('message')]);
  assert.equal(toB.message.body, 'hola grupo');
  assert.equal(toB.message.user_id, ana.id);
  assert.equal(toA.message.id, toB.message.id);

  b.send({ type: 'message', body: '   ' });
  assert.match((await b.next('error')).error, /vacío/);
  b.send({ type: 'message', body: 'x'.repeat(2001) });
  await b.next('error');

  const { messages } = await (await call(beto, '/messages')).json();
  assert.equal(messages.at(-1).id, toA.message.id, 'quedó en el historial');
  assert.equal(messages.at(-1).display_name, `Test ${ana.username}`);
  assert.equal((await call(null, '/messages')).status, 401);

  b.ws.close();
  await a.next('presence', (m) => !m.users.some((u) => u.id === beto.id));
  a.ws.close();
  await a.closed;
});

test('chat: límite de 10 mensajes cada 10 s', async () => {
  const u = await makeUser();
  const c = client();
  await c.opened;
  c.send({ type: 'auth', token: u.token });
  await c.next('ready');
  for (let i = 0; i < 11; i++) c.send({ type: 'message', body: `m${i}` });
  assert.match((await c.next('error')).error, /despacio/);
  c.ws.close();
  await c.closed;
});
