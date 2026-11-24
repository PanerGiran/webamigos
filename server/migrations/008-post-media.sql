-- 2026-11-24: varias fotos por post (álbum). posts.media_id queda como la primera foto.
CREATE TABLE post_media (
  post_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media(id)
);
INSERT INTO post_media (post_id, media_id, position) SELECT id, media_id, 0 FROM posts WHERE media_id IS NOT NULL;
