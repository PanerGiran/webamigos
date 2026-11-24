// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { base, call, makeUser } from './helpers.js';

async function post(u, body, scope = 'feed') {
  const form = new FormData();
  form.append('body', body);
  form.append('scope', scope);
  return (await (await fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form })).json()).id;
}
const search = async (u, q) => {
  const res = await call(u, `/search?q=${encodeURIComponent(q)}`);
  return res.status === 200 ? res.json() : res.status;
};

test('buscador: posts y personas, sin tildes ni mayúsculas', async () => {
  const [a, b] = [await makeUser(), await makeUser()];
  const tag = crypto.randomUUID().slice(0, 6); // palabra única para no chocar con otros tests
  const enFeed = await post(a, `La canción del asado ${tag}`);
  const enPerfil = await post(b, `Mi canción favorita ${tag}`, 'profile');
  const borrado = await post(a, `canción borrada ${tag}`);
  await call(a, `/posts/${borrado}`, { method: 'DELETE' });

  const r = await search(b, `CANCION DEL ASADO ${tag}`);
  assert.deepEqual(r.posts.map((p) => p.id), [enFeed], 'sin importar tildes ni mayúsculas');
  const todos = (await search(b, `canción`)).posts.map((p) => p.id);
  assert.ok(todos.includes(enFeed) && todos.includes(enPerfil), 'también los posts de perfil');
  assert.ok(!todos.includes(borrado), 'los borrados no aparecen');
  assert.ok(Array.isArray(r.posts[0].reactions) && 'comment_count' in r.posts[0], 'vienen igual que en el feed');

  const people = (await search(a, b.username)).users;
  assert.deepEqual(people.map((u) => u.username), [b.username]);
  assert.deepEqual(Object.keys(people[0]).sort(), ['avatar', 'display_name', 'id', 'username'], 'solo datos públicos');
});

test('buscador: comodines, límites y sesión', async () => {
  const u = await makeUser();
  await post(u, 'cien por ciento seguro');
  assert.ok(!(await search(u, '%%')).posts.some((p) => p.body === 'cien por ciento seguro'), '% no es comodín');
  assert.equal(await search(u, 'a'), 400, 'mínimo 2 caracteres');
  assert.equal(await search(u, 'x'.repeat(101)), 400);
  assert.equal((await call(null, '/search?q=hola')).status, 401);
});
