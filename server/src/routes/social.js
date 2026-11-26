// Comentarios, reacciones e historial del chat.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { mentionedIds, notifyLater, snippet } from '../push.js';
import { mediaKind, removeMedia, saveAttachment, uploadAttachment } from '../media.js';
import { saveImage, upload, uploadLimit } from '../images.js';
import { parsePoll } from '../polls.js';
import { live } from '../live.js';

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
    notifyLater('comments', { title: `${req.user.display_name} comentó tu post`, body: pushBody, url, tag: `comments-${post.id}` }, { to: [post.user_id], from: req.user });
  }
  // Al dueño del post ya le llegó "comentó tu post": no se le manda también "te mencionó".
  const mentioned = await mentionedIds(body, [req.user.id, ...(toOwner ? [post.user_id] : [])]);
  notifyLater('mentions', { title: `${req.user.display_name} te mencionó`, body: pushBody, url, tag: `comments-${post.id}` }, { to: mentioned, from: req.user });
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

// Encuestas del chat: { message_id: { options: [{ id, text, votes, user_ids }], total } }.
// Con user_ids cada app sabe si votó (las actualizaciones llegan a todos a la vez).
export async function chatPolls(ids) {
  if (!ids.length) return {};
  const [rows] = await pool.execute(
    `SELECT o.id, o.message_id, o.text, GROUP_CONCAT(v.user_id) AS users
       FROM chat_poll_options o LEFT JOIN chat_poll_votes v ON v.option_id = o.id
      WHERE o.message_id IN (${ids.map(() => '?').join(',')}) GROUP BY o.id ORDER BY o.message_id, o.position`,
    ids,
  );
  const out = {};
  for (const r of rows) {
    const user_ids = r.users ? r.users.split(',').map(Number) : [];
    const poll = (out[r.message_id] ??= { options: [], total: 0 });
    poll.options.push({ id: r.id, text: r.text, votes: user_ids.length, user_ids });
    poll.total += user_ids.length;
  }
  return out;
}

// Mensajes del chat con su cita, reacciones, adjunto y encuesta (historial y mensajes nuevos).
export async function loadMessages(where = '', params = [], limit = CHAT_PAGE) {
  const [rows] = await pool.execute(
    `SELECT m.id, m.body, m.created_at, m.user_id, m.sticker_id, u.username, u.display_name, u.avatar,
            r.id AS r_id, r.body AS r_body, ru.username AS r_username, ru.display_name AS r_display_name,
            r.sticker_id AS r_sticker, r.media_id AS r_media,
            md.filename, md.mime, md.width, md.height,
            sm.filename AS s_filename, sm.width AS s_width, sm.height AS s_height,
            m.story_user_id, su.username AS su_username, su.display_name AS su_display_name,
            so.id AS so_id, so.body AS so_body, so.bg AS so_bg, som.filename AS so_filename, som.width AS so_width, som.height AS so_height
       FROM messages m JOIN users u ON u.id = m.user_id
       LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
       LEFT JOIN media md ON md.id = m.media_id
       LEFT JOIN stickers st ON st.id = m.sticker_id LEFT JOIN media sm ON sm.id = st.media_id
       LEFT JOIN users su ON su.id = m.story_user_id
       LEFT JOIN stories so ON so.id = m.story_id AND so.expires_at > NOW() LEFT JOIN media som ON som.id = so.media_id
      ${where ? `WHERE ${where}` : ''}
      ORDER BY m.id DESC LIMIT ${limit}`,
    params,
  );
  const ids = rows.map((m) => m.id);
  const [reactions, polls] = await Promise.all([messageReactions(ids), chatPolls(ids)]);
  const messages = rows.reverse().map(({ r_id, r_body, r_username, r_display_name, r_sticker, r_media, filename, mime, width, height, s_filename, s_width, s_height, sticker_id,
    story_user_id, su_username, su_display_name, so_id, so_body, so_bg, so_filename, so_width, so_height, ...m }) => ({
    ...m,
    // Respuesta a una historia: de quién era y, mientras no venza, cómo se veía (id null = ya no está).
    story: story_user_id
      ? { id: so_id, user_id: story_user_id, username: su_username, display_name: su_display_name, body: so_id ? so_body : null, bg: so_bg, image: so_filename ? { filename: so_filename, width: so_width, height: so_height } : null }
      : null,
    // Si responde a un sticker o a un adjunto sin texto, la cita dice qué era.
    reply: quote({ id: r_id, body: r_body || (r_sticker ? 'Sticker' : r_media ? 'Adjunto' : ''), username: r_username, display_name: r_display_name }),
    sticker: s_filename ? { id: sticker_id, filename: s_filename, width: s_width, height: s_height } : null,
    reactions: reactions[m.id],
    media: filename ? { filename, mime, kind: mediaKind(mime), width, height } : null,
    poll: polls[m.id] ?? null,
  }));
  return { messages, more: rows.length === limit };
}

router.get('/messages', async (req, res) => {
  const before = Number.parseInt(req.query.before, 10);
  res.json(await loadMessages(before > 0 ? 'm.id < ?' : '', before > 0 ? [before] : []));
});

// Mensaje del chat: texto, foto/audio, encuesta o sticker (llega a todos por la conexión en vivo).
// Hasta 10 cada 10 s por persona, sin importar cuántas pestañas tenga abiertas.
const chatLimit = rateLimit({ windowMs: 10_000, limit: 10, keyGenerator: (req) => String(req.user.id), message: { error: 'Más despacio 🙂' }, standardHeaders: 'draft-8', legacyHeaders: false });
router.post('/messages', chatLimit, uploadAttachment, async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  const poll = parsePoll(req.body?.poll);
  if (body.length > 2000) return res.status(400).json({ error: 'El mensaje es muy largo (hasta 2000 caracteres).' });
  if (poll.error) return res.status(400).json({ error: 'La encuesta necesita de 2 a 6 opciones distintas.' });
  if (poll.options && !body) return res.status(400).json({ error: 'Escribí la pregunta de la encuesta.' });
  const stickerId = Number.parseInt(req.body?.sticker_id, 10);
  if (stickerId > 0 && (body || req.file || poll.options)) return res.status(400).json({ error: 'El sticker va solo.' });
  if (!body && !req.file && !poll.options && !(stickerId > 0)) return res.status(400).json({ error: 'El mensaje está vacío.' });
  const [[sticker]] = stickerId > 0 ? await pool.execute('SELECT id FROM stickers WHERE id = ? AND deleted_at IS NULL', [stickerId]) : [[]];
  if (stickerId > 0 && !sticker) return res.status(400).json({ error: 'Ese sticker ya no está.' });
  // Respuesta a una historia: solo texto, y la historia tiene que seguir vigente.
  const storyId = Number.parseInt(req.body?.story_id, 10);
  if (storyId > 0 && (!body || req.file || poll.options || stickerId > 0)) return res.status(400).json({ error: 'Escribí la respuesta a la historia.' });
  const [[story]] = storyId > 0 ? await pool.execute('SELECT id, user_id FROM stories WHERE id = ? AND expires_at > NOW()', [storyId]) : [[]];
  if (storyId > 0 && !story) return res.status(400).json({ error: 'Esa historia ya no está.' });
  const replyId = Number.parseInt(req.body?.reply_to, 10);
  const [[replied]] = replyId > 0 ? await pool.execute('SELECT id FROM messages WHERE id = ?', [replyId]) : [[]];
  const attachment = req.file ? await saveAttachment(req.file, req.user.id) : null;
  if (req.file && !attachment) return res.status(400).json({ error: 'El adjunto no es válido. Las fotos y los audios admiten hasta 5 MB.' });

  let id;
  try {
    const [r] = await pool.execute(
      'INSERT INTO messages (user_id, body, reply_to, media_id, sticker_id, story_id, story_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, body, replied?.id ?? null, attachment?.id ?? null, sticker?.id ?? null, story?.id ?? null, story?.user_id ?? null],
    );
    id = r.insertId;
  } catch (err) {
    if (attachment) await removeMedia(attachment.id);
    throw err;
  }
  for (const [i, text] of (poll.options ?? []).entries()) await pool.execute('INSERT INTO chat_poll_options (message_id, position, text) VALUES (?, ?, ?)', [id, i, text]);
  const [message] = (await loadMessages('m.id = ?', [id], 1)).messages;
  live.publishChat(req.user, message);
  res.status(201).json({ message });
});

// Votar en una encuesta del chat (option_id: null saca el voto). La actualización llega a todos.
router.put('/messages/:id/vote', async (req, res) => {
  const optionId = req.body?.option_id;
  if (optionId !== null && !Number.isInteger(optionId)) return res.status(400).json({ error: 'voto inválido' });
  const [[m]] = await pool.execute('SELECT id FROM messages WHERE id = ?', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'no existe' });
  if (optionId === null) {
    await pool.execute('DELETE FROM chat_poll_votes WHERE message_id = ? AND user_id = ?', [m.id, req.user.id]);
  } else {
    const [[opt]] = await pool.execute('SELECT id FROM chat_poll_options WHERE id = ? AND message_id = ?', [optionId, m.id]);
    if (!opt) return res.status(400).json({ error: 'Esa opción no es de esta encuesta.' });
    await pool.execute(
      'INSERT INTO chat_poll_votes (message_id, user_id, option_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)',
      [m.id, req.user.id, opt.id],
    );
  }
  const poll = (await chatPolls([m.id]))[m.id] ?? null;
  live.broadcast({ type: 'poll', message_id: m.id, poll });
  res.json({ poll });
});

// Borrar un mensaje del chat (el autor o un admin). Reacciones y encuesta se van con él (ON DELETE CASCADE),
// las respuestas quedan sin cita y el adjunto se borra del disco. A todos les desaparece en vivo.
router.delete('/messages/:id', async (req, res) => {
  const db = await pool.getConnection();
  let id;
  try {
    await db.beginTransaction();
    const [[m]] = await db.execute('SELECT id, user_id, media_id FROM messages WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!m || (m.user_id !== req.user.id && req.user.role !== 'admin')) {
      await db.rollback();
      return m ? res.status(403).json({ error: 'Solo el autor puede borrarlo.' }) : res.status(404).json({ error: 'no existe' });
    }
    await db.execute('DELETE FROM messages WHERE id = ?', [m.id]);
    if (m.media_id) await removeMedia(m.media_id, db);
    await db.commit();
    id = m.id;
  } catch (err) {
    await db.rollback();
    throw err;
  } finally {
    db.release();
  }
  live.broadcast({ type: 'deleted', message_id: id });
  res.status(204).end();
});

// --- Stickers del grupo: los sube cualquiera y todos los pueden mandar ---
const STICKER_SELECT = 'SELECT s.id, s.user_id, md.filename, md.width, md.height FROM stickers s JOIN media md ON md.id = s.media_id';

router.get('/stickers', async (req, res) => {
  const [stickers] = await pool.execute(`${STICKER_SELECT} WHERE s.deleted_at IS NULL ORDER BY s.id DESC`);
  res.json({ stickers });
});

router.post('/stickers', uploadLimit, upload.single('image'), async (req, res) => {
  const img = req.file && (await saveImage(req.file.buffer, req.user.id, { sticker: true }).catch(() => null));
  if (!img) return res.status(400).json({ error: 'Imagen inválida (JPEG, PNG, WebP o GIF).' });
  let id;
  try {
    [{ insertId: id }] = await pool.execute('INSERT INTO stickers (user_id, media_id) VALUES (?, ?)', [req.user.id, img.id]);
  } catch (err) {
    await removeMedia(img.id);
    throw err;
  }
  res.status(201).json({ sticker: { id, user_id: req.user.id, filename: img.filename, width: img.width, height: img.height } });
});

// Sacarlo del panel (quien lo subió o un admin). Los mensajes que ya lo mandaron lo siguen mostrando.
router.delete('/stickers/:id', async (req, res) => {
  const [[s]] = await pool.execute('SELECT id, user_id FROM stickers WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'no existe' });
  if (s.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Solo quien lo subió puede sacarlo.' });
  await pool.execute('UPDATE stickers SET deleted_at = NOW() WHERE id = ?', [s.id]);
  res.status(204).end();
});

// Todas las cuentas activas (para sugerir @menciones).
router.get('/users', async (req, res) => {
  const [users] = await pool.execute('SELECT id, username, display_name, avatar FROM users WHERE is_active = 1 AND deleted_at IS NULL ORDER BY display_name');
  res.json({ users });
});

// Perfil público de alguien (las cuentas eliminadas no tienen perfil).
router.get('/users/:username', async (req, res) => {
  const [[u]] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.avatar_full, u.bio, u.cover, u.look, u.profile_bg, u.role, u.created_at,
            SUM(p.scope = 'profile') AS profile_count, SUM(p.scope = 'feed') AS feed_count
       FROM users u LEFT JOIN posts p ON p.user_id = u.id AND p.deleted_at IS NULL
      WHERE u.username = ? AND u.deleted_at IS NULL
      GROUP BY u.id`,
    [req.params.username],
  );
  if (!u) return res.status(404).json({ error: 'Ese perfil no existe.' });
  res.json({ user: { ...u, profile_count: Number(u.profile_count ?? 0), feed_count: Number(u.feed_count ?? 0) } });
});
