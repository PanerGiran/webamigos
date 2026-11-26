-- 2026-11-26: responder una historia en el chat del grupo. story_id se vacía cuando la historia vence;
-- story_user_id queda, así el mensaje sigue diciendo de quién era la historia.
ALTER TABLE messages
  ADD COLUMN story_id BIGINT UNSIGNED NULL,
  ADD COLUMN story_user_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_messages_story FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_messages_story_user FOREIGN KEY (story_user_id) REFERENCES users(id);
