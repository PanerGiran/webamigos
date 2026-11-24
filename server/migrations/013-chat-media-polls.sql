-- 2026-11-24: fotos y audios en el chat, y encuestas en el chat (el texto del mensaje es la pregunta)
ALTER TABLE messages
  ADD COLUMN media_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_messages_media FOREIGN KEY (media_id) REFERENCES media(id);
CREATE TABLE chat_poll_options (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  text VARCHAR(100) NOT NULL,
  UNIQUE KEY chat_poll_option_position (message_id, position),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE TABLE chat_poll_votes (
  message_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  option_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (option_id) REFERENCES chat_poll_options(id) ON DELETE CASCADE
);
