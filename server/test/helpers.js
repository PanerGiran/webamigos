// Servidor de prueba + usuarios temporales que se borran al terminar.
import { after } from 'node:test';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';
import { createSession } from '../src/auth.js';
import { attachChat } from '../src/ws.js';

export const server = app.listen(0, '127.0.0.1');
attachChat(server);
await once(server, 'listening');
export const port = server.address().port;
export const base = `http://127.0.0.1:${port}/api`;

const ids = [];
after(async () => {
  if (ids.length) {
    const q = ids.map(() => '?').join(',');
    for (const sql of [
      `DELETE FROM messages WHERE user_id IN (${q})`,
      `DELETE FROM posts WHERE user_id IN (${q})`, // arrastra comentarios y reacciones
      `DELETE FROM comments WHERE user_id IN (${q})`,
      `DELETE FROM reactions WHERE user_id IN (${q})`,
      `DELETE FROM media WHERE user_id IN (${q})`,
      `DELETE FROM users WHERE id IN (${q})`,
    ]) await pool.execute(sql, ids);
  }
  server.closeAllConnections();
  server.close();
  await pool.end();
});

export async function makeUser(role = 'member') {
  const username = 't' + crypto.randomUUID().slice(0, 8);
  const [r] = await pool.execute('INSERT INTO users (username, display_name, role) VALUES (?, ?, ?)', [username, `Test ${username}`, role]);
  ids.push(r.insertId);
  return { id: r.insertId, username, token: await createSession(r.insertId, 'test') };
}

export const call = (user, path, { json, method = json ? 'POST' : 'GET' } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(user && { authorization: `Bearer ${user.token}` }) },
    body: json && JSON.stringify(json),
  });
