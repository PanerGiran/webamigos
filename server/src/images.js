// Subida y procesado de imágenes (posts y fotos de perfil).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import { pool } from './db.js';

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/var/lib/amigos/uploads';

// 1 GB de RAM: una imagen por vez y sin caché de libvips.
sharp.concurrency(1);
sharp.cache(false);

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 } });
// Va después de requireAuth (usa req.user).
export const uploadLimit = rateLimit({ windowMs: 60 * 60_000, limit: 30, keyGenerator: (req) => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false });

const POST_SIZE = { width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true };
// Cuadrada, recortada hacia la zona con más detalle (en general, la cara).
const AVATAR_SIZE = { width: 256, height: 256, fit: 'cover', position: sharp.strategy.attention };

// Revisa el formato real (no el que dice el cliente), endereza según EXIF y guarda WebP sin metadatos (se va el GPS).
// Devuelve { id, filename } o null si no es una imagen válida.
export async function saveImage(buffer, userId, { avatar = false } = {}) {
  const input = sharp(buffer, { animated: !avatar, limitInputPixels: 40_000_000 });
  const meta = await input.metadata().catch(() => null);
  if (!meta || !['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) return null;
  const { data, info } = await input
    .rotate()
    .resize(avatar ? AVATAR_SIZE : POST_SIZE)
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  const filename = crypto.randomUUID();
  await fs.writeFile(path.join(UPLOAD_DIR, filename), data, { flag: 'wx' });
  const [r] = await pool.execute(
    'INSERT INTO media (user_id, filename, mime, size_bytes, width, height) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, filename, 'image/webp', data.length, info.width, info.pageHeight ?? info.height],
  );
  return { id: r.insertId, filename };
}

export const removeFile = (filename) => fs.rm(path.join(UPLOAD_DIR, filename), { force: true });
