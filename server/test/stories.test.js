// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
// Historias de 24 horas: subir, ver, reaccionar, quién las vio, borrar y vencimiento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { pool } from '../src/db.js';
import { UPLOAD_DIR } from '../src/images.js';
import { cleanStories } from '../src/routes/stories.js';
import { base, call, makeUser } from './helpers.js';

function story(u, { body, bg, image } = {}) {
  const form = new FormData();
  if (body !== undefined) form.append('body', body);
  if (bg !== undefined) form.append('bg', String(bg));
  if (image) form.append('image', new Blob([image], { type: 'image/png' }), 'h.png');
  return fetch(`${base}/stories`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
}
const groups = async (u) => (await (await call(u, '/stories')).json()).users;

test('historias: subir foto o texto, verlas agrupadas y marcar vistas', async () => {
  const [ana, beto] = [await makeUser(), await makeUser()];
  const png = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#09f' } }).png().toBuffer();

  let res = await story(ana, { image: png, body: 'en la playa' });
  assert.equal(res.status, 201);
  const foto = (await res.json()).id;
  const texto = (await (await story(ana, { body: 'hoy no salgo', bg: 3 })).json()).id;
  assert.equal((await story(ana, {})).status, 400, 'vacía');
  assert.equal((await story(ana, { body: 'x'.repeat(301) })).status, 400);
  assert.equal((await story(ana, { image: Buffer.from('nada') })).status, 400);

  let g = (await groups(beto)).find((x) => x.id === ana.id);
  assert.deepEqual(g.stories.map((s) => s.id), [foto, texto], 'en orden');
  assert.equal(g.stories[0].image.height, 90);
  assert.equal(g.stories[1].bg, 3);
  assert.equal(g.seen, false);
  assert.equal(g.stories[0].views, undefined, 'beto no ve cuántas vistas tiene la de ana');

  assert.equal((await call(beto, `/stories/${foto}/view`, { method: 'PUT' })).status, 204);
  assert.equal((await call(beto, `/stories/${foto}/view`, { method: 'PUT' })).status, 204, 'dos veces no suma');
  g = (await groups(beto)).find((x) => x.id === ana.id);
  assert.deepEqual(g.stories.map((s) => s.seen), [true, false]);
  await call(beto, `/stories/${texto}/view`, { method: 'PUT' });
  assert.equal((await groups(beto)).find((x) => x.id === ana.id).seen, true, 'vio todas');

  // Las propias van primero y muestran cuántos las vieron.
  const mias = (await groups(ana))[0];
  assert.equal(mias.id, ana.id);
  assert.deepEqual(mias.stories.map((s) => s.views), [1, 1]);
  await call(ana, `/stories/${foto}/view`, { method: 'PUT' });
  assert.equal((await groups(ana))[0].stories[0].views, 1, 'verse a uno mismo no cuenta');
});

test('historias: reacciones y quién las vio (solo para quien la subió)', async () => {
  const [ana, beto, caro] = [await makeUser(), await makeUser(), await makeUser()];
  const id = (await (await story(ana, { body: '¿quién viene?' })).json()).id;
  const react = (u, emoji) => call(u, `/stories/${id}/react`, { method: 'PUT', json: { emoji } });
  assert.equal((await react(beto, '🔥')).status, 200);
  assert.equal((await react(beto, '💩')).status, 400);
  assert.equal((await react(ana, '🔥')).status, 400, 'no a la propia');
  assert.equal((await groups(beto)).find((g) => g.id === ana.id).stories[0].my_emoji, '🔥', 'beto ve su propia reacción');
  await call(caro, `/stories/${id}/view`, { method: 'PUT' });

  assert.equal((await call(beto, `/stories/${id}/views`)).status, 403);
  const { views } = await (await call(ana, `/stories/${id}/views`)).json();
  assert.deepEqual(views.map((v) => [v.id, v.emoji]).sort(), [[beto.id, '🔥'], [caro.id, null]].sort());
  await react(beto, null);
  const again = (await (await call(ana, `/stories/${id}/views`)).json()).views;
  assert.equal(again.find((v) => v.id === beto.id).emoji, null, 'sacó la reacción pero sigue como vista');
});

test('historias: borrar y vencer se llevan la foto', async () => {
  const [ana, beto, admin] = [await makeUser(), await makeUser(), await makeUser('admin')];
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f00' } }).png().toBuffer();
  const fileOf = async (id) => {
    const [[r]] = await pool.execute('SELECT m.filename FROM stories s JOIN media m ON m.id = s.media_id WHERE s.id = ?', [id]);
    return path.join(UPLOAD_DIR, r.filename);
  };

  const a = (await (await story(ana, { image: png })).json()).id;
  const fileA = await fileOf(a);
  assert.equal((await call(beto, `/stories/${a}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call(ana, `/stories/${a}`, { method: 'DELETE' })).status, 204);
  await assert.rejects(fs.access(fileA), 'la foto se borró del disco');
  const b = (await (await story(beto, { body: 'algo' })).json()).id;
  assert.equal((await call(admin, `/stories/${b}`, { method: 'DELETE' })).status, 204, 'un admin puede');

  // Vencida: deja de listarse y la limpieza la borra con su foto.
  const c = (await (await story(ana, { image: png })).json()).id;
  const fileC = await fileOf(c);
  await pool.execute('UPDATE stories SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [c]);
  assert.ok(!(await groups(beto)).some((g) => g.stories.some((s) => s.id === c)), 'vencida no se lista');
  assert.equal((await call(beto, `/stories/${c}/view`, { method: 'PUT' })).status, 404);
  assert.ok((await cleanStories()) >= 1);
  const [[gone]] = await pool.execute('SELECT COUNT(*) AS n FROM stories WHERE id = ?', [c]);
  assert.equal(gone.n, 0);
  await assert.rejects(fs.access(fileC));
});
