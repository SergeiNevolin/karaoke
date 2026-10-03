"""Общие фикстуры: каждый тест работает в пустом бакете Silo (moto).

Важно: moto перехватывает только стандартный endpoint — S3_ENDPOINT на время
теста пустой, иначе boto3 уйдёт в реальный Silo.
"""
import pytest
from moto import mock_aws

from karaoke_api import config
from karaoke_api import silo as storage


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
