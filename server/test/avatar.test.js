// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { base, call, makeUser } from './helpers.js';

const auth = (u) => ({ authorization: `Bearer ${u.token}` });
function putAvatar(u, image, type = 'image/jpeg') {
  const form = new FormData();
  if (image) form.append('image', new Blob([image], { type }), 'yo.jpg');
  return fetch(`${base}/me/avatar`, { method: 'PUT', headers: auth(u), body: form });
}
const me = async (u) => (await call(u, '/me')).json();
const media = (u, f) => fetch(`${base}/media/${f}`, { headers: auth(u) });

test('foto de perfil: subir, recortar, aparecer en todos lados, cambiar y quitar', async () => {
  const [u, otro] = [await makeUser(), await makeUser()];
  const foto = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3a7' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'privado' } })
    .toBuffer();

  let res = await putAvatar(u, foto);
  assert.equal(res.status, 200);
  const { avatar } = await res.json();
  assert.equal((await me(u)).avatar, avatar);

  const img = await media(otro, avatar);
  assert.equal(img.status, 200, 'los demás la ven');
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ['webp', 256, 256, undefined], 'cuadrada y sin EXIF');
  assert.equal((await fetch(`${base}/media/${avatar}`)).status, 401, 'sin sesión no');

  // La versión completa conserva la proporción original (sin recorte).
  const { user: perfil } = await (await call(otro, `/users/${u.username}`)).json();
  assert.equal(perfil.avatar, avatar);
  const fullMeta = await sharp(Buffer.from(await (await media(otro, perfil.avatar_full)).arrayBuffer())).metadata();
  assert.deepEqual([fullMeta.width, fullMeta.height, fullMeta.exif], [1200, 800, undefined], 'completa y sin EXIF');

  // Aparece junto a sus posts, comentarios y mensajes.
  const form = new FormData();
  form.append('body', 'con foto');
  const { id: postId } = await (await fetch(`${base}/posts`, { method: 'POST', headers: auth(u), body: form })).json();
  const post = (await (await call(otro, '/posts')).json()).posts.find((p) => p.id === postId);
  assert.equal(post.avatar, avatar);
  const { comment } = await (await call(u, `/posts/${postId}/comments`, { json: { body: 'hola' } })).json();
  assert.equal(comment.avatar, avatar);

  // Cambiarla borra la anterior.
  res = await putAvatar(u, await sharp({ create: { width: 300, height: 300, channels: 3, background: '#a37' } }).png().toBuffer(), 'image/png');
  const nueva = (await res.json()).avatar;
  assert.notEqual(nueva, avatar);
  assert.equal((await media(u, avatar)).status, 404, 'la vieja se borró');
  assert.equal((await media(u, perfil.avatar_full)).status, 404, 'y su versión completa también');
  assert.equal((await media(u, nueva)).status, 200);

  // Quitarla.
  assert.equal((await call(u, '/me/avatar', { method: 'DELETE' })).status, 204);
  assert.equal((await me(u)).avatar, null);
  assert.equal((await media(u, nueva)).status, 404);
});

test('foto de perfil y portada: los GIF animados siguen animados', async () => {
  const u = await makeUser();
  const frame = (c) => sharp({ create: { width: 400, height: 300, channels: 3, background: c } }).png().toBuffer();
  const gif = await sharp(await Promise.all(['#e33', '#3e3', '#33e'].map(frame)), { join: { animated: true } }).gif({ delay: 200 }).toBuffer();
  const anim = async (f) => sharp(Buffer.from(await (await media(u, f)).arrayBuffer()), { animated: true }).metadata();

  const { avatar, avatar_full } = await (await putAvatar(u, gif, 'image/gif')).json();
  let m = await anim(avatar);
  assert.deepEqual([m.format, m.pages, m.width, m.pageHeight], ['webp', 3, 256, 256], 'avatar: 3 cuadros, cuadrado');
  m = await anim(avatar_full);
  assert.deepEqual([m.pages, m.width, m.pageHeight], [3, 400, 300], 'la versión completa también se mueve');

  const form = new FormData();
  form.append('image', new Blob([gif], { type: 'image/gif' }), 'p.gif');
  const { cover } = await (await fetch(`${base}/me/cover`, { method: 'PUT', headers: auth(u), body: form })).json();
  m = await anim(cover);
  assert.deepEqual([m.pages, m.width, m.pageHeight], [3, 900, 300], 'portada animada (más chica que la fija)');

  // Una foto fija sigue igual que antes.
  const still = (await (await putAvatar(u, await frame('#999'))).json()).avatar;
  assert.equal((await anim(still)).pages ?? 1, 1);
});

test('foto de perfil: rechaza lo que no es imagen y pide sesión', async () => {
  const u = await makeUser();
  assert.equal((await putAvatar(u, Buffer.from('no soy una foto'), 'image/png')).status, 400);
  assert.equal((await putAvatar(u, null)).status, 400);
  assert.equal((await fetch(`${base}/me/avatar`, { method: 'PUT' })).status, 401);
  assert.equal((await me(u)).avatar, null);
});
