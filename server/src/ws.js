// Chat general en vivo. El token va en el primer mensaje (nunca en la URL, que queda en los logs de Apache).
import { WebSocketServer } from 'ws';
import { pool } from './db.js';
import { sessionFromToken } from './auth.js';
import { mentionedIds, notifyLater, snippet } from './push.js';
import { EMOJIS, messageReactions, quote } from './routes/social.js';

const AUTH_TIMEOUT = 5000;
const PING_EVERY = 30_000; // también evita que Apache corte el túnel por inactividad (Timeout de 60 s)
const BURST = { max: 10, ms: 10_000 }; // máximo 10 mensajes cada 10 s por conexión

export function attachChat(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, onConnection);
  });

  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const authed = () => [...wss.clients].filter((c) => c.user);
  const broadcast = (msg) => authed().forEach((c) => send(c, msg));
  function presence() {
    const users = new Map(authed().map(({ user: u }) => [u.id, { id: u.id, username: u.username, display_name: u.display_name, avatar: u.avatar }]));
    broadcast({ type: 'presence', users: [...users.values()] });
  }

  async function onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.close(4000, 'mensaje inválido');
    }
    if (!ws.user) {
      const s = msg.type === 'auth' && typeof msg.token === 'string' && (await sessionFromToken(msg.token));
      if (!s) return ws.close(4001, 'sesión inválida');
      clearTimeout(ws.authTimer);
      Object.assign(ws, { user: s.user, token: msg.token, sent: [] });
      send(ws, { type: 'ready', user: s.user });
      return presence();
    }
    if (msg.type !== 'message' && msg.type !== 'react') return;
    const now = Date.now();
    ws.sent = ws.sent.filter((t) => now - t < BURST.ms);
    if (ws.sent.length >= BURST.max) return send(ws, { type: 'error', error: 'Más despacio 🙂' });
    ws.sent.push(now);

    // Reacción a un mensaje: se guarda y se manda a todos el resumen actualizado de ese mensaje.
    if (msg.type === 'react') {
      if (!EMOJIS.includes(msg.emoji) || !Number.isInteger(msg.message_id)) return send(ws, { type: 'error', error: 'Reacción inválida.' });
      const [[target]] = await pool.execute('SELECT id FROM messages WHERE id = ?', [msg.message_id]);
      if (!target) return;
      await pool.execute(
        msg.on === false
          ? 'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
          : 'INSERT IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
        [target.id, ws.user.id, msg.emoji],
      );
      return broadcast({ type: 'reactions', message_id: target.id, reactions: (await messageReactions([target.id]))[target.id] });
    }

    const body = typeof msg.body === 'string' ? msg.body.trim() : '';
    if (!body || body.length > 2000) return send(ws, { type: 'error', error: 'El mensaje está vacío o es muy largo.' });
    // Si responde a un mensaje que no existe, se manda igual, sin la cita.
    const [[replied]] = Number.isInteger(msg.reply_to)
      ? await pool.execute('SELECT m.id, m.body, u.username, u.display_name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?', [msg.reply_to])
      : [[]];
    const [r] = await pool.execute('INSERT INTO messages (user_id, body, reply_to) VALUES (?, ?, ?)', [ws.user.id, body, replied?.id ?? null]);
    const { id, username, display_name, avatar } = ws.user;
    broadcast({
      type: 'message',
      message: { id: r.insertId, body, created_at: new Date().toISOString(), user_id: id, username, display_name, avatar, reply: quote(replied), reactions: [] },
    });
    // Aviso solo a quien no tiene el chat abierto. Con el mismo tag, los mensajes seguidos se juntan en un aviso.
    // A quien lo mencionan le llega "te mencionó" en lugar del aviso general del chat.
    const online = authed().map((c) => c.user.id);
    const skip = [...new Set([id, ...online])];
    const mentioned = await mentionedIds(body, skip);
    notifyLater('mentions', { title: `${display_name} te mencionó en el chat`, body: snippet(body), url: '/chat', tag: 'chat-mention' }, { to: mentioned });
    notifyLater('chat', { title: `${display_name} en el chat`, body: snippet(body), url: '/chat', tag: 'chat' }, { except: [...skip, ...mentioned] });
  }

  function onConnection(ws) {
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));
    ws.authTimer = setTimeout(() => ws.close(4001, 'sin autenticar'), AUTH_TIMEOUT);
    ws.on('message', (raw) =>
      onMessage(ws, raw).catch((err) => {
        console.error(err);
        send(ws, { type: 'error', error: 'No se pudo enviar.' });
      }),
    );
    ws.on('close', () => {
      clearTimeout(ws.authTimer);
      if (ws.user) presence();
    });
  }

  // Corta conexiones muertas y las de sesiones cerradas o cuentas bloqueadas.
  const timer = setInterval(async () => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
      if (ws.user && !(await sessionFromToken(ws.token).catch(() => true))) ws.close(4001, 'sesión cerrada');
    }
  }, PING_EVERY);
  timer.unref();
  return wss;
}
