-- Каталог песен: производная копия meta.json (канон — объекты songs/<id>/ в Silo).
-- Обновляется хуками store (write_meta/publish); читает build_manifest.
CREATE TABLE IF NOT EXISTS songs (
    id           text PRIMARY KEY,
    title        text NOT NULL,
    language     text,
    lines        integer NOT NULL DEFAULT 0,
    duration     double precision NOT NULL DEFAULT 0,
    has_original boolean NOT NULL DEFAULT false,
    has_vocals   boolean NOT NULL DEFAULT false,
    source_sha1  text,
    created      text,
    updated      text
);

CREATE INDEX IF NOT EXISTS songs_title_idx ON songs (lower(title));

-- Реестр задач: статусы переживают рестарт API (очередь живёт в памяти).
CREATE TABLE IF NOT EXISTS jobs (
    id       text PRIMARY KEY,
    title    text NOT NULL,
    state    text NOT NULL,
    stage    text NOT NULL,
    progress integer NOT NULL DEFAULT 0,
    song_id  text,
    error    text,
    created  double precision NOT NULL,
    updated  double precision NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_updated_idx ON jobs (updated)
