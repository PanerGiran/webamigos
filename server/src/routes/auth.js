import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { createSession, hashPassword, requireAuth, sha256, verifyPassword } from '../auth.js';
import { parseCrop, removeFile, saveImage, upload, uploadLimit } from '../images.js';

const router = Router();
export default router;

// Solo cuentan los intentos fallidos, así el uso normal nunca se bloquea.
const limits = { windowMs: 15 * 60_000, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false };
const byIp = rateLimit({ ...limits, limit: 20 });
const byUser = rateLimit({ ...limits, limit: 10, keyGenerator: (req) => String(req.body?.username ?? '').toLowerCase() });

const newPassword = z.string().min(10).max(200);
const loginBody = z.object({ username: z.string().max(32), password: z.string().max(200) });
const acceptBody = z.object({ token: z.string().max(100), password: newPassword });
const passwordBody = z.object({ current_password: z.string().max(200), new_password: newPassword });
const invalid = (res) => res.status(400).json({ error: 'datos inválidos' });

router.post('/login', byIp, byUser, async (req, res) => {
  const r = loginBody.safeParse(req.body);
  if (!r.success) return invalid(res);
  const [[u]] = await pool.execute('SELECT id, password_hash FROM users WHERE username = ? AND is_active = 1', [r.data.username]);
  const ok = await verifyPassword(u?.password_hash, r.data.password);
  if (!ok || !u?.password_hash) return res.status(401).json({ error: 'usuario o contraseña incorrectos' });
  await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]);
  res.json({ token: await createSession(u.id, req.get('user-agent')) });
});

router.post('/invite/accept', byIp, async (req, res) => {
  const r = acceptBody.safeParse(req.body);
  if (!r.success) return invalid(res);
  const hash = await hashPassword(r.data.password);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[inv]] = await conn.execute(
      `SELECT i.id, i.user_id FROM invites i JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > NOW() AND u.is_active = 1
        FOR UPDATE`,
      [sha256(r.data.token)],
    );
    if (!inv) {
      await conn.rollback();
      return res.status(400).json({ error: 'invitación inválida o vencida' });
    }
    await conn.execute('UPDATE invites SET used_at = NOW() WHERE id = ?', [inv.id]);
    await conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, inv.user_id]);
    await conn.execute('DELETE FROM sessions WHERE user_id = ?', [inv.user_id]);
    const token = await createSession(inv.user_id, req.get('user-agent'), conn);
    await conn.commit();
    res.json({ token });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  await pool.execute('DELETE FROM sessions WHERE id = ?', [req.sessionId]);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => res.json(req.user));

router.post('/me/password', requireAuth, byIp, async (req, res) => {
  const r = passwordBody.safeParse(req.body);
  if (!r.success) return invalid(res);
  const [[u]] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await verifyPassword(u.password_hash, r.data.current_password))) {
    return res.status(400).json({ error: 'la contraseña actual no coincide' });
  }
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(r.data.new_password), req.user.id]);
  await pool.execute('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [req.user.id, req.sessionId]);
  res.status(204).end();
});

// --- Foto de perfil ---

// Las fotos anteriores (recortada y completa) no las usa nadie más: se borran del disco y de media.
async function dropAvatar(userId) {
  const [[old]] = await pool.execute('SELECT avatar, avatar_full FROM users WHERE id = ?', [userId]);
  for (const f of [old.avatar, old.avatar_full].filter(Boolean)) {
    await removeFile(f);
    await pool.execute('DELETE FROM media WHERE filename = ?', [f]);
  }
}

// Se guardan dos versiones: 256x256 recortada para los avatares y la completa para verla en grande.
router.put('/me/avatar', requireAuth, uploadLimit, upload.single('image'), async (req, res) => {
  const crop = parseCrop(req.body?.crop); // encuadre elegido en el editor (opcional)
  if (crop === null) return res.status(400).json({ error: 'Encuadre inválido.' });
  const small = req.file && (await saveImage(req.file.buffer, req.user.id, { avatar: true, crop }).catch(() => null));
  if (!small) return res.status(400).json({ error: 'Imagen inválida (JPEG, PNG, WebP o GIF).' });
  const full = await saveImage(req.file.buffer, req.user.id);
  await dropAvatar(req.user.id);
  await pool.execute('UPDATE users SET avatar = ?, avatar_full = ? WHERE id = ?', [small.filename, full.filename, req.user.id]);
  res.json({ avatar: small.filename, avatar_full: full.filename });
});

router.delete('/me/avatar', requireAuth, async (req, res) => {
  await dropAvatar(req.user.id);
  await pool.execute('UPDATE users SET avatar = NULL, avatar_full = NULL WHERE id = ?', [req.user.id]);
  res.status(204).end();
});

// --- Nombre, bio y portada ---

const profileBody = z.object({ display_name: z.string().trim().min(1).max(64), bio: z.string().trim().max(300) }).partial();

router.patch('/me/profile', requireAuth, async (req, res) => {
  const r = profileBody.safeParse(req.body);
  if (!r.success || !Object.keys(r.data).length) return res.status(400).json({ error: 'Nombre: 1 a 64 caracteres. Bio: hasta 300.' });
  const cols = Object.keys(r.data); // vienen del esquema de zod: se pueden usar como columnas
  await pool.execute(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => r.data[c] || null), req.user.id]);
  const [[u]] = await pool.execute('SELECT display_name, bio FROM users WHERE id = ?', [req.user.id]);
  res.json(u);
});

async function dropCover(userId) {
  const [[old]] = await pool.execute('SELECT cover FROM users WHERE id = ?', [userId]);
  if (!old.cover) return;
  await removeFile(old.cover);
  await pool.execute('DELETE FROM media WHERE filename = ?', [old.cover]);
}

router.put('/me/cover', requireAuth, uploadLimit, upload.single('image'), async (req, res) => {
  const crop = parseCrop(req.body?.crop);
  if (crop === null) return res.status(400).json({ error: 'Encuadre inválido.' });
  const img = req.file && (await saveImage(req.file.buffer, req.user.id, { cover: true, crop }).catch(() => null));
  if (!img) return res.status(400).json({ error: 'Imagen inválida (JPEG, PNG, WebP o GIF).' });
  await dropCover(req.user.id);
  await pool.execute('UPDATE users SET cover = ? WHERE id = ?', [img.filename, req.user.id]);
  res.json({ cover: img.filename });
});

router.delete('/me/cover', requireAuth, async (req, res) => {
  await dropCover(req.user.id);
  await pool.execute('UPDATE users SET cover = NULL WHERE id = ?', [req.user.id]);
  res.status(204).end();
});
