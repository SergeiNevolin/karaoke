"""
Текст с Genius по URL (лёгкий HTTP-хелпер для API).
Всё выравнивание текста по таймингам живёт в GPU-сервисе
(karaoke_ml_service/core/lyrics.py).
"""
from __future__ import annotations

import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from .config import MAX_HTML_BYTES

GENIUS_HOSTS = {"genius.com", "www.genius.com"}


def check_genius_url(url: str) -> None:
    """Только http(s) на genius.com — стартовый URL и каждый редирект (защита от SSRF)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Принимаются только http/https ссылки genius.com")
    if (parsed.hostname or "").lower() not in GENIUS_HOSTS:
        raise ValueError("Принимаются только ссылки genius.com")


class GeniusOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Редирект на внутренний IP/чужой хост отклоняется до соединения."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_genius_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def clean_lines(raw: list[str] | str) -> list[str]:
    if isinstance(raw, str):
        raw = raw.split("\n")
    out = []
    for line in raw:
        t = line.strip()
        if t and not re.fullmatch(r"\[.*\]", t):
            out.append(t)
    return out


def clean_genius_lines(raw: list[str]) -> list[str]:
    """Чистка сырого текста Genius: шапка страницы + [заголовки] внутри строк."""
    out = []
    for line in raw:
        t = re.sub(r"\[.*?]", "", line).strip()
        if not t or "contributors" in t.lower():
            continue
        out.append(t)
    return out


VOID = {"br", "img", "meta", "link", "hr", "input", "source", "wbr"}


class _GeniusParser(HTMLParser):
    """Собирает текст внутри [data-lyrics-container=true], <br> -> перенос."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.containers: list[int] = []  # глубины открытых lyric-контейнеров
        self.buf: list[str] = []

    def _open(self, tag: str, attrs: list) -> None:
        if tag in VOID:
            if tag == "br" and self.containers:
                self.buf.append("\n")
            return
        self.stack.append(tag)
        if tag == "div" and dict(attrs).get("data-lyrics-container") == "true":
            self.containers.append(len(self.stack))

    def _close(self, tag: str) -> None:
        if tag in VOID:
            return
        if tag in self.stack:
            while self.stack and self.stack[-1] != tag:
                self.stack.pop()
            self.stack.pop()
        self.containers = [c for c in self.containers if c <= len(self.stack)]

    def handle_starttag(self, tag: str, attrs: list) -> None:
        self._open(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        self._open(tag, attrs)  # VOID (br) -> перенос, в стек не кладём

    def handle_endtag(self, tag: str) -> None:
        self._close(tag)

    def handle_data(self, data: str) -> None:
        if self.containers and (not self.stack or self.stack[-1] not in ("script", "style")):
            self.buf.append(data.replace("\xa0", " "))  # nbsp -> space

    def lines(self) -> list[str]:
        return clean_lines("".join(self.buf).split("\n"))


def fetch_genius_lines(url: str, timeout: int = 20) -> list[str]:
    check_genius_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (karaoke-local)"})
    opener = urllib.request.build_opener(GeniusOnlyRedirects())
    with opener.open(req, timeout=timeout) as r:  # noqa: S310
        blob = r.read(MAX_HTML_BYTES + 1)
    if len(blob) > MAX_HTML_BYTES:
        raise ValueError("Страница Genius слишком большая")
    html = blob.decode("utf-8", errors="replace")
    lines = _GeniusParser()
    lines.feed(html)
    found = clean_genius_lines(lines.lines())
    if not found:
        raise ValueError("Текст не найден на странице")
    return found
