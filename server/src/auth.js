import crypto from 'node:crypto';
import argon2 from 'argon2';
import { pool } from './db.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

// Parámetros mínimos de OWASP (19 MiB): con el default (64 MiB) unos pocos logins simultáneos pasan el MemoryMax=300M.
const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw) => argon2.hash(pw, ARGON);

// Si el usuario no existe se verifica contra un hash falso, así el tiempo de respuesta no delata qué usuarios existen.
const DUMMY_HASH = await hashPassword(newToken());
export const verifyPassword = (hash, pw) => argon2.verify(hash ?? DUMMY_HASH, pw);

export async function createSession(userId, userAgent, conn = pool) {
  const token = newToken();
  await conn.execute(
    'INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL 30 DAY)',
    [userId, sha256(token), userAgent?.slice(0, 255) ?? null],
  );
  return token;
}

// Invalida las invitaciones pendientes del usuario: solo vale la última.
export async function createInvite(userId) {
  const token = newToken();
  await pool.execute('UPDATE invites SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [userId]);
  await pool.execute(
    'INSERT INTO invites (user_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL 48 HOUR)',
    [userId, sha256(token)],
  );
  return token;
}

export const inviteLink = (token) => `${process.env.ORIGIN}/invite/${token}`;

// Borra la clave y cierra las sesiones al instante (por si la cuenta está comprometida) y genera una invitación nueva.
export async function resetAccess(userId) {
  await pool.execute('UPDATE users SET password_hash = NULL WHERE id = ?', [userId]);
  await pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return createInvite(userId);
}

// También lo va a usar el websocket (fase 3), que recibe el token en el primer mensaje.
export async function sessionFromToken(token) {
  const [[row]] = await pool.execute(
    `SELECT s.id AS session_id, u.id, u.username, u.display_name, u.role, u.avatar
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.is_active = 1`,
    [sha256(token)],
  );
  if (!row) return null;
  pool.execute('UPDATE sessions SET last_used_at = NOW() WHERE id = ?', [row.session_id]).catch(() => {});
  const { session_id, ...user } = row;
  return { sessionId: session_id, user };
}

export async function requireAuth(req, res, next) {
  if (req.user) return next(); // otro router de /api ya validó este pedido
  const m = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '');
  const s = m && (await sessionFromToken(m[1]));
  if (!s) return res.status(401).json({ error: 'no autenticado' });
  req.user = s.user;
  req.sessionId = s.sessionId;
  next();
}

export const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'solo para admins' });
