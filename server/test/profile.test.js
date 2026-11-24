// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, call, makeUser } from './helpers.js';
import { pool } from '../src/db.js';

async function newPost(u, body, scope) {
  const form = new FormData();
  form.append('body', body);
  if (scope) form.append('scope', scope);
  const res = await fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}
const ids = async (u, qs) => (await (await call(u, `/posts${qs}`)).json()).posts.map((p) => p.id);

test('perfil: los posts de perfil no salen en el feed y cada pestaña muestra lo suyo', async () => {
  const [ana, beto] = [await makeUser(), await makeUser()];
  const enFeed = await newPost(ana, 'para todos');
  const enPerfil = await newPost(ana, 'solo en mi perfil', 'profile');
  const deOtro = await newPost(beto, 'de beto', 'profile');

  const feed = await ids(beto, '');
  assert.ok(feed.includes(enFeed));
  assert.ok(!feed.includes(enPerfil), 'el post de perfil no está en el feed global');
  assert.ok(!(await ids(beto, '?scope=profile')).includes(enPerfil), 'sin ?user= nunca se listan posts de perfil');

  const perfil = await ids(beto, `?user=${ana.username}&scope=profile`);
  assert.deepEqual(perfil, [enPerfil], 'solo los de perfil de ana');
  assert.deepEqual(await ids(beto, `?user=${ana.username}&scope=feed`), [enFeed]);
  assert.ok(!perfil.includes(deOtro));

  // Se puede comentar y reaccionar igual que en el feed.
  assert.equal((await call(beto, `/posts/${enPerfil}/comments`, { json: { body: '¡qué bueno!' } })).status, 201);
  assert.equal((await call(beto, `/posts/${enPerfil}/reactions`, { method: 'PUT', json: { emoji: '❤️', on: true } })).status, 200);

  const { user } = await (await call(beto, `/users/${ana.username}`)).json();
  assert.equal(user.id, ana.id);
  assert.deepEqual([user.profile_count, user.feed_count], [1, 1]);
  assert.equal('password_hash' in user, false);

  await call(ana, `/posts/${enPerfil}`, { method: 'DELETE' });
  assert.equal((await (await call(beto, `/users/${ana.username}`)).json()).user.profile_count, 0, 'los borrados no cuentan');
});

test('perfil: inexistente, eliminado o sin sesión', async () => {
  const [u, borrado] = [await makeUser(), await makeUser()];
  assert.equal((await call(u, '/users/no_existe_nadie')).status, 404);
  await pool.execute('UPDATE users SET deleted_at = NOW(), is_active = 0 WHERE id = ?', [borrado.id]);
  assert.equal((await call(u, `/users/${borrado.username}`)).status, 404, 'las cuentas eliminadas no tienen perfil');
  assert.equal((await call(null, `/users/${u.username}`)).status, 401);
  const nuevo = await makeUser();
  const { user } = await (await call(u, `/users/${nuevo.username}`)).json();
  assert.deepEqual([user.profile_count, user.feed_count], [0, 0], 'sin posts cuenta 0');
});
