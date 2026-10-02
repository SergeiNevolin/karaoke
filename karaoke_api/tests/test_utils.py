"""karaoke_api.utils: slug, уникальные имена, атомарный JSON, время."""
import json

import pytest

import karaoke_api.utils as U
from karaoke_api.utils import atomic_write_json, now_iso, slug, unique_path


def test_slug_edges():
    assert slug("  ПОСЛАЯ   ЛЮБОВЬ: навсегда!  ") == "poslaya-lyubov-navsegda"
    assert slug("!!!") == "song"
    assert slug("") == "song"


def test_unique_path(tmp_path):
    p1, v1 = unique_path(tmp_path, "x", ".mp3")
    assert (v1, p1.name) == (1, "x.mp3")
    p1.write_bytes(b"1")
    p2, v2 = unique_path(tmp_path, "x", ".mp3")
    assert (v2, p2.name) == (2, "x-2.mp3")
    p2.write_bytes(b"2")
    p3, v3 = unique_path(tmp_path, "x", ".mp3")
    assert (v3, p3.name) == (3, "x-3.mp3")


def test_atomic_write_failure_keeps_original(tmp_path, monkeypatch):
    path = tmp_path / "a.json"
    atomic_write_json(path, {"v": 1})

    def boom(*a, **k):
        raise RuntimeError("disk full")

    with monkeypatch.context() as m:
        m.setattr(U.json, "dump", boom)
        with pytest.raises(RuntimeError, match="disk full"):
            atomic_write_json(path, {"v": 2})
    assert json.loads(path.read_text(encoding="utf-8")) == {"v": 1}
    assert list(tmp_path.glob("*.tmp")) == []


def test_now_iso_format():
    stamp = now_iso()
    assert len(stamp) == 19
    assert stamp[4] == stamp[7] == "-" and stamp[10] == " " and stamp[13] == ":"
