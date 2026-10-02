"""Синк стадий: фронт через бэкенд видит те же ключи, что шлёт GPU-сервис."""
from __future__ import annotations

from karaoke_api.config import STAGE_LABELS
from karaoke_ml_service.config import FINAL_PROGRESS, FINAL_STAGE, STAGE_PROGRESS


def test_stage_keys_match_server_labels():
    assert set(STAGE_PROGRESS) == set(STAGE_LABELS) - {"done", "error"}


def test_final_stage_is_labeled():
    assert FINAL_STAGE in STAGE_LABELS
    assert FINAL_PROGRESS == 100


def test_progress_bounds_and_order():
    prev_end = -1
    for name, (start, end) in STAGE_PROGRESS.items():
        assert 0 <= start <= end <= 100, name
        assert start > prev_end, f"диапазоны должны идти по порядку: {name}"
        prev_end = end
    assert prev_end <= FINAL_PROGRESS
