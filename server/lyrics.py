"""
Текст песни от пользователя (Genius/вставка) -> наложение на тайминги Whisper.

Проблема: число строк вставленного текста обычно НЕ совпадает с числом
сегментов Whisper (пропуски, склейки). Поэтому делаем нечёткое выравнивание:
каждый сегмент ищет похожую строку (difflib), найденное — заменяет текст
с сохранением тайминга, пропущенные строки вставляются в паузы между
соседними сегментами, несопоставленное оставляем как распознал Whisper.
"""
from __future__ import annotations

import difflib
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

GENIUS_HOSTS = {"genius.com", "www.genius.com"}


def norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^\w\s]", "", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


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


def even_words(text: str, s: float, e: float) -> list[dict]:
    tokens = text.split()
    n = len(tokens)
    if n == 0:
        return []
    return [{"w": w, "s": round(s + (e - s) * i / n, 2),
             "e": round(s + (e - s) * (i + 1) / n, 2)}
            for i, w in enumerate(tokens)]


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
            self.buf.append(data.replace("", " "))

    def lines(self) -> list[str]:
        return clean_lines("".join(self.buf).split("\n"))


def fetch_genius_lines(url: str, timeout: int = 20) -> list[str]:
    host = urllib.parse.urlparse(url).hostname or ""
    if host not in GENIUS_HOSTS:
        raise ValueError("Принимаются только ссылки genius.com")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (karaoke-local)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
        html = r.read().decode("utf-8", errors="replace")
    lines = _GeniusParser()
    lines.feed(html)
    found = clean_genius_lines(lines.lines())
    if not found:
        raise ValueError("Текст не найден на странице")
    return found


def apply_text_to_segments(segments: list[dict], raw: list[str] | str,
                            threshold: float = 0.45) -> tuple[list[dict], dict]:
    """Возвращает (новые сегменты, статистика)."""
    lines = clean_lines(raw)
    if not lines:
        return segments, {"applied": False}
    snorm = [norm(s.get("text", "")) for s in segments]
    lnorm = [norm(line) for line in lines]
    n, m = len(segments), len(lines)

    match: dict[int, int] = {}
    j = 0
    for i in range(n):
        best, bestr = -1, 0.0
        for k in range(j, m):
            r = difflib.SequenceMatcher(None, snorm[i], lnorm[k]).ratio()
            if r > bestr:
                best, bestr = k, r
        if bestr >= threshold:
            match[i] = best
            j = best + 1

    def with_text(seg: dict, text: str) -> dict:
        d = dict(seg)
        d["text"] = text
        if norm(text) == norm(seg.get("text", "")):
            return d  # текст тот же — точные word-timings целы
        d["words"] = even_words(text, seg["start"], seg["end"])
        return d

    def gap_lines(texts: list[str], gs: float, ge: float) -> list[dict]:
        if ge - gs < len(texts) * 0.4:
            ge = gs + len(texts) * 2.0
        out = []
        for idx, t in enumerate(texts):
            s = round(gs + (ge - gs) * idx / len(texts), 2)
            e = round(gs + (ge - gs) * (idx + 1) / len(texts), 2)
            out.append({"start": s, "end": e, "text": t, "words": even_words(t, s, e)})
        return out

    out: list[dict] = []
    cursor = 0  # следующая неиспользованная строка
    prev_end = 0.0
    first = True
    for i, seg in enumerate(segments):
        if i in match:
            k = match[i]
            if k > cursor:  # пропущенные строки -> в паузу перед сегментом
                if first:
                    need = (k - cursor) * 2.0
                    gs = max(0.0, seg["start"] - need)
                    out.extend(gap_lines(lines[cursor:k], gs, seg["start"]))
                else:
                    out.extend(gap_lines(lines[cursor:k], prev_end, seg["start"]))
            out.append(with_text(seg, lines[k]))
            cursor = k + 1
            prev_end = seg["end"]
            first = False
        else:
            out.append(dict(seg))  # Whisper без пары — оставляем
            prev_end = seg["end"]
            first = False
    if cursor < m:  # хвост — после последней строки
        out.extend(gap_lines(lines[cursor:], prev_end + 0.3, prev_end + 0.3 + (m - cursor) * 2.5))

    stats = {"applied": True, "matched": len(match),
             "segments": len(segments), "lines": m, "result": len(out)}
    return out, stats


def apply_custom_lyrics(track_dir: str | Path, text: str = "",
                        url: str = "") -> dict:
    """Подменить текст в vocals_lyrics.json бандла. Возвращает статистику."""
    track_dir = Path(track_dir)
    p = track_dir / "vocals_lyrics.json"
    data = json.loads(p.read_text(encoding="utf-8"))
    lines = clean_lines(text) if text.strip() else []
    if not lines and url.strip():
        lines = fetch_genius_lines(url.strip())
    if not lines:
        return {"applied": False}
    new_segs, stats = apply_text_to_segments(data.get("segments", []), lines)
    data["segments"] = new_segs
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return stats
