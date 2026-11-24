-- 2026-11-24: foto de perfil (nombre del archivo en uploads)
ALTER TABLE users ADD COLUMN avatar CHAR(36) NULL;
