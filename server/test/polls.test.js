// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, call, makeUser } from './helpers.js';

function newPoll(u, body, options, raw) {
  const form = new FormData();
  if (body) form.append('body', body);
  form.append('poll', raw ?? JSON.stringify(options));
  return fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
}
const pollOf = async (u, id) => (await (await call(u, '/posts')).json()).posts.find((p) => p.id === id).poll;
const vote = (u, id, option_id) => call(u, `/posts/${id}/vote`, { method: 'PUT', json: { option_id } });

test('encuestas: crear, votar, cambiar y sacar el voto', async () => {
  const [ana, beto, caro] = [await makeUser(), await makeUser(), await makeUser()];
  const res = await newPoll(ana, '¿Qué comemos el sábado?', ['Asado', ' Pizza ', 'Sushi']);
  assert.equal(res.status, 201);
  const { id } = await res.json();

  let poll = await pollOf(beto, id);
  assert.deepEqual(poll.options.map((o) => [o.text, o.votes]), [['Asado', 0], ['Pizza', 0], ['Sushi', 0]]);
  assert.deepEqual([poll.total, poll.my_vote], [0, null]);
  const [asado, pizza] = poll.options.map((o) => o.id);

  poll = (await (await vote(beto, id, asado)).json()).poll;
  assert.deepEqual([poll.total, poll.my_vote], [1, asado]);
  poll = (await (await vote(beto, id, pizza)).json()).poll;
  assert.deepEqual([poll.total, poll.my_vote, poll.options[1].votes], [1, pizza, 1], 'votar otra opción cambia el voto');
  await vote(caro, id, pizza);

  poll = await pollOf(ana, id);
  assert.deepEqual([poll.total, poll.my_vote, poll.options[1].votes], [2, null, 2], 'ana no votó');
  poll = (await (await vote(beto, id, null)).json()).poll;
  assert.deepEqual([poll.total, poll.my_vote], [1, null], 'sacar el voto');

  const { options } = await (await call(ana, `/posts/${id}/votes`)).json();
  assert.deepEqual(options.map((o) => [o.text, o.users.map((u) => u.username)]), [['Asado', []], ['Pizza', [caro.username]], ['Sushi', []]]);

  // Opciones de otra encuesta, votos raros, posts borrados.
  const otra = (await (await newPoll(ana, '¿Otra?', ['Sí', 'No'])).json()).id;
  const ajena = (await pollOf(ana, otra)).options[0].id;
  assert.equal((await vote(beto, id, ajena)).status, 400);
  assert.equal((await vote(beto, id, 'asado')).status, 400);
  assert.equal((await call(ana, `/posts/${id}`, { method: 'PATCH', json: { body: '' } })).status, 400, 'la encuesta necesita su pregunta');
  await call(ana, `/posts/${otra}`, { method: 'DELETE' });
  assert.equal((await vote(beto, otra, ajena)).status, 404);
});

test('encuestas: validaciones al crear', async () => {
  const u = await makeUser();
  assert.equal((await newPoll(u, '¿?', ['Solo una'])).status, 400, 'mínimo 2');
  assert.equal((await newPoll(u, '¿?', ['1', '2', '3', '4', '5', '6', '7'])).status, 400, 'máximo 6');
  assert.equal((await newPoll(u, '¿?', ['Igual', 'igual'])).status, 400, 'sin repetidas');
  assert.equal((await newPoll(u, '¿?', ['Bien', '   '])).status, 400, 'sin vacías');
  assert.equal((await newPoll(u, '¿?', ['x'.repeat(101), 'b'])).status, 400);
  assert.equal((await newPoll(u, '', ['a', 'b'])).status, 400, 'necesita pregunta');
  assert.equal((await newPoll(u, '¿?', null, '{no es json')).status, 400);
  const sin = (await (await call(u, '/posts')).json()).posts.find((p) => p.user_id === u.id);
  assert.equal(sin, undefined, 'no se creó ningún post');
});
