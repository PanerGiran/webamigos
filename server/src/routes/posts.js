import { Router } from 'express';
import { parsePoll } from '../polls.js';
import { pool } from '../db.js';
import { removeFile, saveImage, UPLOAD_DIR, uploadLimit, uploadPost } from '../images.js';
import { requireAuth } from '../auth.js';
import { commentCounts, reactionSummary } from './social.js';
import { mentionedIds, notifyLater, snippet } from '../push.js';

const router = Router();
export default router;
router.use(requireAuth);

const PAGE = 20;

// Feed global: /posts. Perfil de alguien: /posts?user=<usuario>&scope=profile|feed.
// Los posts de perfil solo se listan con ?user= (nunca en el feed global).
router.get('/posts', async (req, res) => {
  const before = Number.parseInt(req.query.before, 10);
  const user = typeof req.query.user === 'string' ? req.query.user : null;
  const where = ['p.deleted_at IS NULL', 'p.scope = ?'];
  const params = [user && req.query.scope === 'profile' ? 'profile' : 'feed'];
  if (user) where.push('u.username = ?'), params.push(user);
  if (before > 0) where.push('p.id < ?'), params.push(before);
  const [rows] = await pool.execute(
    `${POST_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY p.id DESC LIMIT ${PAGE}`,
    params,
  );
  res.json({ posts: await decoratePosts(rows, req.user.id), more: rows.length === PAGE });
});

// Columnas y joins comunes para listar posts (feed, perfil, buscador).
export const POST_SELECT = `SELECT p.id, p.body, p.scope, p.created_at, p.edited_at, p.user_id, u.username, u.display_name, u.avatar, m.filename, m.width, m.height
       FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN media m ON m.id = p.media_id`;

// Le agrega a cada post sus fotos, reacciones y cantidad de comentarios.
export async function decoratePosts(rows, userId) {
  const ids = rows.map((p) => p.id);
  const [reactions, counts, images, polls] = await Promise.all([reactionSummary(ids, userId), commentCounts(ids), postImages(ids), pollSummary(ids, userId)]);
  for (const p of rows) Object.assign(p, { reactions: reactions[p.id], comment_count: counts[p.id] ?? 0, images: images[p.id] ?? [], poll: polls[p.id] ?? null });
  return rows;
}

// { post_id: { options: [{ id, text, votes }], total, my_vote } } para los posts que tienen encuesta.
async function pollSummary(ids, userId) {
  if (!ids.length) return {};
  const q = ids.map(() => '?').join(',');
  const [options] = await pool.execute(
    `SELECT o.id, o.post_id, o.text, COUNT(v.user_id) AS votes, MAX(v.user_id = ?) AS mine
       FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
      WHERE o.post_id IN (${q}) GROUP BY o.id ORDER BY o.post_id, o.position`,
    [userId, ...ids],
  );
  const out = {};
  for (const o of options) {
    const poll = (out[o.post_id] ??= { options: [], total: 0, my_vote: null });
    poll.options.push({ id: o.id, text: o.text, votes: o.votes });
    poll.total += o.votes;
    if (o.mine) poll.my_vote = o.id;
  }
  return out;
}


async function postImages(ids) {
  if (!ids.length) return {};
  const [rows] = await pool.execute(
    `SELECT pm.post_id, m.filename, m.width, m.height FROM post_media pm JOIN media m ON m.id = pm.media_id
      WHERE pm.post_id IN (${ids.map(() => '?').join(',')}) ORDER BY pm.post_id, pm.position`,
    ids,
  );
  const out = {};
  for (const { post_id, ...img } of rows) (out[post_id] ??= []).push(img);
  return out;
}

router.post('/posts', uploadLimit, uploadPost, async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  const files = [...(req.files?.images ?? []), ...(req.files?.image ?? [])];
  if (body.length > 5000 || (!body && !files.length)) return res.status(400).json({ error: 'El post necesita texto o una foto.' });
  const poll = parsePoll(req.body?.poll);
  if (poll.error) return res.status(400).json({ error: 'La encuesta necesita de 2 a 6 opciones distintas (hasta 100 caracteres cada una).' });
  if (poll.options && !body) return res.status(400).json({ error: 'Escribí la pregunta de la encuesta.' });
  // Se procesan de a una (poca RAM). Si alguna no es imagen, se borran las ya guardadas y no se publica nada.
  const saved = [];
  for (const f of files) {
    const img = await saveImage(f.buffer, req.user.id).catch(() => null);
    if (!img) {
      for (const s of saved) await dropMedia(s);
      return res.status(400).json({ error: 'Alguna foto no es válida (JPEG, PNG, WebP o GIF).' });
    }
    saved.push(img);
  }
  const scope = req.body?.scope === 'profile' ? 'profile' : 'feed'; // profile: solo en el perfil propio
  const [r] = await pool.execute('INSERT INTO posts (user_id, body, media_id, scope) VALUES (?, ?, ?, ?)', [req.user.id, body || null, saved[0]?.id ?? null, scope]);
  for (const [i, img] of saved.entries()) await pool.execute('INSERT INTO post_media (post_id, media_id, position) VALUES (?, ?, ?)', [r.insertId, img.id, i]);
  for (const [i, text] of (poll.options ?? []).entries()) await pool.execute('INSERT INTO poll_options (post_id, position, text) VALUES (?, ?, ?)', [r.insertId, i, text]);
  // Los mencionados reciben "te mencionó" en lugar del aviso general (nunca los dos).
  const mentioned = await mentionedIds(body, [req.user.id]);
  const url = scope === 'feed' ? '/' : `/u/${req.user.username}`;
  notifyLater('mentions', { title: `${req.user.display_name} te mencionó`, body: snippet(body), url, tag: `post-${r.insertId}` }, { to: mentioned, from: req.user });
  if (scope === 'feed') {
    const what = saved.length > 1 ? `📷 Subió ${saved.length} fotos` : '📷 Subió una foto';
    notifyLater('posts', { title: `${req.user.display_name} publicó`, body: body ? `${poll.options ? '📊 ' : ''}${snippet(body)}` : what, url, tag: `post-${r.insertId}` }, { except: [req.user.id, ...mentioned], from: req.user });
  }
  res.status(201).json({ id: r.insertId });
});

async function dropMedia(img) {
  await removeFile(img.filename);
  await pool.execute('DELETE FROM media WHERE id = ?', [img.id]);
}

// Editar el texto: solo el autor. Si el post no tiene foto, el texto no puede quedar vacío.
router.patch('/posts/:id', async (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : null;
  if (body === null || body.length > 5000) return res.status(400).json({ error: 'texto inválido' });
  const [[post]] = await pool.execute('SELECT id, user_id, media_id FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'no existe' });
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Solo el autor puede editarlo.' });
  if (!body && !post.media_id) return res.status(400).json({ error: 'El post necesita texto o una imagen.' });
  const [[hasPoll]] = await pool.execute('SELECT 1 AS x FROM poll_options WHERE post_id = ? LIMIT 1', [post.id]);
  if (!body && hasPoll) return res.status(400).json({ error: 'La encuesta necesita su pregunta.' });
  await pool.execute('UPDATE posts SET body = ?, edited_at = NOW() WHERE id = ?', [body || null, post.id]);
  const [[row]] = await pool.execute('SELECT body, edited_at FROM posts WHERE id = ?', [post.id]);
  res.json(row);
});

// Votar (option_id) o sacar el voto (option_id: null). Un voto por persona; votar otra opción lo cambia.
router.put('/posts/:id/vote', async (req, res) => {
  const optionId = req.body?.option_id;
  if (optionId !== null && !Number.isInteger(optionId)) return res.status(400).json({ error: 'voto inválido' });
  const [[post]] = await pool.execute('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'no existe' });
  if (optionId === null) {
    await pool.execute('DELETE FROM poll_votes WHERE post_id = ? AND user_id = ?', [post.id, req.user.id]);
  } else {
    const [[opt]] = await pool.execute('SELECT id FROM poll_options WHERE id = ? AND post_id = ?', [optionId, post.id]);
    if (!opt) return res.status(400).json({ error: 'Esa opción no es de esta encuesta.' });
    await pool.execute(
      'INSERT INTO poll_votes (post_id, user_id, option_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)',
      [post.id, req.user.id, opt.id],
    );
  }
  res.json({ poll: (await pollSummary([post.id], req.user.id))[post.id] ?? null });
});

// Quiénes votaron cada opción.
router.get('/posts/:id/votes', async (req, res) => {
  const [[post]] = await pool.execute('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'no existe' });
  const [rows] = await pool.execute(
    `SELECT o.id AS option_id, o.text, u.id, u.username, u.display_name, u.avatar
       FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id LEFT JOIN users u ON u.id = v.user_id AND u.deleted_at IS NULL
      WHERE o.post_id = ? ORDER BY o.position, u.display_name`,
    [post.id],
  );
  const options = [];
  for (const r of rows) {
    let o = options.at(-1);
    if (o?.id !== r.option_id) options.push((o = { id: r.option_id, text: r.text, users: [] }));
    if (r.id) o.users.push({ id: r.id, username: r.username, display_name: r.display_name, avatar: r.avatar });
  }
  res.json({ options });
});

router.delete('/posts/:id', async (req, res) => {
  const [[post]] = await pool.execute('SELECT id, user_id FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'no existe' });
  if (post.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'no es tuyo' });
  await pool.execute('UPDATE posts SET deleted_at = NOW() WHERE id = ?', [post.id]);
  // Si alguien borra un post, sus fotos no tienen que quedar en el servidor.
  const [files] = await pool.execute('SELECT m.filename FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = ?', [post.id]);
  for (const f of files) await removeFile(f.filename);
  res.status(204).end();
});

// Buscador: personas (nombre o usuario) y posts (feed y perfiles) cuyo texto contiene lo buscado.
// La collation de la base ignora mayúsculas y tildes ("cancion" encuentra "canción").
router.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2 || q.length > 100) return res.status(400).json({ error: 'Buscá con 2 a 100 caracteres.' });
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; // % y _ escritos por el usuario no son comodines
  const [users] = await pool.execute(
    `SELECT id, username, display_name, avatar FROM users
      WHERE is_active = 1 AND deleted_at IS NULL AND (display_name LIKE ? OR username LIKE ?)
      ORDER BY display_name LIMIT 8`,
    [like, like],
  );
  const [posts] = await pool.execute(`${POST_SELECT} WHERE p.deleted_at IS NULL AND p.body LIKE ? ORDER BY p.id DESC LIMIT 30`, [like]);
  res.json({ users, posts: await decoratePosts(posts, req.user.id) });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
router.get('/media/:filename', async (req, res) => {
  if (!UUID.test(req.params.filename)) return res.status(404).json({ error: 'no existe' });
  const [[media]] = await pool.execute('SELECT mime FROM media WHERE filename = ?', [req.params.filename]);
  if (!media) return res.status(404).json({ error: 'no existe' });
  res.sendFile(req.params.filename, {
    root: UPLOAD_DIR,
    headers: { 'Content-Type': media.mime, 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
});
