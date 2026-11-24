import { Router } from 'express';
import { pool } from '../db.js';
import { removeFile, saveImage, upload, UPLOAD_DIR, uploadLimit } from '../images.js';
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
    `SELECT p.id, p.body, p.scope, p.created_at, p.user_id, u.username, u.display_name, u.avatar, m.filename, m.width, m.height
       FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN media m ON m.id = p.media_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.id DESC LIMIT ${PAGE}`,
    params,
  );
  const ids = rows.map((p) => p.id);
  const [reactions, counts] = await Promise.all([reactionSummary(ids, req.user.id), commentCounts(ids)]);
  for (const p of rows) Object.assign(p, { reactions: reactions[p.id], comment_count: counts[p.id] ?? 0 });
  res.json({ posts: rows, more: rows.length === PAGE });
});

router.post('/posts', uploadLimit, upload.single('image'), async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (body.length > 5000 || (!body && !req.file)) return res.status(400).json({ error: 'el post necesita texto o una imagen' });
  let mediaId = null;
  if (req.file) {
    mediaId = (await saveImage(req.file.buffer, req.user.id).catch(() => null))?.id;
    if (!mediaId) return res.status(400).json({ error: 'imagen inválida (JPEG, PNG, WebP o GIF)' });
  }
  const scope = req.body?.scope === 'profile' ? 'profile' : 'feed'; // profile: solo en el perfil propio
  const [r] = await pool.execute('INSERT INTO posts (user_id, body, media_id, scope) VALUES (?, ?, ?, ?)', [req.user.id, body || null, mediaId, scope]);
  if (scope === 'feed') {
    notifyLater('posts', { title: `${req.user.display_name} publicó`, body: body ? snippet(body) : '📷 Subió una foto', url: '/', tag: `post-${r.insertId}` }, { except: [req.user.id] });
  }
  res.status(201).json({ id: r.insertId });
});

router.delete('/posts/:id', async (req, res) => {
  const [[post]] = await pool.execute(
    `SELECT p.id, p.user_id, m.filename FROM posts p LEFT JOIN media m ON m.id = p.media_id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
    [req.params.id],
  );
  if (!post) return res.status(404).json({ error: 'no existe' });
  if (post.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'no es tuyo' });
  await pool.execute('UPDATE posts SET deleted_at = NOW() WHERE id = ?', [post.id]);
  // Si alguien borra un post, la imagen no tiene que quedar en el servidor.
  if (post.filename) await removeFile(post.filename);
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
