-- 2026-11-24: posts de perfil (no salen en el feed global) y foto de perfil completa sin recorte
ALTER TABLE posts ADD COLUMN scope ENUM('feed','profile') NOT NULL DEFAULT 'feed', ADD INDEX idx_posts_user_scope (user_id, scope, id);
ALTER TABLE users ADD COLUMN avatar_full CHAR(36) NULL;
