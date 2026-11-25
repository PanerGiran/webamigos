// Conexión en vivo: chat, presencia y avisos. El token va en el primer mensaje (nunca en la URL, que queda en los logs de Apache).
// Los mensajes del chat se mandan por POST /messages (texto, foto, audio o encuesta) y llegan a todos por acá.
import { WebSocketServer } from 'ws';
import { pool } from './db.js';
import { sessionFromToken } from './auth.js';
import { mentionedIds, notifyLater, snippet } from './push.js';
import { EMOJIS, messageReactions } from './routes/social.js';
import { live } from './live.js';

const AUTH_TIMEOUT = 5000;
const PING_EVERY = 30_000; // también evita que Apache corte el túnel por inactividad (Timeout de 60 s)
const BURST = { max: 10, ms: 10_000 }; // máximo 10 reacciones cada 10 s por conexión

export function attachChat(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, onConnection);
  });

  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const authed = () => [...wss.clients].filter((c) => c.user);
  const broadcast = (msg) => authed().forEach((c) => send(c, msg));
  live.sendTo = (ids, msg) => authed().filter((c) => ids.includes(c.user.id)).forEach((c) => send(c, msg));
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
    if (msg.type !== 'react') return;
    const now = Date.now();
    ws.sent = ws.sent.filter((t) => now - t < BURST.ms);
    if (ws.sent.length >= BURST.max) return send(ws, { type: 'error', error: 'Más despacio 🙂' });
    ws.sent.push(now);

    // Reacción a un mensaje: se guarda y se manda a todos el resumen actualizado de ese mensaje.
    if (!EMOJIS.includes(msg.emoji) || !Number.isInteger(msg.message_id)) return send(ws, { type: 'error', error: 'Reacción inválida.' });
    const [[target]] = await pool.execute('SELECT id FROM messages WHERE id = ?', [msg.message_id]);
    if (!target) return;
    await pool.execute(
      msg.on === false
        ? 'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
        : 'INSERT IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
      [target.id, ws.user.id, msg.emoji],
    );
    broadcast({ type: 'reactions', message_id: target.id, reactions: (await messageReactions([target.id]))[target.id] });
  }

  // Manda el mensaje a todos y avisa (push) a quien no tiene la app abierta (lo llama POST /messages).
  // Con el mismo tag, los mensajes seguidos se juntan en un aviso.
  async function publishChat(user, message) {
    broadcast({ type: 'message', message });
    const what = message.poll ? `📊 ${snippet(message.body)}` : message.body ? snippet(message.body) : `📎 Mandó ${message.media?.kind === 'audio' ? 'un audio' : 'una foto'}`;
    // A quien lo mencionan le llega "te mencionó" en lugar del aviso general del chat.
    const online = authed().map((c) => c.user.id);
    const skip = [...new Set([user.id, ...online])];
    const mentioned = await mentionedIds(message.body, skip);
    notifyLater('mentions', { title: `${user.display_name} te mencionó en el chat`, body: what, url: '/chat', tag: 'chat-mention' }, { to: mentioned });
    notifyLater('chat', { title: `${user.display_name} en el chat`, body: what, url: '/chat', tag: 'chat' }, { except: [...skip, ...mentioned] });
  }
  live.publishChat = (user, message) => publishChat(user, message).catch((err) => console.error('chat:', err.message));
  live.broadcast = broadcast;

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
