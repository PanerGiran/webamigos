import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { UPLOAD_DIR } from '../src/images.js';
import { base, call, makeUser } from './helpers.js';

const mp4 = Buffer.from('000000146674797069736f6d0000000069736f6d', 'hex');
const webm = Buffer.from('1a45dfa380', 'hex');

async function setup() {
  const user = await makeUser();
  const res = await call(user, '/posts', { json: { body: 'Un post para comentar' } });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  return { user, commentsPath: `/posts/${id}/comments` };
}

function upload(user, commentsPath, bytes, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), 'adjunto.bin');
  return fetch(base + commentsPath, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}` },
    body: form,
  });
}

async function createAttachment(t, user, commentsPath, bytes, type) {
  const res = await upload(user, commentsPath, bytes, type);
  assert.equal(res.status, 201);
  const { comment } = await res.json();
  t.after(() => call(user, `/comments/${comment.id}`, { method: 'DELETE' }));
  return comment;
}

test('comentario solo con foto, listado y edición sin texto', async (t) => {
  const { user, commentsPath } = await setup();
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#fff' } }).png().toBuffer();
  const comment = await createAttachment(t, user, commentsPath, png, 'application/octet-stream');
  assert.equal(comment.body, '');
  assert.match(comment.media.filename, /^[0-9a-f-]{36}$/);
  assert.deepEqual(comment.media, {
    filename: comment.media.filename, mime: 'image/webp', kind: 'image', width: 40, height: 30,
  });
  const list = await (await call(user, commentsPath)).json();
  assert.deepEqual(list.comments, [comment]);

  const edit = (body) => call(user, `/comments/${comment.id}`, { method: 'PATCH', json: { body } });
  assert.equal((await edit('Un epígrafe')).status, 200);
  const res = await edit('  ');
  assert.equal(res.status, 200);
  const { comment: edited } = await res.json();
  assert.equal(edited.body, '');
  assert.deepEqual(edited.media, comment.media);
});

test('un GIF animado en un comentario conserva los cuadros', async (t) => {
  const { user, commentsPath } = await setup();
  const frames = await Promise.all(['#f00', '#0f0', '#00f'].map((background) =>
    sharp({ create: { width: 16, height: 12, channels: 3, background } }).png().toBuffer(),
  ));
  const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: 200 }).toBuffer();
  const { media } = await createAttachment(t, user, commentsPath, gif, 'image/gif');
  const res = await call(user, `/media/${media.filename}`);
  assert.equal(res.status, 200);
  const meta = await sharp(Buffer.from(await res.arrayBuffer()), { animated: true }).metadata();
  assert.equal(meta.pages, 3);
  assert.equal(media.height, 12);
});

test('el video MP4 se sirve intacto, con el MIME correcto y soporte de Range', async (t) => {
  const { user, commentsPath } = await setup();
  const { media } = await createAttachment(t, user, commentsPath, mp4, 'application/octet-stream');
  assert.deepEqual(media, { filename: media.filename, mime: 'video/mp4', kind: 'video', width: null, height: null });
  const url = `/media/${media.filename}`;
  const res = await call(user, url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), mp4);

  const range = await fetch(base + url, {
    headers: { authorization: `Bearer ${user.token}`, range: 'bytes=0-9' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-9/${mp4.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), mp4.subarray(0, 10));
});

test('audio WebM y borrado del adjunto', async (t) => {
  const { user, commentsPath } = await setup();
  const { id, media } = await createAttachment(t, user, commentsPath, webm, 'audio/webm');
  assert.deepEqual(media, { filename: media.filename, mime: 'audio/webm', kind: 'audio', width: null, height: null });
  const url = `/media/${media.filename}`;
  const res = await call(user, url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/webm');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), webm);

  assert.equal((await call(user, `/comments/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(user, url)).status, 404);
  await assert.rejects(fs.stat(path.join(UPLOAD_DIR, media.filename)), { code: 'ENOENT' });
});

test('rechaza un video falso y uno que pasa los 20 MB', async () => {
  const { user, commentsPath } = await setup();
  assert.equal((await upload(user, commentsPath, Buffer.from('no es un video'), 'video/mp4')).status, 400);
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
  mp4.copy(oversized);
  assert.equal((await upload(user, commentsPath, oversized, 'video/mp4')).status, 413);
});

test('un comentario de solo texto sigue funcionando y no admite texto vacío', async () => {
  const { user, commentsPath } = await setup();
  const res = await call(user, commentsPath, { json: { body: 'Solo texto' } });
  assert.equal(res.status, 201);
  const { comment } = await res.json();
  assert.equal(comment.body, 'Solo texto');
  assert.equal(comment.media, null);
  assert.equal((await call(user, commentsPath, { json: { body: '' } })).status, 400);
  assert.equal((await call(user, `/comments/${comment.id}`, { method: 'PATCH', json: { body: '' } })).status, 400);
});
