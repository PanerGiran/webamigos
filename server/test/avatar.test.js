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

test('encuadre elegido: foto y portada muestran la zona que se eligió (también en GIF)', async () => {
  const u = await makeUser();
  // 400x200: mitad izquierda roja, mitad derecha azul.
  const half = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#f00' } })
    .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: '#00f' } }, left: 200, top: 0 }])
    .png()
    .toBuffer();
  const send = (path, img, crop, type = 'image/png') => {
    const form = new FormData();
    form.append('image', new Blob([img], { type }), 'f');
    if (crop !== undefined) form.append('crop', typeof crop === 'string' ? crop : JSON.stringify(crop));
    return fetch(`${base}${path}`, { method: 'PUT', headers: auth(u), body: form });
  };
  const centerColor = async (f) => {
    const img = sharp(Buffer.from(await (await media(u, f)).arrayBuffer()));
    const { width, height } = await img.metadata();
    const [r, g, b] = await img.extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 }).raw().toBuffer();
    return r > 200 && b < 60 ? 'rojo' : b > 200 && r < 60 ? 'azul' : `otro(${r},${g},${b})`;
  };

  const { avatar } = await (await send('/me/avatar', half, { left: 200, top: 0, width: 200, height: 200 })).json();
  assert.equal(await centerColor(avatar), 'azul', 'eligió la mitad derecha');
  const { cover } = await (await send('/me/cover', half, { left: 0, top: 50, width: 300, height: 100 })).json();
  assert.equal(await centerColor(cover), 'rojo', 'eligió una franja de la izquierda');
  const m = await sharp(Buffer.from(await (await media(u, cover)).arrayBuffer())).metadata();
  assert.deepEqual([m.width, m.height], [1500, 500]);

  // Un encuadre que se pasa del borde se ajusta en vez de fallar; uno mal formado se rechaza.
  assert.equal((await send('/me/avatar', half, { left: 350, top: 150, width: 999, height: 999 })).status, 200);
  assert.equal((await send('/me/avatar', half, '{no es json')).status, 400);
  assert.equal((await send('/me/cover', half, { left: -5, top: 0, width: 10, height: 10 })).status, 400);

  // GIF animado con encuadre: sigue animado.
  const frame = (c) => sharp({ create: { width: 400, height: 200, channels: 3, background: c } }).png().toBuffer();
  const gif = await sharp(await Promise.all(['#e33', '#3e3', '#33e'].map(frame)), { join: { animated: true } }).gif().toBuffer();
  const animAvatar = (await (await send('/me/avatar', gif, { left: 100, top: 0, width: 200, height: 200 }, 'image/gif')).json()).avatar;
  const am = await sharp(Buffer.from(await (await media(u, animAvatar)).arrayBuffer()), { animated: true }).metadata();
  assert.deepEqual([am.pages, am.width, am.pageHeight], [3, 256, 256]);
});

test('foto de perfil: rechaza lo que no es imagen y pide sesión', async () => {
  const u = await makeUser();
  assert.equal((await putAvatar(u, Buffer.from('no soy una foto'), 'image/png')).status, 400);
  assert.equal((await putAvatar(u, null)).status, 400);
  assert.equal((await fetch(`${base}/me/avatar`, { method: 'PUT' })).status, 401);
  assert.equal((await me(u)).avatar, null);
});
