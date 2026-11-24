-- 2026-11-24: editar posts y comentarios (marca "editado")
ALTER TABLE posts ADD COLUMN edited_at DATETIME NULL;
ALTER TABLE comments ADD COLUMN edited_at DATETIME NULL;
