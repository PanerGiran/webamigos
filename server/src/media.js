import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { pool } from './db.js';
import { removeFile, saveImage, UPLOAD_DIR } from './images.js';

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_AUDIO_OR_IMAGE = 5 * 1024 * 1024;
const singleAttachment = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT, files: 1, fields: 4 },
}).single('file');

export function uploadAttachment(req, res, next) {
  singleAttachment(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'El archivo pasa los 20 MB.' });
    next(err);
  });
}

export const mediaKind = (mime) => mime.split('/')[0];

function attachmentMime(buffer, clientMime) {
  const has = (signature, offset = 0) => buffer.subarray(offset, offset + signature.length).equals(signature);
  const ascii = (signature, offset) => has(Buffer.from(signature), offset);
  const audio = clientMime?.startsWith('audio/');
  if (has(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return audio ? 'audio/webm' : 'video/webm';
  if (ascii('ftyp', 4)) {
    if (ascii('qt  ', 8)) return 'video/quicktime';
    if (audio || ascii('M4A ', 8) || ascii('M4B ', 8)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (ascii('OggS')) return 'audio/ogg';
  if (ascii('RIFF') && ascii('WAVE', 8)) return 'audio/wav';
  if (ascii('ID3') || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf0) === 0xf0)) return 'audio/mpeg';
  return null;
}

export async function saveAttachment(file, userId) {
  const { buffer, mimetype } = file ?? {};
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ATTACHMENT) return null;

  const mime = attachmentMime(buffer, mimetype);
  if (!mime) {
    if (buffer.length > MAX_AUDIO_OR_IMAGE) return null;
    const image = await saveImage(buffer, userId);
    return image && { ...image, kind: 'image' };
  }

  const kind = mediaKind(mime);
  if (kind === 'audio' && buffer.length > MAX_AUDIO_OR_IMAGE) return null;
  const filename = randomUUID();
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer, { flag: 'wx' });
  try {
    const [result] = await pool.execute(
      'INSERT INTO media (user_id, filename, mime, size_bytes) VALUES (?, ?, ?, ?)',
      [userId, filename, mime, buffer.length],
    );
    return { id: result.insertId, filename, mime, kind, width: null, height: null };
  } catch (err) {
    await removeFile(filename);
    throw err;
  }
}

export async function removeMedia(mediaId, db = pool) {
  const [[media]] = await db.execute('SELECT filename FROM media WHERE id = ?', [mediaId]);
  if (!media) return;
  const [result] = await db.execute('DELETE FROM media WHERE id = ?', [mediaId]);
  if (result.affectedRows) await removeFile(media.filename);
}
