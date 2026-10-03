"""Хранилище объектов Silo/S3: все постоянные данные песен живут в бакете.

Раскладка ключей (бакет S3_BUCKET, по умолчанию karaoke):
  songs/<id>/...   канон песни + опубликованные mp3/JSON (мета, текст, волна,
                   history/) — отдаётся наружу как /songs/<id>/...
  music/<файл>     библиотека загруженных исходников (meta.source.file)

Локальный диск — только рабочая область: распаковка бандлов, scratch.
Клиент ленивый и сбрасываемый (tests: moto, reset_client).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from . import config

log = logging.getLogger(__name__)

CHUNK = 1 << 20

_client = None


class NotFound(KeyError):
    """Объекта нет в бакете."""


class InvalidRange(ValueError):
    """Недопустимый Range-запрос (HTTP 416); size — полный размер объекта."""

    def __init__(self, size: int) -> None:
        super().__init__(f"неверный Range, объект {size} байт")
        self.size = size


def client():
    """Ленивый S3-клиент (path-style — так требует Silo).

    Читает config на каждый вызов: тесты подменяют endpoint на пустой,
    чтобы moto перехватывал запросы (кастомный endpoint он не перехватывает).
    """
    global _client
    if _client is None:
        kwargs: dict = dict(
            aws_access_key_id=config.S3_ACCESS_KEY,
            aws_secret_access_key=config.S3_SECRET_KEY,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )
        if config.S3_ENDPOINT_URL:
            kwargs["endpoint_url"] = config.S3_ENDPOINT_URL
        if config.S3_REGION:
            kwargs["region_name"] = config.S3_REGION
        _client = boto3.client("s3", **kwargs)
    return _client


def reset_client() -> None:
    """Забыть клиента (тесты: следующий client() попадёт в новый контекст moto)."""
    global _client
    _client = None


def bucket() -> str:
    return config.S3_BUCKET


def ensure_bucket() -> None:
    """Гарантировать бакет на старте: нет Silo — падаем сразу, а не в рантайме."""
    try:
        client().head_bucket(Bucket=bucket())
        return
    except ClientError:
        pass
    try:
        client().create_bucket(Bucket=bucket())
        log.info("создан бакет %s на %s", bucket(), config.S3_ENDPOINT_URL or "(moto)")
    except ClientError as e:
        raise RuntimeError(
            f"Silo {config.S3_ENDPOINT_URL}: бакет {bucket()} недоступен: {e}") from e


def _code(e: ClientError) -> str:
    return str(e.response.get("Error", {}).get("Code") or e.response.get(
        "ResponseMetadata", {}).get("HTTPStatusCode") or "")


def put(key: str, data: bytes, content_type: str | None = None) -> None:
    extra = {"ContentType": content_type} if content_type else {}
    client().put_object(Bucket=bucket(), Key=key, Body=data, **extra)


def put_json(key: str, data: dict) -> None:
    put(key, json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8"),
        "application/json")


def put_file(key: str, path: Path) -> None:
    """Залить файл (boto3 сам разобьёт на multipart)."""
    client().upload_file(str(path), bucket(), key)


def get(key: str) -> bytes | None:
    """Прочитать объект целиком (JSON/текст) или None, если нет."""
    obj = open_stream(key)
    if obj is None:
        return None
    body = obj["Body"]
    try:
        return body.read()
    finally:
        body.close()


def get_json(key: str, default=None):
    raw = get(key)
    if raw is None:
        return default
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        log.warning("не прочитали %s: %s", key, e)
        return default


def head(key: str) -> dict | None:
    """Метаданные объекта: {"size", "last_modified", "etag"} или None."""
    try:
        h = client().head_object(Bucket=bucket(), Key=key)
    except ClientError as e:
        if _code(e) in ("NoSuchKey", "404", "NotFound"):
            return None
        raise
    return {
        "size": int(h["ContentLength"]),
        "last_modified": h["LastModified"],
        "etag": str(h.get("ETag", "")).strip('"'),
    }


def exists(key: str) -> bool:
    return head(key) is not None


def list_keys(prefix: str = "") -> list[str]:
    keys: list[str] = []
    token = None
    while True:
        kw: dict = {"Bucket": bucket(), "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = client().list_objects_v2(**kw)
        keys += [o["Key"] for o in resp.get("Contents", ())]
        if not resp.get("IsTruncated"):
            return keys
        token = resp["NextContinuationToken"]


def delete(key: str) -> None:
    client().delete_object(Bucket=bucket(), Key=key)


def delete_prefix(prefix: str) -> None:
    keys = list_keys(prefix)
    for i in range(0, len(keys), 1000):
        batch = keys[i:i + 1000]
        client().delete_objects(
            Bucket=bucket(),
            Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True},
        )


def open_stream(key: str, range_: str | None = None) -> dict | None:
    """get_object для стриминга: {"Body", "ContentLength", "ContentRange"?...}.

    None — объекта нет; InvalidRange — битый Range. Тело обязаны закрыть.
    """
    kw: dict = {"Bucket": bucket(), "Key": key}
    if range_:
        kw["Range"] = range_
    try:
        return client().get_object(**kw)
    except ClientError as e:
        code = _code(e)
        if code in ("NoSuchKey", "404", "NotFound"):
            return None
        if code == "InvalidRange":
            h = head(key)
            raise InvalidRange(h["size"] if h else 0) from e
        raise


def download(key: str, dst: Path) -> Path:
    """Скачать объект на диск по чанкам (dst — рабочий каталог, не хранилище)."""
    obj = open_stream(key)
    if obj is None:
        raise NotFound(key)
    dst.parent.mkdir(parents=True, exist_ok=True)
    body = obj["Body"]
    try:
        with open(dst, "wb") as f:
            while chunk := body.read(CHUNK):
                f.write(chunk)
    finally:
        body.close()
    return dst


def health() -> bool:
    """Жив ли Silo (для диагностики)."""
    try:
        client().list_buckets()
        return True
    except Exception:  # noqa: BLE001
        return False
