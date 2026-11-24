-- 2026-11-24: apariencia guardada en la cuenta (se ve en tu perfil) y fondo del perfil
ALTER TABLE users ADD COLUMN look VARCHAR(32) NULL, ADD COLUMN profile_bg CHAR(36) NULL;
