"""Общие фикстуры: пустой бакет Silo (moto) + обязательный PostgreSQL.

PostgreSQL обязателен (легаси-режим удалён). Тесты работают в отдельной базе
karaoke_test (переопределяем dbname в DATABASE_URL и создаём её при необходимости)
— dev-каталог в karaoke не затрагивается. Схему поднимаем один раз на сессию,
таблицы songs/jobs вычищаем перед каждым тестом.

Важно: moto перехватывает только стандартный endpoint — S3_ENDPOINT на время
теста пустой, иначе boto3 уйдёт в реальный Silo.
"""
from urllib.parse import urlparse, urlunparse

import psycopg
import pytest
from moto import mock_aws

from karaoke_api import config, db
from karaoke_api import silo as storage

TEST_DB = "karaoke_test"


def _ensure_database(url: str) -> None:
    """CREATE DATABASE karaoke_test, если её ещё нет (подключение к postgres)."""
    u = urlparse(url)
    with psycopg.connect(urlunparse(u._replace(path="/postgres")), autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname=%s", (u.path.lstrip("/"),)).fetchone()
        if not exists:
            conn.execute(f'CREATE DATABASE "{u.path.lstrip("/")}"')


@pytest.fixture(scope="session", autouse=True)
def require_database():
    if not config.DATABASE_URL:
        pytest.fail(
            "DATABASE_URL не задан — тестам нужен PostgreSQL: поднимите "
            "`docker compose up -d postgres` в корне репо и задайте "
            "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/karaoke")
    u = urlparse(config.DATABASE_URL)
    config.DATABASE_URL = urlunparse(u._replace(path=f"/{TEST_DB}"))  # тесты не трогают dev-каталог
    try:
        _ensure_database(config.DATABASE_URL)
        db.migrate()
    except Exception as e:
        pytest.fail(f"PostgreSQL недоступен или миграция не прошла: {e}")


@pytest.fixture(autouse=True)
def s3_bucket(monkeypatch):
    monkeypatch.setattr(config, "S3_ENDPOINT_URL", "")
    monkeypatch.setattr(config, "S3_ACCESS_KEY", "testing")
    monkeypatch.setattr(config, "S3_SECRET_KEY", "testing")
    with mock_aws():
        storage.reset_client()
        storage.ensure_bucket()
        yield
        storage.reset_client()


@pytest.fixture(autouse=True)
def clean_tables():
    with db.pool().connection() as conn:
        conn.execute("TRUNCATE songs, jobs")
    yield
