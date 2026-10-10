"""Pydantic-модели входящих payload'ов API (доменные проверки — в store)."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Word(BaseModel):
    w: str
    s: float
    e: float


class Segment(BaseModel):
    start: float
    end: float
    text: str = ""
    words: list[Word] = Field(default_factory=list)
    part: str | None = None


class SkipRange(BaseModel):
    s: float
    e: float


class LyricsPut(BaseModel):
    """PUT /api/songs/{id}/lyrics."""

    language: str | None = None
    segments: list[Segment]
    skips: list[SkipRange] = Field(default_factory=list)


class SongMetaPut(BaseModel):
    """PUT /api/songs/{id}/meta: название и автор (только владелец)."""

    title: str = Field(min_length=1, max_length=200)
    artist: str | None = Field(default=None, max_length=200)
