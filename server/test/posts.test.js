// Correr con una base y carpeta de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';
import { createSession } from '../src/auth.js';

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api`;

const userIds = [];
after(async () => {
  if (userIds.length) {
    const q = userIds.map(() => '?').join(',');
    await pool.execute(`DELETE FROM posts WHERE user_id IN (${q})`, userIds);
    await pool.execute(`DELETE FROM media WHERE user_id IN (${q})`, userIds);
    await pool.execute(`DELETE FROM users WHERE id IN (${q})`, userIds);
  }
  server.close();
  await pool.end();
});

async function makeUser(role = 'member') {
  const [r] = await pool.execute('INSERT INTO users (username, display_name, role) VALUES (?, ?, ?)', [
    't' + crypto.randomUUID().slice(0, 8),
    'Test',
    role,
  ]);
  userIds.push(r.insertId);
  return { id: r.insertId, token: await createSession(r.insertId, 'test') };
}

const auth = (u) => ({ authorization: `Bearer ${u.token}` });
function newPost(u, body, image, type = 'image/jpeg') {
  const form = new FormData();
  if (body != null) form.append('body', body);
  if (image) form.append('image', new Blob([image], { type }), 'foto.jpg');
  return fetch(`${base}/posts`, { method: 'POST', headers: auth(u), body: form });
}
const feed = (u, before) => fetch(`${base}/posts${before ? `?before=${before}` : ''}`, { headers: auth(u) }).then((r) => r.json());

test('imagen: se achica, pierde el EXIF y exige sesión', async () => {
  const u = await makeUser();
  const jpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#c33' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'dato-privado' } })
    .toBuffer();
  assert.ok((await sharp(jpeg).metadata()).exif, 'la imagen de prueba tiene EXIF');

  const res = await newPost(u, 'hola', jpeg);
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const p = (await feed(u)).posts.find((x) => x.id === id);
  assert.equal(p.body, 'hola');
  assert.deepEqual([p.width, p.height], [1600, 1067]);

  assert.equal((await fetch(`${base}/media/${p.filename}`)).status, 401, 'sin sesión no se ve');
  const img = await fetch(`${base}/media/${p.filename}`, { headers: auth(u) });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.exif, undefined, 'sin EXIF');
  assert.equal((await fetch(`${base}/media/..%2F..%2Fetc%2Fpasswd`, { headers: auth(u) })).status, 404);
});

test('rechaza posts vacíos, archivos que no son imágenes y los de más de 5 MB', async () => {
  const u = await makeUser();
  assert.equal((await newPost(u, '   ')).status, 400);
  assert.equal((await newPost(u, 'x', Buffer.from('<?php echo 1; ?>'), 'image/png')).status, 400);
  assert.equal((await newPost(u, 'x', crypto.randomBytes(6 * 1024 * 1024))).status, 413);
  assert.equal((await newPost(u, 'x'.repeat(5001))).status, 400);
});

test('borrar: solo el autor o un admin, y la imagen se va del disco', async () => {
  const [autor, otro, admin] = [await makeUser(), await makeUser(), await makeUser('admin')];
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
  const { id } = await (await newPost(autor, null, png, 'image/png')).json();
  const { filename } = (await feed(autor)).posts.find((x) => x.id === id);
  const del = (u, postId) => fetch(`${base}/posts/${postId}`, { method: 'DELETE', headers: auth(u) });

  assert.equal((await del(otro, id)).status, 403);
  assert.equal((await del(autor, id)).status, 204);
  assert.equal((await del(autor, id)).status, 404, 'ya no existe');
  assert.ok(!(await feed(autor)).posts.some((x) => x.id === id));
  assert.equal((await fetch(`${base}/media/${filename}`, { headers: auth(autor) })).status, 404);

  const { id: id2 } = await (await newPost(autor, 'otro')).json();
  assert.equal((await del(admin, id2)).status, 204, 'el admin puede borrar cualquiera');
});

test('paginación con ?before', async () => {
  const u = await makeUser();
  for (let i = 0; i < 22; i++) assert.equal((await newPost(u, `post ${i}`)).status, 201);
  const p1 = await feed(u);
  assert.equal(p1.posts.length, 20);
  assert.equal(p1.more, true);
  const last = p1.posts.at(-1).id;
  const p2 = await feed(u, last);
  assert.ok(p2.posts.length >= 2);
  assert.ok(p2.posts.every((x) => x.id < last));
  assert.equal(p1.posts[0].body, 'post 21', 'del más nuevo al más viejo');
});
