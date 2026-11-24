// Uso: npm run create-user -- <usuario> "<Nombre>" [admin]
import { pool } from '../src/db.js';
import { createInvite, inviteLink } from '../src/auth.js';

const [username, displayName, role = 'member'] = process.argv.slice(2);
if (!/^[a-z0-9_]{3,32}$/.test(username ?? '') || !displayName || !['admin', 'member'].includes(role) || !process.env.ORIGIN) {
  console.error('uso: npm run create-user -- <usuario a-z0-9_> "<Nombre>" [admin]   (requiere ORIGIN en .env)');
  process.exit(1);
}

try {
  const [r] = await pool.execute('INSERT INTO users (username, display_name, role) VALUES (?, ?, ?)', [
    username,
    displayName.slice(0, 64),
    role,
  ]);
  const link = inviteLink(await createInvite(r.insertId));
  console.log(`Invitación (vale 48 h, un solo uso):\n${link}`);
} catch (e) {
  console.error(e.code === 'ER_DUP_ENTRY' ? `el usuario "${username}" ya existe` : e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
