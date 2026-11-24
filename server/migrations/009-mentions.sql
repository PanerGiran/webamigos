-- 2026-11-24: preferencia de aviso cuando te mencionan con @usuario
ALTER TABLE users ADD COLUMN notify_mentions TINYINT(1) NOT NULL DEFAULT 1;
