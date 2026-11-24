-- 2026-11-24: notificaciones push. Cada suscripción va atada a una sesión: si la sesión se cierra
-- (logout, cambio de clave, reset, bloqueo), el dispositivo deja de recibir avisos.
CREATE TABLE push_subscriptions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  endpoint VARCHAR(500) NOT NULL UNIQUE,
  p256dh VARCHAR(200) NOT NULL,
  auth VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
ALTER TABLE users
  ADD COLUMN notify_posts TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN notify_comments TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN notify_chat TINYINT(1) NOT NULL DEFAULT 1;
