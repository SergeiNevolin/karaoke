-- Разовая инициализация БД караоке в общем postgres-стеке bebradio.
--
-- Выполнить один раз на среду, пока postgres поднят. Из каталога compose-файла bebradio:
--   docker compose exec -T postgres psql -U postgres -d bebradio < ../karaoke/infra/pg-karaoke.sql
-- либо вообще без compose (имя контейнера своё):
--   docker exec -i <postgres-container> psql -U postgres -d bebradio < infra/pg-karaoke.sql
--
-- Идемпотентно: повторный запуск ничего не меняет.
SELECT 'CREATE DATABASE karaoke'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'karaoke')
\gexec
