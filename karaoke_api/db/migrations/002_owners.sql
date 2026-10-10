-- Владелец песни и автор: кто загрузил — тот правит и удаляет.
-- artist также правится из редактора (PUT lyrics с полями title/artist).
-- Старые песни без владельца (NULL) правит любой вошедший.
ALTER TABLE IF EXISTS songs ADD COLUMN IF NOT EXISTS artist text;
ALTER TABLE IF EXISTS songs ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE IF EXISTS songs ADD COLUMN IF NOT EXISTS owner_name text;

CREATE INDEX IF NOT EXISTS songs_owner_idx ON songs (owner_id);

-- Владелец задачи, чтобы пережить рестарт воркера (иначе публикуем без автора).
ALTER TABLE IF EXISTS jobs ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE IF EXISTS jobs ADD COLUMN IF NOT EXISTS owner_name text;
