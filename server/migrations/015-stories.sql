-- 2026-11-26: historias de 24 horas (foto o texto sobre un color) y quién las vio (con su reacción, si reaccionó).
-- Las vencidas las borra el servidor cada hora, con su foto.
CREATE TABLE stories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NULL,
  body VARCHAR(300) NULL,
  bg TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  INDEX idx_stories_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (media_id) REFERENCES media(id)
);
CREATE TABLE story_views (
  story_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  emoji VARCHAR(16) NULL,
  viewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id, user_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
