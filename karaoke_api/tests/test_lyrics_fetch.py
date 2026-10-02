"""Текст с Genius: проверка URL/редиректов (SSRF), парсинг контейнера, лимит размера."""
import urllib.request

import pytest

from karaoke_api.lyrics import GeniusOnlyRedirects, check_genius_url, fetch_genius_lines


@pytest.mark.parametrize("url", [
    "https://genius.com/foo",
    "http://www.genius.com/foo",
])
def test_check_allows_genius(url):
    check_genius_url(url)


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8000/x",
    "http://169.254.169.254/latest/meta-data",
    "https://evil.com/?next=genius.com",
    "ftp://genius.com/x",
    "file:///etc/passwd",
    "not-a-url",
])
def test_check_rejects(url):
    with pytest.raises(ValueError):
        check_genius_url(url)


def test_redirect_to_internal_rejected():
    h = GeniusOnlyRedirects()
    req = urllib.request.Request("https://www.genius.com/a")
    with pytest.raises(ValueError):
        h.redirect_request(req, None, 302, "Found", {}, "http://127.0.0.1:8000/steal")


def test_redirect_inside_genius_allowed():
    h = GeniusOnlyRedirects()
    req = urllib.request.Request("https://www.genius.com/a")
    out = h.redirect_request(req, None, 302, "Found", {}, "https://genius.com/b")
    assert out.full_url == "https://genius.com/b"


class _Resp:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def read(self, n: int = -1) -> bytes:
        return self.payload if n < 0 else self.payload[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> bool:
        return False


def _fake_opener(payload: bytes, seen: dict):
    class Opener:
        def open(self, req, timeout=None):
            seen["url"] = req.full_url
            return _Resp(payload)
    return Opener()


def test_fetch_parses_container(monkeypatch):
    html = ('<div data-lyrics-container="true">раз<br>два\n</div>'
            '<div data-lyrics-container="true">три</div>').encode()
    seen: dict = {}

    def fake_build(*handlers):
        from karaoke_api.lyrics import GeniusOnlyRedirects as H
        assert any(isinstance(h, H) for h in handlers), "редиректы должны фильтроваться"
        return _fake_opener(html, seen)

    monkeypatch.setattr("urllib.request.build_opener", fake_build)
    assert fetch_genius_lines("https://genius.com/x") == ["раз", "два", "три"]
    assert seen["url"] == "https://genius.com/x"


def test_fetch_rejects_huge_page(monkeypatch):
    monkeypatch.setattr("karaoke_api.lyrics.MAX_HTML_BYTES", 4)
    monkeypatch.setattr("urllib.request.build_opener",
                        lambda *h: _fake_opener(b"0123456789", {}))
    with pytest.raises(ValueError, match="слишком большая"):
        fetch_genius_lines("https://genius.com/x")


def test_fetch_empty_page(monkeypatch):
    monkeypatch.setattr("urllib.request.build_opener",
                        lambda *h: _fake_opener(b"<div></div>", {}))
    with pytest.raises(ValueError, match="не найден"):
        fetch_genius_lines("https://genius.com/x")


def test_fetch_rejects_non_genius_before_network(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("сеть не должна открываться")

    monkeypatch.setattr("urllib.request.build_opener", boom)
    with pytest.raises(ValueError):
        fetch_genius_lines("http://127.0.0.1/x")
