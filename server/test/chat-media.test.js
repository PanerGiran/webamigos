// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
// Chat con fotos, audios y encuestas (por HTTP) que llegan en vivo a todos por el WebSocket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { base, call, makeUser, port } from './helpers.js';

const sockets = [];
after(() => sockets.forEach((ws) => ws.close()));

async function connect(u) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const inbox = [];
  const waiters = new Set();
  await new Promise((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: u.token }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'ready') resolve();
      inbox.push(m);
      [...waiters].forEach((w) => w());
    };
  });
  // Espera el primer evento que cumpla `where` (y lo saca de la cola).
  return (where) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => (waiters.delete(check), reject(new Error('no llegó el evento'))), 3000);
      function check() {
        const i = inbox.findIndex(where);
        if (i < 0) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(inbox.splice(i, 1)[0]);
      }
      waiters.add(check);
      check();
    });
}

function sendMessage(u, { body, file, type = 'image/png', poll, reply_to } = {}) {
  const form = new FormData();
  if (body !== undefined) form.append('body', body);
  if (file) form.append('file', new Blob([file], { type }), 'f');
  if (poll) form.append('poll', JSON.stringify(poll));
  if (reply_to) form.append('reply_to', String(reply_to));
  return fetch(`${base}/messages`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
}

test('chat: foto y audio llegan en vivo y quedan en el historial', async () => {
  const [ana, beto] = [await makeUser(), await makeUser()];
  const nextB = await connect(beto);
  const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#0a0' } }).png().toBuffer();

  let res = await sendMessage(ana, { body: 'mirá esto', file: png });
  assert.equal(res.status, 201);
  const { message } = await res.json();
  const live = (await nextB((m) => m.type === 'message' && m.message.id === message.id)).message;
  assert.equal(live.media.kind, 'image');
  assert.equal(live.body, 'mirá esto');
  assert.equal(live.user_id, ana.id);

  // Audio grabado (webm): sin texto y respondiendo a la foto.
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]);
  res = await sendMessage(ana, { file: webm, type: 'audio/webm', reply_to: message.id });
  assert.equal(res.status, 201);
  const audio = (await res.json()).message;
  assert.deepEqual([audio.media.kind, audio.media.mime, audio.body, audio.reply.id], ['audio', 'audio/webm', '', message.id]);
  assert.equal((await nextB((m) => m.type === 'message' && m.message.id === audio.id)).message.media.kind, 'audio');
  const served = await fetch(`${base}/media/${audio.media.filename}`, { headers: { authorization: `Bearer ${beto.token}` } });
  assert.equal(served.headers.get('content-type'), 'audio/webm');

  const { messages } = await (await call(beto, '/messages')).json();
  assert.ok(messages.some((m) => m.id === message.id && m.media?.kind === 'image'), 'en el historial');

  assert.equal((await sendMessage(ana, {})).status, 400, 'vacío');
  assert.equal((await sendMessage(ana, { file: Buffer.from('no soy nada'), type: 'audio/webm' })).status, 400, 'adjunto falso');
});

test('chat: encuestas con votos en vivo', async () => {
  const [ana, beto] = [await makeUser(), await makeUser()];
  const [nextA, nextB] = [await connect(ana), await connect(beto)];

  let res = await sendMessage(ana, { body: '¿Pizza o asado?', poll: ['Pizza', 'Asado'] });
  assert.equal(res.status, 201);
  const { message } = await res.json();
  const live = (await nextB((m) => m.type === 'message' && m.message.id === message.id)).message;
  assert.deepEqual(live.poll.options.map((o) => [o.text, o.votes]), [['Pizza', 0], ['Asado', 0]]);
  const [pizza, asado] = live.poll.options.map((o) => o.id);

  const vote = (u, option_id) => call(u, `/messages/${message.id}/vote`, { method: 'PUT', json: { option_id } });
  assert.equal((await vote(beto, asado)).status, 200);
  let ev = await nextA((m) => m.type === 'poll' && m.message_id === message.id);
  assert.deepEqual(ev.poll.options.map((o) => o.user_ids), [[], [beto.id]], 'a ana le llega el voto de beto');
  await vote(beto, pizza);
  ev = await nextA((m) => m.type === 'poll' && m.poll.options[0].votes === 1);
  assert.equal(ev.poll.total, 1, 'cambiar el voto no suma dos');
  await vote(beto, null);
  ev = await nextA((m) => m.type === 'poll' && m.poll.total === 0);
  assert.equal(ev.poll.total, 0);

  const other = (await (await sendMessage(ana, { body: '¿Otra?', poll: ['Sí', 'No'] })).json()).message;
  assert.equal((await call(beto, `/messages/${other.id}/vote`, { method: 'PUT', json: { option_id: other.poll.options[0].id } })).status, 200);
  assert.equal((await call(beto, `/messages/${message.id}/vote`, { method: 'PUT', json: { option_id: other.poll.options[0].id } })).status, 400, 'opción de otra encuesta');
  assert.equal((await sendMessage(ana, { poll: ['a', 'b'] })).status, 400, 'sin pregunta');
  assert.equal((await sendMessage(ana, { body: '¿?', poll: ['solo una'] })).status, 400);
});

test('chat: borrar un mensaje (el autor o un admin) desaparece en vivo y se lleva su adjunto', async () => {
  const [ana, beto, admin] = [await makeUser(), await makeUser(), await makeUser('admin')];
  const nextB = await connect(beto);
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#00f' } }).png().toBuffer();
  const { message } = await (await sendMessage(ana, { body: 'me arrepentí', file: png })).json();
  const reply = (await (await sendMessage(beto, { body: 'jaja', reply_to: message.id })).json()).message;
  const del = (u, id) => call(u, `/messages/${id}`, { method: 'DELETE' });

  assert.equal((await del(beto, message.id)).status, 403, 'no es de beto');
  assert.equal((await del(ana, message.id)).status, 204);
  assert.equal((await nextB((m) => m.type === 'deleted')).message_id, message.id);
  const served = await fetch(`${base}/media/${message.media.filename}`, { headers: { authorization: `Bearer ${beto.token}` } });
  assert.equal(served.status, 404, 'el adjunto ya no está');
  const { messages } = await (await call(beto, '/messages')).json();
  assert.ok(!messages.some((m) => m.id === message.id));
  assert.equal(messages.find((m) => m.id === reply.id).reply, null, 'la respuesta queda sin cita');

  assert.equal((await del(admin, reply.id)).status, 204, 'un admin puede borrar cualquiera');
  assert.equal((await del(ana, message.id)).status, 404);
});
