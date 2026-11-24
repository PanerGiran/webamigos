import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import postRoutes from './routes/posts.js';
import adminRoutes from './routes/admin.js';
import socialRoutes from './routes/social.js';
import pushRoutes from './routes/push.js';
import { attachChat } from './ws.js';

const WEB_DIR = path.join(import.meta.dirname, '../../web');

export const app = express();
app.set('trust proxy', 'loopback'); // Apache en la misma máquina: req.ip es la IP real del cliente
// blob: porque las imágenes se piden con el token (fetch) y se muestran como blob.
app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'blob:'] } } }));
app.use(express.json({ limit: '10kb' }));

app.use('/api/admin', adminRoutes);
app.use('/api', authRoutes);
app.use('/api', postRoutes);
app.use('/api', socialRoutes);
app.use('/api', pushRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'no existe' }));

app.use(express.static(WEB_DIR));
// Rutas de la app (/login, /invite/<token>, /perfil): las resuelve el JS del cliente.
app.get('/{*ruta}', (req, res) => res.sendFile('index.html', { root: WEB_DIR }));

app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'la imagen pasa los 5 MB' });
  const status = err.status ?? (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'error interno' : 'pedido inválido' });
});

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, '127.0.0.1', () => console.log(`escuchando en 127.0.0.1:${port}`));
  attachChat(server);
}
