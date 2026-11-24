// Suscripción a notificaciones (por dispositivo) y preferencias (por usuario).
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { publicKey } from '../push.js';

const router = Router();
export default router;
router.use(requireAuth);

const subscription = z.object({
  endpoint: z.string().url().startsWith('https://').max(500),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(50) }),
});
const prefsBody = z.object({ posts: z.boolean(), comments: z.boolean(), chat: z.boolean(), mentions: z.boolean() }).partial();

router.get('/push/key', (req, res) => {
  const key = publicKey();
  key ? res.json({ key }) : res.status(503).json({ error: 'Las notificaciones no están configuradas en el servidor.' });
});

// Si el dispositivo ya estaba suscripto (otra sesión u otro usuario), pasa a esta sesión.
router.post('/push/subscribe', async (req, res) => {
  const r = subscription.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: 'suscripción inválida' });
  const { endpoint, keys } = r.data;
  await pool.execute(
    `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), session_id = VALUES(session_id), p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [req.user.id, req.sessionId, endpoint, keys.p256dh, keys.auth],
  );
  res.status(204).end();
});

router.delete('/push/subscribe', async (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  await pool.execute('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.id]);
  res.status(204).end();
});

router.get('/me/notifications', async (req, res) => {
  const [[u]] = await pool.execute('SELECT notify_posts, notify_comments, notify_chat, notify_mentions FROM users WHERE id = ?', [req.user.id]);
  res.json({ posts: !!u.notify_posts, comments: !!u.notify_comments, chat: !!u.notify_chat, mentions: !!u.notify_mentions });
});

router.patch('/me/notifications', async (req, res) => {
  const r = prefsBody.safeParse(req.body);
  if (!r.success || !Object.keys(r.data).length) return res.status(400).json({ error: 'datos inválidos' });
  // Las claves vienen del esquema de zod (descarta el resto): se pueden usar como nombres de columna.
  const cols = Object.keys(r.data);
  await pool.execute(`UPDATE users SET ${cols.map((c) => `notify_${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => Number(r.data[c])), req.user.id]);
  res.status(204).end();
});
