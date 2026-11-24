-- 2026-11-24: borrado lógico de usuarios
ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL;
