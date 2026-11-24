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
// Posts: hasta 6 fotos (álbum). Campos: texto, dónde se publica y la encuesta.
export const MAX_PHOTOS = 6;
export const uploadPost = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: MAX_PHOTOS, fields: 6 } }).fields([
  { name: 'images', maxCount: MAX_PHOTOS },
  { name: 'image', maxCount: 1 }, // forma vieja (una sola foto)
]);
// Va después de requireAuth (usa req.user).
export const uploadLimit = rateLimit({ windowMs: 60 * 60_000, limit: 30, keyGenerator: (req) => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false });

const POST_SIZE = { width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true };
// Cuadrada, recortada hacia la zona con más detalle (en general, la cara).
const AVATAR_SIZE = { width: 256, height: 256, fit: 'cover', position: sharp.strategy.attention };
// Portada del perfil: apaisada, recortada igual hacia lo más llamativo.
const COVER_SIZE = { width: 1500, height: 500, fit: 'cover', position: sharp.strategy.attention };

// Animaciones (GIF o WebP animado): se conservan, con un tope de cuadros para no pasar la RAM del servidor.
const MAX_PIXELS = 40_000_000; // sumando todos los cuadros
const MAX_FRAMES_PROFILE = 60; // foto y portada se agrandan al recortar: cada cuadro pesa más
// Portada animada más chica que la fija: son muchos cuadros en memoria a la vez.
const ANIM_COVER_SIZE = { width: 900, height: 300, fit: 'cover', position: 'centre' };

// Encuadre elegido por la persona: { left, top, width, height } en píxeles de la imagen original (ya enderezada).
// Devuelve undefined si no vino, null si vino mal (la ruta responde 400).
export function parseCrop(raw) {
  if (raw === undefined || raw === '') return undefined;
  try {
    const c = JSON.parse(raw);
    const ok = ['left', 'top', 'width', 'height'].every((k) => Number.isInteger(c?.[k]) && c[k] >= 0 && c[k] < 100_000);
    return ok && c.width > 0 && c.height > 0 ? { left: c.left, top: c.top, width: c.width, height: c.height } : null;
  } catch {
    return null;
  }
}

// Revisa el formato real (no el que dice el cliente), endereza según EXIF y guarda WebP sin metadatos (se va el GPS).
// Devuelve { id, filename } o null si no es una imagen válida.
export async function saveImage(buffer, userId, { avatar = false, cover = false, crop } = {}) {
  const head = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata().catch(() => null);
  if (!head || !['jpeg', 'png', 'webp', 'gif'].includes(head.format)) return null;
  const pages = head.pages ?? 1;
  const animated = pages > 1;
  // shortcut: en posts el tope es solo de píxeles (un GIF largo de 40M px usa mucha RAM); si el servidor se queda corto, bajar MAX_PIXELS.
  const frames = Math.max(1, Math.min(pages, avatar || cover ? MAX_FRAMES_PROFILE : pages, Math.floor(MAX_PIXELS / (head.width * (head.pageHeight ?? head.height)))));
  // La detección de lo más llamativo ("attention") no anda con animaciones: ahí se recorta al centro.
  const size = avatar ? AVATAR_SIZE : cover ? COVER_SIZE : POST_SIZE;
  const resize = !animated ? size : cover ? ANIM_COVER_SIZE : avatar ? { ...size, position: 'centre' } : size;
  // El orden importa: enderezar, después recortar el encuadre elegido, después achicar.
  const pipeline = sharp(buffer, { pages: animated ? frames : 1, limitInputPixels: MAX_PIXELS }).rotate();
  if (crop) {
    // Se ajusta a los bordes reales de la imagen (si viene rotada por EXIF, ancho y alto se invierten).
    const h = head.pageHeight ?? head.height;
    const [W, H] = (head.orientation ?? 1) >= 5 ? [h, head.width] : [head.width, h];
    const left = Math.min(crop.left, W - 1);
    const top = Math.min(crop.top, H - 1);
    pipeline.extract({ left, top, width: Math.min(crop.width, W - left), height: Math.min(crop.height, H - top) });
  }
  const { data, info } = await pipeline
    .resize(crop ? { ...resize, position: 'centre' } : resize)
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
