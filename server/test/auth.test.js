// Necesita una MySQL con schema.sql cargado y las variables DB_* (en .env).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';
import { createInvite } from '../src/auth.js';

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => {
  server.close();
  await pool.end();
});

const call = (path, { token, body, method = body ? 'POST' : 'GET' } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });

test('invitación → login → me → cambio de clave → logout', async () => {
  const username = 't' + Date.now().toString(36);
  const [r] = await pool.execute('INSERT INTO users (username, display_name) VALUES (?, ?)', [username, 'Test']);
  try {
    const invite = await createInvite(r.insertId);
    assert.equal((await call('/me')).status, 401);
    assert.equal((await call('/login', { body: { username, password: 'lo-que-sea-123' } })).status, 401, 'sin clave no entra');
    assert.equal((await call('/invite/accept', { body: { token: invite, password: 'corta' } })).status, 400);

    let res = await call('/invite/accept', { body: { token: invite, password: 'clave-larga-1' } });
    assert.equal(res.status, 200);
    const t1 = (await res.json()).token;
    assert.equal((await call('/invite/accept', { body: { token: invite, password: 'clave-larga-1' } })).status, 400, 'un solo uso');

    res = await call('/me', { token: t1 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).username, username);

    assert.equal((await call('/login', { body: { username, password: 'clave-mala-123' } })).status, 401);
    res = await call('/login', { body: { username, password: 'clave-larga-1' } });
    assert.equal(res.status, 200);
    const t2 = (await res.json()).token;

    const change = { current_password: 'clave-larga-1', new_password: 'clave-larga-2' };
    assert.equal((await call('/me/password', { token: t2, body: { ...change, current_password: 'otra-cosa-12' } })).status, 400);
    assert.equal((await call('/me/password', { token: t2, body: change })).status, 204);
    assert.equal((await call('/me', { token: t1 })).status, 401, 'las otras sesiones se revocan');
    assert.equal((await call('/me', { token: t2 })).status, 200, 'la actual sigue');
    assert.equal((await call('/login', { body: { username, password: 'clave-larga-1' } })).status, 401, 'la clave vieja ya no sirve');

    assert.equal((await call('/logout', { token: t2, method: 'POST' })).status, 204);
    assert.equal((await call('/me', { token: t2 })).status, 401);
  } finally {
    await pool.execute('DELETE FROM users WHERE id = ?', [r.insertId]);
  }
});
