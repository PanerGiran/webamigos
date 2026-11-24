import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { createInvite, inviteLink, requireAdmin, requireAuth, resetAccess } from '../auth.js';

const router = Router();
export default router;
router.use(requireAuth, requireAdmin);

const username = z.string().regex(/^[a-z0-9_]{3,32}$/);
const displayName = z.string().trim().min(1).max(64);
const role = z.enum(['admin', 'member']);
const createBody = z.object({ username, display_name: displayName, role: role.default('member') });
// zod descarta las claves que no estén acá, así que se pueden usar como nombres de columna.
const patchBody = z.object({ display_name: displayName, role, is_active: z.boolean() }).partial();

const bad = (res, error) => res.status(400).json({ error });
const isSelf = (req) => Number(req.params.id) === req.user.id;

// Usuario no eliminado, o 404.
async function findUser(req, res) {
  const [[u]] = await pool.execute('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!u) res.status(404).json({ error: 'no existe' });
  return u;
}

router.get('/users', async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.role, u.is_active, u.password_hash IS NULL AS pending,
            u.created_at, u.last_login_at,
            (SELECT MAX(i.expires_at) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL) AS invite_expires_at
       FROM users u
      WHERE u.deleted_at IS NULL
      ORDER BY u.display_name`,
  );
  res.json({ users: rows.map((u) => ({ ...u, is_active: !!u.is_active, pending: !!u.pending })) });
});

router.post('/users', async (req, res) => {
  const r = createBody.safeParse(req.body);
  if (!r.success) return bad(res, 'Usuario: 3 a 32 caracteres (a-z, 0-9, _). Nombre: obligatorio.');
  try {
    const [ins] = await pool.execute('INSERT INTO users (username, display_name, role) VALUES (?, ?, ?)', [
      r.data.username,
      r.data.display_name,
      r.data.role,
    ]);
    res.status(201).json({ id: ins.insertId, link: inviteLink(await createInvite(ins.insertId)) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese usuario ya existe (o existió y fue eliminado).' });
    throw e;
  }
});

router.post('/users/:id/invite', async (req, res) => {
  if (isSelf(req)) return bad(res, 'Para tu cuenta usá "Cambiar contraseña" en tu perfil.');
  const u = await findUser(req, res);
  if (u) res.json({ link: inviteLink(await resetAccess(u.id)) });
});

router.patch('/users/:id', async (req, res) => {
  const r = patchBody.safeParse(req.body);
  if (!r.success || !Object.keys(r.data).length) return bad(res, 'datos inválidos');
  if (isSelf(req) && (r.data.role === 'member' || r.data.is_active === false)) {
    return bad(res, 'No podés quitarte el admin ni bloquearte a vos mismo.');
  }
  const u = await findUser(req, res);
  if (!u) return;
  const cols = Object.keys(r.data);
  await pool.execute(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...cols.map((c) => (typeof r.data[c] === 'boolean' ? Number(r.data[c]) : r.data[c])),
    u.id,
  ]);
  if (r.data.is_active === false) await pool.execute('DELETE FROM sessions WHERE user_id = ?', [u.id]);
  res.status(204).end();
});

// Borrado lógico: la fila y sus posts quedan, pero no puede entrar más (is_active = 0 lo frena en login, sesión e invitación).
router.delete('/users/:id', async (req, res) => {
  if (isSelf(req)) return bad(res, 'No podés eliminar tu propia cuenta.');
  const u = await findUser(req, res);
  if (!u) return;
  await pool.execute('UPDATE users SET deleted_at = NOW(), is_active = 0 WHERE id = ?', [u.id]);
  await pool.execute('DELETE FROM sessions WHERE user_id = ?', [u.id]);
  await pool.execute('UPDATE invites SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [u.id]);
  res.status(204).end();
});
