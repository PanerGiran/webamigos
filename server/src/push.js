// Notificaciones push (Web Push con claves VAPID del .env). Sin claves, todo queda apagado.
import * as webpush from 'web-push';
import { pool } from './db.js';

let configured = false;
function ready() {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } = process.env;
  if (!pub || !priv || !process.env.ORIGIN) return false;
  if (!configured) webpush.setVapidDetails(process.env.ORIGIN, pub, priv);
  configured = true;
  return true;
}

export const publicKey = () => (ready() ? process.env.VAPID_PUBLIC_KEY : null);

// Los tests lo reemplazan para no mandar nada de verdad.
export const transport = { send: (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600 }) };

const PREF = { posts: 'notify_posts', comments: 'notify_comments', chat: 'notify_chat' };
export const snippet = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Manda `payload` ({ title, body, url, tag }) a los dispositivos de `to` (o de todos), menos `except`,
// solo si tienen activada esa preferencia y la sesión del dispositivo sigue vigente.
export async function notify(pref, payload, { to, except = [] } = {}) {
  if (!ready() || (to && !to.length)) return;
  const where = ['u.is_active = 1', `u.${PREF[pref]} = 1`, 'se.expires_at > NOW()'];
  const params = [];
  if (to) where.push(`u.id IN (${to.map(() => '?').join(',')})`), params.push(...to);
  if (except.length) where.push(`u.id NOT IN (${except.map(() => '?').join(',')})`), params.push(...except);
  const [subs] = await pool.execute(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id JOIN sessions se ON se.id = s.session_id
      WHERE ${where.join(' AND ')}`,
    params,
  );
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await transport.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      } catch (err) {
        // 404/410: el navegador dio de baja la suscripción.
        if (err.statusCode === 404 || err.statusCode === 410) await pool.execute('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        else console.error('push:', err.statusCode ?? err.message);
      }
    }),
  );
}

// Para llamar sin esperar desde una ruta: un aviso que falla nunca rompe la respuesta.
export const notifyLater = (...args) => void notify(...args).catch((err) => console.error('push:', err.message));
