-- 2026-11-24: responder mensajes del chat y reaccionar a mensajes
ALTER TABLE messages
  ADD COLUMN reply_to BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_messages_reply FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL;
CREATE TABLE message_reactions (
  message_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  emoji VARCHAR(16) NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
