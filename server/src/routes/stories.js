// Historias de 24 horas: una foto o un texto sobre un color, que se borran solas al día siguiente.
// Se ve quién vio cada una y con qué reaccionó (solo quien la subió).
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { saveImage, upload, uploadLimit } from '../images.js';
import { removeMedia } from '../media.js';
import { notifyLater, snippet } from '../push.js';
import { EMOJIS } from './social.js';

const router = Router();
export default router;
router.use(requireAuth);

export const STORY_HOURS = 24;
const COLORS = 6; // fondos de las historias de texto (los colores los pone la web)

// Historias vigentes, agrupadas por persona: primero las tuyas, después quien tiene algo sin ver
// (lo más nuevo primero) y al final quien ya viste entero.
router.get('/stories', async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT s.id, s.user_id, s.body, s.bg, s.created_at, s.expires_at, u.username, u.display_name, u.avatar,
            m.filename, m.width, m.height,
            EXISTS(SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.user_id = ?) AS seen,
            (SELECT v.emoji FROM story_views v WHERE v.story_id = s.id AND v.user_id = ?) AS my_emoji,
            (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id) AS views
       FROM stories s JOIN users u ON u.id = s.user_id LEFT JOIN media m ON m.id = s.media_id
      WHERE s.expires_at > NOW() AND u.is_active = 1 AND u.deleted_at IS NULL
      ORDER BY s.id`,
    [req.user.id, req.user.id],
  );
  const byUser = new Map();
  for (const r of rows) {
    const mine = r.user_id === req.user.id;
    const group = byUser.get(r.user_id) ?? { id: r.user_id, username: r.username, display_name: r.display_name, avatar: r.avatar, stories: [] };
    byUser.set(r.user_id, group);
    group.stories.push({
      id: r.id,
      body: r.body,
      bg: r.bg,
      created_at: r.created_at,
      expires_at: r.expires_at,
      image: r.filename ? { filename: r.filename, width: r.width, height: r.height } : null,
      seen: mine || !!r.seen,
      ...(mine ? { views: Number(r.views) } : { my_emoji: r.my_emoji }),
    });
  }
  const users = [...byUser.values()].map((g) => ({ ...g, seen: g.stories.every((s) => s.seen) }));
  const last = (g) => g.stories.at(-1).id;
  users.sort((a, b) => (b.id === req.user.id) - (a.id === req.user.id) || a.seen - b.seen || last(b) - last(a));
  res.json({ users });
});

// Subir una historia: foto (con texto opcional) o solo texto sobre uno de los colores.
router.post('/stories', uploadLimit, upload.single('image'), async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  const bg = Number.parseInt(req.body?.bg, 10);
  if (body.length > 300) return res.status(400).json({ error: 'El texto pasa los 300 caracteres.' });
  if (!body && !req.file) return res.status(400).json({ error: 'La historia necesita una foto o un texto.' });
  const img = req.file ? await saveImage(req.file.buffer, req.user.id).catch(() => null) : null;
  if (req.file && !img) return res.status(400).json({ error: 'Imagen inválida (JPEG, PNG, WebP o GIF).' });
  let id;
  try {
    [{ insertId: id }] = await pool.execute(
      `INSERT INTO stories (user_id, media_id, body, bg, expires_at) VALUES (?, ?, ?, ?, NOW() + INTERVAL ${STORY_HOURS} HOUR)`,
      [req.user.id, img?.id ?? null, body || null, bg >= 0 && bg < COLORS ? bg : 0],
    );
  } catch (err) {
    if (img) await removeMedia(img.id);
    throw err;
  }
  // Con el mismo tag, varias historias seguidas de la misma persona son un solo aviso.
  notifyLater('posts', { title: `${req.user.display_name} subió una historia`, body: body ? snippet(body) : 'Una foto', url: '/', tag: `story-${req.user.id}` }, { except: [req.user.id], from: req.user, kind: 'story' });
  res.status(201).json({ id });
});

async function liveStory(id) {
  const [[s]] = await pool.execute('SELECT id, user_id, body, media_id FROM stories WHERE id = ? AND expires_at > NOW()', [id]);
  return s;
}

// Marca la historia como vista (las propias no cuentan).
router.put('/stories/:id/view', async (req, res) => {
  const s = await liveStory(req.params.id);
  if (!s) return res.status(404).json({ error: 'Esa historia ya no está.' });
  if (s.user_id !== req.user.id) await pool.execute('INSERT IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)', [s.id, req.user.id]);
  res.status(204).end();
});

// Reaccionar con un emoji (o sacarlo con emoji: null). A quien la subió le llega el aviso.
router.put('/stories/:id/react', async (req, res) => {
  const emoji = req.body?.emoji ?? null;
  if (emoji !== null && !EMOJIS.includes(emoji)) return res.status(400).json({ error: 'reacción inválida' });
  const s = await liveStory(req.params.id);
  if (!s) return res.status(404).json({ error: 'Esa historia ya no está.' });
  if (s.user_id === req.user.id) return res.status(400).json({ error: 'No podés reaccionar a tu propia historia.' });
  await pool.execute(
    'INSERT INTO story_views (story_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = VALUES(emoji)',
    [s.id, req.user.id, emoji],
  );
  if (emoji) {
    notifyLater('comments', { title: `${req.user.display_name} reaccionó ${emoji} a tu historia`, body: s.body ? snippet(s.body) : 'Tu foto', url: '/', tag: `story-react-${s.id}` }, { to: [s.user_id], from: req.user, kind: 'story' });
  }
  res.json({ emoji });
});

// Quién la vio y con qué reaccionó: solo para quien la subió.
router.get('/stories/:id/views', async (req, res) => {
  const s = await liveStory(req.params.id);
  if (!s) return res.status(404).json({ error: 'Esa historia ya no está.' });
  if (s.user_id !== req.user.id) return res.status(403).json({ error: 'Solo quien la subió ve quién la vio.' });
  const [views] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.avatar, v.emoji, v.viewed_at
       FROM story_views v JOIN users u ON u.id = v.user_id
      WHERE v.story_id = ? AND u.deleted_at IS NULL ORDER BY v.viewed_at DESC`,
    [s.id],
  );
  res.json({ views });
});

// Borrarla antes de tiempo (quien la subió o un admin).
router.delete('/stories/:id', async (req, res) => {
  const [[s]] = await pool.execute('SELECT id, user_id, media_id FROM stories WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'no existe' });
  if (s.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'no es tuya' });
  await dropStory(s);
  res.status(204).end();
});

async function dropStory(s) {
  await pool.execute('DELETE FROM stories WHERE id = ?', [s.id]);
  if (s.media_id) await removeMedia(s.media_id);
}

// Borra las historias vencidas con sus fotos. La llama el servidor cada hora; devuelve cuántas borró.
export async function cleanStories() {
  const [old] = await pool.execute('SELECT id, media_id FROM stories WHERE expires_at <= NOW()');
  for (const s of old) await dropStory(s);
  return old.length;
}
