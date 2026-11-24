// Correr con la base de prueba: UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';
import { createSession } from '../src/auth.js';

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api`;

const prefix = 'a' + crypto.randomUUID().slice(0, 6);
after(async () => {
  await pool.execute('DELETE FROM users WHERE username LIKE ?', [`${prefix}%`]);
  server.close();
  await pool.end();
});

let n = 0;
async function makeUser(role = 'member') {
  const [r] = await pool.execute('INSERT INTO users (username, display_name, role) VALUES (?, ?, ?)', [`${prefix}${n++}`, 'Test', role]);
  return { id: r.insertId, token: await createSession(r.insertId, 'test') };
}
const call = (path, { token, json, method = json ? 'POST' : 'GET' } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: json && JSON.stringify(json),
  });
const tokenFrom = (link) => link.split('/invite/')[1];
const accept = (link, password) => call('/invite/accept', { json: { token: tokenFrom(link), password } });
const login = (username, password) => call('/login', { json: { username, password } });

test('solo los admins entran al panel', async () => {
  const member = await makeUser();
  assert.equal((await call('/admin/users')).status, 401);
  assert.equal((await call('/admin/users', { token: member.token })).status, 403);
  assert.equal((await call('/admin/users', { token: member.token, json: { username: `${prefix}x`, display_name: 'X' } })).status, 403);
});

test('crear cuenta → link → bloquear → resetear → eliminar (lógico)', async () => {
  const admin = await makeUser('admin');
  const username = `${prefix}nuevo`;

  // Crear y aceptar la invitación.
  assert.equal((await call('/admin/users', { token: admin.token, json: { username: 'Mal Nombre', display_name: 'X' } })).status, 400);
  let res = await call('/admin/users', { token: admin.token, json: { username, display_name: 'Nuevo' } });
  assert.equal(res.status, 201);
  const { id, link } = await res.json();
  assert.match(link, /\/invite\/[\w-]{40,}$/);
  assert.equal((await call('/admin/users', { token: admin.token, json: { username, display_name: 'Otro' } })).status, 409);

  let listed = (await (await call('/admin/users', { token: admin.token })).json()).users.find((u) => u.id === id);
  assert.equal(listed.pending, true);
  assert.ok(new Date(listed.invite_expires_at) > new Date());

  res = await accept(link, 'clave-nueva-1');
  assert.equal(res.status, 200);
  const userToken = (await res.json()).token;
  listed = (await (await call('/admin/users', { token: admin.token })).json()).users.find((u) => u.id === id);
  assert.equal(listed.pending, false);

  // Renombrar y hacer admin.
  assert.equal((await call(`/admin/users/${id}`, { token: admin.token, method: 'PATCH', json: { display_name: '  Nuevo Nombre ', role: 'admin' } })).status, 204);
  let me = await (await call('/me', { token: userToken })).json();
  assert.deepEqual([me.display_name, me.role], ['Nuevo Nombre', 'admin']);
  assert.equal((await call(`/admin/users/${id}`, { token: admin.token, method: 'PATCH', json: { role: 'jefe' } })).status, 400);

  // Bloquear: se le cierran las sesiones y no puede entrar.
  assert.equal((await call(`/admin/users/${id}`, { token: admin.token, method: 'PATCH', json: { is_active: false } })).status, 204);
  assert.equal((await call('/me', { token: userToken })).status, 401);
  assert.equal((await login(username, 'clave-nueva-1')).status, 401);
  assert.equal((await call(`/admin/users/${id}`, { token: admin.token, method: 'PATCH', json: { is_active: true } })).status, 204);
  res = await login(username, 'clave-nueva-1');
  assert.equal(res.status, 200, 'desbloqueado entra de nuevo');
  const userToken2 = (await res.json()).token;

  // Resetear acceso: la clave vieja y las sesiones dejan de servir, el link nuevo sí.
  res = await call(`/admin/users/${id}/invite`, { token: admin.token, json: {} });
  assert.equal(res.status, 200);
  const link2 = (await res.json()).link;
  assert.equal((await call('/me', { token: userToken2 })).status, 401);
  assert.equal((await login(username, 'clave-nueva-1')).status, 401);
  assert.equal((await accept(link, 'clave-nueva-2')).status, 400, 'el link viejo ya no vale');
  assert.equal((await accept(link2, 'clave-nueva-2')).status, 200);

  // Eliminar: no aparece, no entra, pero la fila queda.
  assert.equal((await call(`/admin/users/${id}`, { token: admin.token, method: 'DELETE' })).status, 204);
  assert.equal((await login(username, 'clave-nueva-2')).status, 401);
  const users = (await (await call('/admin/users', { token: admin.token })).json()).users;
  assert.ok(!users.some((u) => u.id === id));
  const [[row]] = await pool.execute('SELECT deleted_at, is_active FROM users WHERE id = ?', [id]);
  assert.ok(row.deleted_at, 'borrado lógico: la fila sigue');
  assert.equal(row.is_active, 0);
  const [[{ n: sesiones }]] = await pool.execute('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [id]);
  assert.equal(sesiones, 0);
  assert.equal((await call(`/admin/users/${id}`, { token: admin.token, method: 'PATCH', json: { is_active: true } })).status, 404, 'no se puede revivir por PATCH');
  assert.equal((await call(`/admin/users/${id}/invite`, { token: admin.token, json: {} })).status, 404);
});

test('un admin no puede bloquearse, eliminarse ni quitarse el admin', async () => {
  const admin = await makeUser('admin');
  const self = (method, json) => call(`/admin/users/${admin.id}`, { token: admin.token, method, json });
  assert.equal((await self('PATCH', { is_active: false })).status, 400);
  assert.equal((await self('PATCH', { role: 'member' })).status, 400);
  assert.equal((await self('DELETE')).status, 400);
  assert.equal((await call(`/admin/users/${admin.id}/invite`, { token: admin.token, json: {} })).status, 400);
  assert.equal((await self('PATCH', { display_name: 'Yo' })).status, 204, 'renombrarse sí');
  assert.equal((await call('/me', { token: admin.token })).status, 200);
});
