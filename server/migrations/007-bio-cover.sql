-- 2026-11-24: bio y foto de portada en el perfil
ALTER TABLE users ADD COLUMN bio VARCHAR(300) NULL, ADD COLUMN cover CHAR(36) NULL;
