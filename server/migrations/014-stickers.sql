-- 2026-11-25: stickers del grupo (imágenes que sube cualquiera y todos pueden mandar en el chat).
-- Sacar un sticker del panel es borrado lógico: los mensajes que ya lo mandaron lo siguen mostrando.
CREATE TABLE stickers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (media_id) REFERENCES media(id)
);
ALTER TABLE messages
  ADD COLUMN sticker_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_messages_sticker FOREIGN KEY (sticker_id) REFERENCES stickers(id);
