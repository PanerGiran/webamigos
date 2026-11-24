// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { base, call, makeUser } from './helpers.js';

async function newPost(u, body, image) {
  const form = new FormData();
  if (body) form.append('body', body);
  if (image) form.append('image', new Blob([image], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${base}/posts`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
  return (await res.json()).id;
}
const edit = (u, id, body) => call(u, `/posts/${id}`, { method: 'PATCH', json: { body } });

test('editar posts: solo el autor, marca "editado" y no deja posts vacíos', async () => {
  const [autor, otro, admin] = [await makeUser(), await makeUser(), await makeUser('admin')];
  const id = await newPost(autor, 'versión original');

  const res = await edit(autor, id, '  versión corregida  ');
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.body, 'versión corregida');
  assert.ok(r.edited_at);
  const enFeed = (await (await call(otro, '/posts')).json()).posts.find((p) => p.id === id);
  assert.equal(enFeed.body, 'versión corregida');
  assert.ok(enFeed.edited_at, 'el feed trae la marca de editado');

  assert.equal((await edit(otro, id, 'hackeado')).status, 403);
  assert.equal((await edit(admin, id, 'el admin tampoco')).status, 403, 'el admin borra, pero no cambia palabras ajenas');
  assert.equal((await edit(autor, id, '   ')).status, 400, 'sin foto no puede quedar vacío');
  assert.equal((await edit(autor, id, 'x'.repeat(5001))).status, 400);
  assert.equal((await call(autor, `/posts/${id}`, { method: 'PATCH', json: {} })).status, 400);

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
  const conFoto = await newPost(autor, 'con foto', png);
  const sinTexto = await (await edit(autor, conFoto, '')).json();
  assert.equal(sinTexto.body, null, 'con foto sí puede quedar sin texto');

  await call(autor, `/posts/${id}`, { method: 'DELETE' });
  assert.equal((await edit(autor, id, 'tarde')).status, 404);
});

test('editar comentarios: solo el autor y con la marca de editado', async () => {
  const [autor, otro] = [await makeUser(), await makeUser()];
  const postId = await newPost(otro, 'post');
  const { comment } = await (await call(autor, `/posts/${postId}/comments`, { json: { body: 'comentario' } })).json();
  assert.equal(comment.edited_at, null);

  const res = await call(autor, `/comments/${comment.id}`, { method: 'PATCH', json: { body: ' corregido ' } });
  assert.equal(res.status, 200);
  const edited = (await res.json()).comment;
  assert.equal(edited.body, 'corregido');
  assert.ok(edited.edited_at);
  const listed = (await (await call(otro, `/posts/${postId}/comments`)).json()).comments[0];
  assert.equal(listed.body, 'corregido');

  assert.equal((await call(otro, `/comments/${comment.id}`, { method: 'PATCH', json: { body: 'ajeno' } })).status, 403);
  assert.equal((await call(autor, `/comments/${comment.id}`, { method: 'PATCH', json: { body: '  ' } })).status, 400);
  assert.equal((await call(autor, '/comments/999999999', { method: 'PATCH', json: { body: 'x' } })).status, 404);
});
