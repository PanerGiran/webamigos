ALTER TABLE comments
  ADD COLUMN media_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_comments_media FOREIGN KEY (media_id) REFERENCES media(id);
