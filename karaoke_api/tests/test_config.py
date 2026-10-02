"""Fail-fast валидация конфигурации на старте."""
import pytest

from karaoke_api import config


def test_valid_defaults_pass():
    config.validate_config()


@pytest.mark.parametrize("attr,value,piece", [
    ("MAX_UPLOAD_MB", 0, "MAX_UPLOAD_MB"),
    ("MAX_BUNDLE_MB", -1, "MAX_BUNDLE_MB"),
    ("KARAOKE_ML_SERVICE_URL", "gpu-box:8001", "KARAOKE_ML_SERVICE_URL"),
    ("KARAOKE_ML_SERVICE_URL", "ftp://gpu", "KARAOKE_ML_SERVICE_URL"),
    ("KARAOKE_ML_SERVICE_URL", "", "KARAOKE_ML_SERVICE_URL"),
    ("LOG_LEVEL", "INFO2", "LOG_LEVEL"),
])
def test_bad_config_rejected(monkeypatch, attr, value, piece):
    monkeypatch.setattr(config, attr, value)
    with pytest.raises(ValueError, match=piece):
        config.validate_config()
