// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
// Avisos en vivo por el WebSocket (los que aparecen abajo a la derecha con la app abierta).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { base, makeUser, port } from './helpers.js';

const sockets = [];
after(() => sockets.forEach((ws) => ws.close()));

// Conecta a alguien y junta lo que le llega.
async function connect(u) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const inbox = [];
  await new Promise((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: u.token }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'ready') resolve();
      inbox.push(m);
    };
  });
  return inbox;
}
async function post(u, body) {
  const form = new FormData();
  form.append('body', body);
  await fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
}
const settle = () => new Promise((r) => setTimeout(r, 400));
const notifies = (inbox, fromUser) => inbox.filter((m) => m.type === 'notify' && m.from.username === fromUser.username);

test('avisos en vivo: post nuevo y mención, sin duplicar ni avisarte lo tuyo', async () => {
  const [ana, beto, caro] = [await makeUser(), await makeUser(), await makeUser()];
  const [inA, inB, inC] = [await connect(ana), await connect(beto), await connect(caro)];

  await post(beto, `hola @${caro.username}, ¿venís?`);
  await settle();
  const toAna = notifies(inA, beto);
  assert.deepEqual(toAna.map((m) => m.kind), ['post'], 'ana: post nuevo');
  assert.equal(toAna[0].from.display_name, `Test ${beto.username}`);
  assert.equal(toAna[0].url, '/');
  assert.ok(toAna[0].text.includes('¿venís?'));
  assert.deepEqual(notifies(inC, beto).map((m) => m.kind), ['mention'], 'caro: solo la mención, no además "post nuevo"');
  assert.deepEqual(notifies(inB, beto), [], 'beto no recibe aviso de lo suyo');
});
