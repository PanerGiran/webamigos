// Comentarios, reacciones e historial del chat.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { notifyLater, snippet } from '../push.js';

const router = Router();
export default router;
router.use(requireAuth);

export const EMOJIS = ['❤️', '😂', '🔥', '😮', '😢', '👍'];
const CHAT_PAGE = 50;

// { post_id: [{ emoji, count, mine }] } para varios posts de una vez.
export async function reactionSummary(postIds, userId) {
  const out = Object.fromEntries(postIds.map((id) => [id, []]));
  if (!postIds.length) return out;
  const [rows] = await pool.execute(
    `SELECT post_id, emoji, COUNT(*) AS n, MAX(user_id = ?) AS mine
       FROM reactions WHERE post_id IN (${postIds.map(() => '?').join(',')})
      GROUP BY post_id, emoji`,
    [userId, ...postIds],
  );
  for (const r of rows) out[r.post_id].push({ emoji: r.emoji, count: r.n, mine: !!r.mine });
  return out;
}

export async function commentCounts(postIds) {
  if (!postIds.length) return {};
  const [rows] = await pool.execute(
    `SELECT post_id, COUNT(*) AS n FROM comments WHERE post_id IN (${postIds.map(() => '?').join(',')}) GROUP BY post_id`,
    postIds,
  );
  return Object.fromEntries(rows.map((r) => [r.post_id, r.n]));
}

async function livePost(id) {
  const [[p]] = await pool.execute(
    'SELECT p.id, p.user_id, p.scope, u.username FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.deleted_at IS NULL',
    [id],
  );
  return p;
}

const COMMENT_SELECT = `SELECT c.id, c.post_id, c.body, c.created_at, c.edited_at, c.user_id, u.username, u.display_name, u.avatar
                          FROM comments c JOIN users u ON u.id = c.user_id`;
const commentBody = z.object({ body: z.string().trim().min(1).max(1000) });
const reactionBody = z.object({ emoji: z.enum(EMOJIS), on: z.boolean() });
const commentLimit = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req) => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false });

router.get('/posts/:id/comments', async (req, res) => {
  const post = await livePost(req.params.id);
  if (!post) return res.status(404).json({ error: 'no existe' });
  const [comments] = await pool.execute(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.id`, [post.id]);
  res.json({ comments });
});

router.post('/posts/:id/comments', commentLimit, async (req, res) => {
  const r = commentBody.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: 'El comentario tiene que tener entre 1 y 1000 caracteres.' });
  const post = await livePost(req.params.id);
  if (!post) return res.status(404).json({ error: 'no existe' });
  const [ins] = await pool.execute('INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)', [post.id, req.user.id, r.data.body]);
  const [[comment]] = await pool.execute(`${COMMENT_SELECT} WHERE c.id = ?`, [ins.insertId]);
  if (post.user_id !== req.user.id) {
    notifyLater(
      'comments',
      { title: `${req.user.display_name} comentó tu post`, body: snippet(r.data.body), url: post.scope === 'profile' ? `/u/${post.username}` : '/', tag: `comments-${post.id}` },
      { to: [post.user_id] },
    );
  }
  res.status(201).json({ comment });
});

router.patch('/comments/:id', async (req, res) => {
  const r = commentBody.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: 'El comentario tiene que tener entre 1 y 1000 caracteres.' });
  const [[c]] = await pool.execute('SELECT id, user_id FROM comments WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'no existe' });
  if (c.user_id !== req.user.id) return res.status(403).json({ error: 'Solo el autor puede editarlo.' });
  await pool.execute('UPDATE comments SET body = ?, edited_at = NOW() WHERE id = ?', [r.data.body, c.id]);
  const [[comment]] = await pool.execute(`${COMMENT_SELECT} WHERE c.id = ?`, [c.id]);
  res.json({ comment });
});

router.delete('/comments/:id', async (req, res) => {
  const [[c]] = await pool.execute('SELECT id, user_id FROM comments WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'no existe' });
  if (c.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'no es tuyo' });
  await pool.execute('DELETE FROM comments WHERE id = ?', [c.id]);
  res.status(204).end();
});

router.put('/posts/:id/reactions', async (req, res) => {
  const r = reactionBody.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: 'reacción inválida' });
  const post = await livePost(req.params.id);
  if (!post) return res.status(404).json({ error: 'no existe' });
  await pool.execute(
    r.data.on
      ? 'INSERT IGNORE INTO reactions (post_id, user_id, emoji) VALUES (?, ?, ?)'
      : 'DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?',
    [post.id, req.user.id, r.data.emoji],
  );
  res.json({ reactions: (await reactionSummary([post.id], req.user.id))[post.id] });
});

// Historial del chat: los últimos 50, en orden cronológico; ?before=<id> para ir más atrás.
router.get('/messages', async (req, res) => {
  const before = Number.parseInt(req.query.before, 10);
  const [rows] = await pool.execute(
    `SELECT m.id, m.body, m.created_at, m.user_id, u.username, u.display_name, u.avatar
       FROM messages m JOIN users u ON u.id = m.user_id
      ${before > 0 ? 'WHERE m.id < ?' : ''}
      ORDER BY m.id DESC LIMIT ${CHAT_PAGE}`,
    before > 0 ? [before] : [],
  );
  res.json({ messages: rows.reverse(), more: rows.length === CHAT_PAGE });
});

// Perfil público de alguien (las cuentas eliminadas no tienen perfil).
router.get('/users/:username', async (req, res) => {
  const [[u]] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.avatar_full, u.role, u.created_at,
            SUM(p.scope = 'profile') AS profile_count, SUM(p.scope = 'feed') AS feed_count
       FROM users u LEFT JOIN posts p ON p.user_id = u.id AND p.deleted_at IS NULL
      WHERE u.username = ? AND u.deleted_at IS NULL
      GROUP BY u.id`,
    [req.params.username],
  );
  if (!u) return res.status(404).json({ error: 'Ese perfil no existe.' });
  res.json({ user: { ...u, profile_count: Number(u.profile_count ?? 0), feed_count: Number(u.feed_count ?? 0) } });
});
