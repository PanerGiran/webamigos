// Comentarios, reacciones e historial del chat.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { mentionedIds, notifyLater, snippet } from '../push.js';
import { mediaKind, removeMedia, saveAttachment, uploadAttachment } from '../media.js';

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

const COMMENT_SELECT = `SELECT c.id, c.post_id, c.body, c.created_at, c.edited_at, c.user_id, u.username, u.display_name, u.avatar,
                               m.filename, m.mime, m.width, m.height
                          FROM comments c JOIN users u ON u.id = c.user_id LEFT JOIN media m ON m.id = c.media_id`;
const commentWithMedia = ({ filename, mime, width, height, ...c }) => ({
  ...c,
  media: filename ? { filename, mime, kind: mediaKind(mime), width, height } : null,
});
const commentBody = z.object({ body: z.string().trim().max(1000) });
const commentBodyError = 'El comentario necesita texto (hasta 1000 caracteres) o un adjunto.';
const attachmentLabel = { image: 'una foto', video: 'un video', audio: 'un audio' };
const reactionBody = z.object({ emoji: z.enum(EMOJIS), on: z.boolean() });
const commentLimit = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req) => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false });

router.get('/posts/:id/comments', async (req, res) => {
  const post = await livePost(req.params.id);
  if (!post) return res.status(404).json({ error: 'no existe' });
  const [comments] = await pool.execute(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.id`, [post.id]);
  res.json({ comments: comments.map(commentWithMedia) });
});

router.post('/posts/:id/comments', commentLimit, uploadAttachment, async (req, res) => {
  const r = commentBody.safeParse(req.file && req.body?.body === undefined ? { body: '' } : req.body);
  if (!r.success || (!r.data.body && !req.file)) return res.status(400).json({ error: commentBodyError });
  const { body } = r.data;
  const post = await livePost(req.params.id);
  if (!post) return res.status(404).json({ error: 'no existe' });
  const attachment = req.file ? await saveAttachment(req.file, req.user.id) : null;
  if (req.file && !attachment) return res.status(400).json({ error: 'El adjunto no es válido. Las fotos y los audios admiten hasta 5 MB.' });

  let commentId;
  try {
    const [ins] = await pool.execute('INSERT INTO comments (post_id, user_id, body, media_id) VALUES (?, ?, ?, ?)', [post.id, req.user.id, body, attachment?.id ?? null]);
    commentId = ins.insertId;
  } catch (err) {
    if (attachment) await removeMedia(attachment.id);
    throw err;
  }
  const [[comment]] = await pool.execute(`${COMMENT_SELECT} WHERE c.id = ?`, [commentId]);
  const url = post.scope === 'profile' ? `/u/${post.username}` : '/';
  const pushBody = body ? snippet(body) : `📎 Mandó ${attachmentLabel[attachment.kind]}`;
  const toOwner = post.user_id !== req.user.id;
  if (toOwner) {
    notifyLater('comments', { title: `${req.user.display_name} comentó tu post`, body: pushBody, url, tag: `comments-${post.id}` }, { to: [post.user_id] });
  }
  // Al dueño del post ya le llegó "comentó tu post": no se le manda también "te mencionó".
  const mentioned = await mentionedIds(body, [req.user.id, ...(toOwner ? [post.user_id] : [])]);
  notifyLater('mentions', { title: `${req.user.display_name} te mencionó`, body: pushBody, url, tag: `comments-${post.id}` }, { to: mentioned });
  res.status(201).json({ comment: commentWithMedia(comment) });
});

router.patch('/comments/:id', async (req, res) => {
  const r = commentBody.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: commentBodyError });
  const [[c]] = await pool.execute('SELECT id, user_id, media_id FROM comments WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'no existe' });
  if (c.user_id !== req.user.id) return res.status(403).json({ error: 'Solo el autor puede editarlo.' });
  if (!r.data.body && !c.media_id) return res.status(400).json({ error: commentBodyError });
  await pool.execute('UPDATE comments SET body = ?, edited_at = NOW() WHERE id = ?', [r.data.body, c.id]);
  const [[comment]] = await pool.execute(`${COMMENT_SELECT} WHERE c.id = ?`, [c.id]);
  if (!comment) return res.status(404).json({ error: 'no existe' });
  res.json({ comment: commentWithMedia(comment) });
});

router.delete('/comments/:id', async (req, res) => {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [[c]] = await db.execute('SELECT id, user_id, media_id FROM comments WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!c || (c.user_id !== req.user.id && req.user.role !== 'admin')) {
      await db.rollback();
      return c ? res.status(403).json({ error: 'no es tuyo' }) : res.status(404).json({ error: 'no existe' });
    }
    await db.execute('DELETE FROM comments WHERE id = ?', [c.id]);
    if (c.media_id) await removeMedia(c.media_id, db);
    await db.commit();
    res.status(204).end();
  } catch (err) {
    await db.rollback();
    throw err;
  } finally {
    db.release();
  }
});

// Quiénes reaccionaron, agrupado por emoji (en el orden de EMOJIS).
router.get('/posts/:id/reactions', async (req, res) => {
  const post = await livePost(req.params.id);
  if (!post) return res.status(404).json({ error: 'no existe' });
  const [rows] = await pool.execute(
    `SELECT r.emoji, u.id, u.username, u.display_name, u.avatar
       FROM reactions r JOIN users u ON u.id = r.user_id
      WHERE r.post_id = ? AND u.deleted_at IS NULL ORDER BY u.display_name`,
    [post.id],
  );
  const reactions = EMOJIS.map((emoji) => ({ emoji, users: rows.filter((r) => r.emoji === emoji).map(({ emoji: _, ...u }) => u) })).filter((r) => r.users.length);
  res.json({ reactions });
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
// { message_id: [{ emoji, count, user_ids }] }. Con user_ids cada uno sabe si reaccionó (el chat se actualiza para todos a la vez).
export async function messageReactions(ids) {
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const [rows] = await pool.execute(
    `SELECT message_id, emoji, GROUP_CONCAT(user_id) AS users FROM message_reactions
      WHERE message_id IN (${ids.map(() => '?').join(',')}) GROUP BY message_id, emoji`,
    ids,
  );
  for (const r of rows) {
    const user_ids = r.users.split(',').map(Number);
    out[r.message_id].push({ emoji: r.emoji, count: user_ids.length, user_ids });
  }
  for (const id of ids) out[id].sort((a, b) => EMOJIS.indexOf(a.emoji) - EMOJIS.indexOf(b.emoji));
  return out;
}

// Lo que se muestra citado cuando un mensaje responde a otro.
export const quote = (r) => (r?.id ? { id: r.id, body: snippet(r.body, 140), username: r.username, display_name: r.display_name } : null);

router.get('/messages', async (req, res) => {
  const before = Number.parseInt(req.query.before, 10);
  const [rows] = await pool.execute(
    `SELECT m.id, m.body, m.created_at, m.user_id, u.username, u.display_name, u.avatar,
            r.id AS r_id, r.body AS r_body, ru.username AS r_username, ru.display_name AS r_display_name
       FROM messages m JOIN users u ON u.id = m.user_id
       LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
      ${before > 0 ? 'WHERE m.id < ?' : ''}
      ORDER BY m.id DESC LIMIT ${CHAT_PAGE}`,
    before > 0 ? [before] : [],
  );
  const reactions = await messageReactions(rows.map((m) => m.id));
  const messages = rows.reverse().map(({ r_id, r_body, r_username, r_display_name, ...m }) => ({
    ...m,
    reply: quote({ id: r_id, body: r_body, username: r_username, display_name: r_display_name }),
    reactions: reactions[m.id],
  }));
  res.json({ messages, more: rows.length === CHAT_PAGE });
});

// Todas las cuentas activas (para sugerir @menciones).
router.get('/users', async (req, res) => {
  const [users] = await pool.execute('SELECT id, username, display_name, avatar FROM users WHERE is_active = 1 AND deleted_at IS NULL ORDER BY display_name');
  res.json({ users });
});

// Perfil público de alguien (las cuentas eliminadas no tienen perfil).
router.get('/users/:username', async (req, res) => {
  const [[u]] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.avatar_full, u.bio, u.cover, u.role, u.created_at,
            SUM(p.scope = 'profile') AS profile_count, SUM(p.scope = 'feed') AS feed_count
       FROM users u LEFT JOIN posts p ON p.user_id = u.id AND p.deleted_at IS NULL
      WHERE u.username = ? AND u.deleted_at IS NULL
      GROUP BY u.id`,
    [req.params.username],
  );
  if (!u) return res.status(404).json({ error: 'Ese perfil no existe.' });
  res.json({ user: { ...u, profile_count: Number(u.profile_count ?? 0), feed_count: Number(u.feed_count ?? 0) } });
});
