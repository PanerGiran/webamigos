// Uso: npm run reset-user -- <usuario>
// Borra la contraseña y cierra todas las sesiones al instante (por si la cuenta está comprometida),
// y genera una invitación nueva para que el usuario elija otra.
import { pool } from '../src/db.js';
import { inviteLink, resetAccess } from '../src/auth.js';

const [username] = process.argv.slice(2);
if (!username || !process.env.ORIGIN) {
  console.error('uso: npm run reset-user -- <usuario>   (requiere ORIGIN en .env)');
  process.exit(1);
}

try {
  const [[u]] = await pool.execute('SELECT id FROM users WHERE username = ? AND deleted_at IS NULL', [username]);
  if (!u) throw new Error(`no existe el usuario "${username}"`);
  console.log(`Invitación nueva (vale 48 h, un solo uso):\n${inviteLink(await resetAccess(u.id))}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
