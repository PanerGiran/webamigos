// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, call, makeUser } from './helpers.js';

async function newPost(user, body = 'hola') {
  const form = new FormData();
  form.append('body', body);
  const res = await fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${user.token}` }, body: form });
  return (await res.json()).id;
}
const feedPost = async (user, id) => (await (await call(user, '/posts')).json()).posts.find((p) => p.id === id);

test('comentarios: crear, listar, contar y borrar con permisos', async () => {
  const [autor, otro, admin] = [await makeUser(), await makeUser(), await makeUser('admin')];
  const postId = await newPost(autor);

  assert.equal((await call(otro, `/posts/${postId}/comments`, { json: { body: '   ' } })).status, 400);
  let res = await call(otro, `/posts/${postId}/comments`, { json: { body: '  ¡Buenísimo!  ' } });
  assert.equal(res.status, 201);
  const { comment } = await res.json();
  assert.equal(comment.body, '¡Buenísimo!');
  assert.equal(comment.username, otro.username);
  await call(autor, `/posts/${postId}/comments`, { json: { body: 'gracias' } });

  const { comments } = await (await call(autor, `/posts/${postId}/comments`)).json();
  assert.deepEqual(comments.map((c) => c.body), ['¡Buenísimo!', 'gracias'], 'del más viejo al más nuevo');
  assert.equal((await feedPost(autor, postId)).comment_count, 2);

  const ajeno = comments[1].id;
  assert.equal((await call(otro, `/comments/${ajeno}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call(otro, `/comments/${comment.id}`, { method: 'DELETE' })).status, 204, 'el autor borra el suyo');
  assert.equal((await call(admin, `/comments/${ajeno}`, { method: 'DELETE' })).status, 204, 'el admin borra cualquiera');
  assert.equal((await feedPost(autor, postId)).comment_count, 0);

  await call(autor, `/posts/${postId}`, { method: 'DELETE' });
  assert.equal((await call(otro, `/posts/${postId}/comments`, { json: { body: 'tarde' } })).status, 404, 'no se comenta un post borrado');
  assert.equal((await call(otro, `/posts/${postId}/comments`)).status, 404);
});

test('reacciones: poner, sumar, quitar y validar', async () => {
  const [a, b] = [await makeUser(), await makeUser()];
  const postId = await newPost(a);
  const react = (u, emoji, on) => call(u, `/posts/${postId}/reactions`, { method: 'PUT', json: { emoji, on } });

  let r = await (await react(a, '😂', true)).json();
  assert.deepEqual(r.reactions, [{ emoji: '😂', count: 1, mine: true }]);
  await react(a, '😂', true); // repetir no duplica
  r = await (await react(b, '😂', true)).json();
  assert.deepEqual(r.reactions, [{ emoji: '😂', count: 2, mine: true }]);
  await react(b, '🔥', true);

  const seenByA = (await feedPost(a, postId)).reactions.sort((x, y) => x.emoji.localeCompare(y.emoji));
  assert.deepEqual(seenByA, [
    { emoji: '😂', count: 2, mine: true },
    { emoji: '🔥', count: 1, mine: false },
  ].sort((x, y) => x.emoji.localeCompare(y.emoji)));

  r = await (await react(a, '😂', false)).json();
  assert.ok(r.reactions.some((x) => x.emoji === '😂' && x.count === 1 && !x.mine));
  assert.equal((await react(a, '💩', true)).status, 400, 'solo los emojis de la lista');
  assert.equal((await call(a, `/posts/${postId}/reactions`, { method: 'PUT', json: { emoji: '😂' } })).status, 400);
  assert.equal((await call(null, `/posts/${postId}/reactions`, { method: 'PUT', json: { emoji: '😂', on: true } })).status, 401);
});

test('quiénes reaccionaron: agrupado por emoji y sin cuentas eliminadas', async () => {
  const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
  const postId = await newPost(a);
  const react = (u, emoji) => call(u, `/posts/${postId}/reactions`, { method: 'PUT', json: { emoji, on: true } });
  await react(b, '🔥');
  await react(c, '🔥');
  await react(b, '❤️');

  const { reactions } = await (await call(a, `/posts/${postId}/reactions`)).json();
  assert.deepEqual(reactions.map((r) => r.emoji), ['❤️', '🔥'], 'en el orden de la lista de emojis');
  assert.deepEqual(reactions[1].users.map((u) => u.username).sort(), [b.username, c.username].sort());
  assert.deepEqual(Object.keys(reactions[0].users[0]).sort(), ['avatar', 'display_name', 'id', 'username'], 'solo datos públicos');

  const { pool } = await import('../src/db.js');
  await pool.execute('UPDATE users SET deleted_at = NOW(), is_active = 0 WHERE id = ?', [c.id]);
  const after = (await (await call(a, `/posts/${postId}/reactions`)).json()).reactions;
  assert.deepEqual(after.find((r) => r.emoji === '🔥').users.map((u) => u.username), [b.username]);

  await call(a, `/posts/${postId}`, { method: 'DELETE' });
  assert.equal((await call(a, `/posts/${postId}/reactions`)).status, 404);
});
