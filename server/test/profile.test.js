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

test('perfil: nombre, bio y portada', async () => {
  const [u, otro] = [await makeUser(), await makeUser()];
  const patch = (json) => call(u, '/me/profile', { method: 'PATCH', json });
  const perfil = async () => (await (await call(otro, `/users/${u.username}`)).json()).user;

  let res = await patch({ display_name: '  Nombre Nuevo ', bio: ' Me gustan los memes.\nY el asado. ' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { display_name: 'Nombre Nuevo', bio: 'Me gustan los memes.\nY el asado.' });
  let p = await perfil();
  assert.equal(p.bio, 'Me gustan los memes.\nY el asado.');
  assert.equal(p.display_name, 'Nombre Nuevo');
  assert.equal((await patch({ bio: 'x'.repeat(301) })).status, 400);
  assert.equal((await patch({ display_name: '   ' })).status, 400);
  assert.equal((await patch({})).status, 400);
  await patch({ bio: '' });
  assert.equal((await perfil()).bio, null, 'bio vacía = sin bio');

  // Portada: apaisada 1500x500, se reemplaza y se quita sin dejar archivos viejos.
  const sharp = (await import('sharp')).default;
  const put = async (color) => {
    const form = new FormData();
    form.append('image', new Blob([await sharp({ create: { width: 900, height: 900, channels: 3, background: color } }).jpeg().toBuffer()], { type: 'image/jpeg' }), 'p.jpg');
    return fetch(`${base}/me/cover`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}` }, body: form });
  };
  res = await put('#36c');
  assert.equal(res.status, 200);
  const { cover } = await res.json();
  assert.equal((await perfil()).cover, cover);
  const img = await fetch(`${base}/media/${cover}`, { headers: { authorization: `Bearer ${otro.token}` } });
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.deepEqual([meta.width, meta.height], [1500, 500]);

  const nueva = (await (await put('#c63')).json()).cover;
  assert.equal((await fetch(`${base}/media/${cover}`, { headers: { authorization: `Bearer ${u.token}` } })).status, 404, 'la vieja se borró');
  assert.equal((await call(u, '/me/cover', { method: 'DELETE' })).status, 204);
  assert.equal((await perfil()).cover, null);
  assert.equal((await fetch(`${base}/media/${nueva}`, { headers: { authorization: `Bearer ${u.token}` } })).status, 404);
});

test('perfil: apariencia guardada en la cuenta y fondo del perfil', async () => {
  const [u, otro] = [await makeUser(), await makeUser()];
  const perfil = async () => (await (await call(otro, `/users/${u.username}`)).json()).user;

  assert.equal((await call(u, '/me/look', { method: 'PUT', json: { look: 'bosque' } })).status, 204);
  assert.equal((await (await call(u, '/me')).json()).look, 'bosque', 'vuelve en /me (para otro dispositivo)');
  assert.equal((await perfil()).look, 'bosque', 'los demás ven tu perfil con tu apariencia');
  assert.equal((await call(u, '/me/look', { method: 'PUT', json: { look: '<script>' } })).status, 400);
  assert.equal((await call(u, '/me/look', { method: 'PUT', json: { look: null } })).status, 204, 'se puede borrar');

  const sharp = (await import('sharp')).default;
  const put = async (c) => {
    const form = new FormData();
    form.append('image', new Blob([await sharp({ create: { width: 800, height: 1200, channels: 3, background: c } }).jpeg().toBuffer()], { type: 'image/jpeg' }), 'f.jpg');
    return fetch(`${base}/me/background`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}` }, body: form });
  };
  const media = (f) => fetch(`${base}/media/${f}`, { headers: { authorization: `Bearer ${otro.token}` } });
  const first = (await (await put('#246')).json()).profile_bg;
  assert.equal((await perfil()).profile_bg, first);
  assert.equal((await media(first)).status, 200);
  const second = (await (await put('#642')).json()).profile_bg;
  assert.equal((await media(first)).status, 404, 'el fondo viejo se borró');
  assert.equal((await call(u, '/me/background', { method: 'DELETE' })).status, 204);
  assert.equal((await perfil()).profile_bg, null);
  assert.equal((await media(second)).status, 404);
});
