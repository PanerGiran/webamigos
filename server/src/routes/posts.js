import { Router } from 'express';
import { pool } from '../db.js';
import { removeFile, saveImage, UPLOAD_DIR, uploadLimit, uploadPost } from '../images.js';
import { requireAuth } from '../auth.js';
import { commentCounts, reactionSummary } from './social.js';
import { notifyLater, snippet } from '../push.js';

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
  const [reactions, counts, images] = await Promise.all([reactionSummary(ids, userId), commentCounts(ids), postImages(ids)]);
  for (const p of rows) Object.assign(p, { reactions: reactions[p.id], comment_count: counts[p.id] ?? 0, images: images[p.id] ?? [] });
  return rows;
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
  if (scope === 'feed') {
    const what = saved.length > 1 ? `📷 Subió ${saved.length} fotos` : '📷 Subió una foto';
    notifyLater('posts', { title: `${req.user.display_name} publicó`, body: body ? snippet(body) : what, url: '/', tag: `post-${r.insertId}` }, { except: [req.user.id] });
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
  await pool.execute('UPDATE posts SET body = ?, edited_at = NOW() WHERE id = ?', [body || null, post.id]);
  const [[row]] = await pool.execute('SELECT body, edited_at FROM posts WHERE id = ?', [post.id]);
  res.json(row);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
router.get('/media/:filename', (req, res) => {
  if (!UUID.test(req.params.filename)) return res.status(404).json({ error: 'no existe' });
  res.sendFile(req.params.filename, {
    root: UPLOAD_DIR,
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
});
