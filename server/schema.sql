CREATE DATABASE amigos CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE amigos;

CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  display_name VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NULL,            -- NULL hasta que acepte la invitación
  role ENUM('admin','member') NOT NULL DEFAULT 'member',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  deleted_at DATETIME NULL,                   -- borrado lógico (también pone is_active = 0)
  avatar CHAR(36) NULL,                       -- foto de perfil recortada 256x256 (archivo en uploads)
  avatar_full CHAR(36) NULL,                  -- la misma foto completa, sin recorte
  notify_posts TINYINT(1) NOT NULL DEFAULT 1,  -- preferencias de notificaciones push
  notify_comments TINYINT(1) NOT NULL DEFAULT 1,
  notify_chat TINYINT(1) NOT NULL DEFAULT 1,
  bio VARCHAR(300) NULL,                      -- texto corto del perfil
  cover CHAR(36) NULL,                        -- foto de portada (archivo en uploads)
  notify_mentions TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE invites (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,        -- sha256 del token
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE media (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  filename CHAR(36) NOT NULL UNIQUE,          -- uuid, sin extensión original
  mime VARCHAR(50) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  width SMALLINT UNSIGNED NULL,
  height SMALLINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE posts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  body TEXT NULL,
  media_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  scope ENUM('feed','profile') NOT NULL DEFAULT 'feed',  -- profile: solo en el perfil del autor
  edited_at DATETIME NULL,
  INDEX idx_posts_created (created_at),
  INDEX idx_posts_user_scope (user_id, scope, id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (media_id) REFERENCES media(id)
);

CREATE TABLE post_media (                       -- fotos de cada post, en orden (posts.media_id = la primera)
  post_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media(id)
);

CREATE TABLE poll_options (                     -- encuestas: el texto del post es la pregunta
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id BIGINT UNSIGNED NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  text VARCHAR(100) NOT NULL,
  UNIQUE KEY poll_option_position (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE TABLE poll_votes (
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  option_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
);

CREATE TABLE comments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  body VARCHAR(1000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at DATETIME NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE reactions (
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  emoji VARCHAR(16) NOT NULL,
  PRIMARY KEY (post_id, user_id, emoji),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE messages (                        -- chat general (agregar room_id si hay más salas)
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  body VARCHAR(2000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reply_to BIGINT UNSIGNED NULL,                -- mensaje al que responde
  INDEX idx_messages_created (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_messages_reply FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE message_reactions (
  message_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  emoji VARCHAR(16) NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE schema_migrations (                -- qué migraciones ya se aplicaron (ver migrate.sh)
  name VARCHAR(255) PRIMARY KEY,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

-- Usuario de DB con permisos mínimos (no usar root). Cambiar la clave antes de correrlo.
-- CREATE USER 'amigos'@'localhost' IDENTIFIED BY '<clave-larga-aleatoria>';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON amigos.* TO 'amigos'@'localhost';
