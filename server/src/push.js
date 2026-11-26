// Notificaciones push (Web Push con claves VAPID del .env). Sin claves, todo queda apagado.
import * as webpush from 'web-push';
import { pool } from './db.js';
import { live } from './live.js';

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

const PREF = { posts: 'notify_posts', comments: 'notify_comments', chat: 'notify_chat', mentions: 'notify_mentions' };

// @usuario en un texto (no en direcciones de mail): ids de cuentas activas mencionadas que quieren ese aviso, sin `exclude`.
// Quien lo tiene apagado no sale en la lista, así le llega el aviso general en lugar de ninguno.
const MENTION = /(?<![\w@])@([a-z0-9_]{3,32})/gi;
export async function mentionedIds(text, exclude = []) {
  const names = [...new Set([...(text ?? '').matchAll(MENTION)].map((m) => m[1].toLowerCase()))].slice(0, 20);
  if (!names.length) return [];
  const [rows] = await pool.execute(
    `SELECT id FROM users WHERE is_active = 1 AND deleted_at IS NULL AND notify_mentions = 1 AND username IN (${names.map(() => '?').join(',')})`,
    names,
  );
  return rows.map((r) => r.id).filter((id) => !exclude.includes(id));
}
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
// Con `from` (quién lo generó), además llega en vivo a quien tenga la app abierta (abajo a la derecha).
export const notifyLater = (pref, payload, opts = {}) => {
  void notify(pref, payload, opts).catch((err) => console.error('push:', err.message));
  if (opts.from && pref !== 'chat') void notifyLive(pref, payload, opts).catch((err) => console.error('live:', err.message));
};

// El chat no pasa por acá: cada app ya recibe los mensajes del chat y arma su propio aviso.
// `kind` (opcional) cambia la etiqueta del aviso en vivo, ej. 'story' para las historias.
async function notifyLive(pref, payload, { to, except = [], from, kind = { posts: 'post', comments: 'comment', mentions: 'mention' }[pref] }) {
  let ids = to;
  if (!ids) ids = (await pool.execute('SELECT id FROM users WHERE is_active = 1 AND deleted_at IS NULL'))[0].map((r) => r.id);
  live.sendTo(ids.filter((id) => !except.includes(id)), {
    type: 'notify',
    kind,
    title: payload.title,
    text: payload.body,
    url: payload.url,
    from: { username: from.username, display_name: from.display_name, avatar: from.avatar },
  });
}
