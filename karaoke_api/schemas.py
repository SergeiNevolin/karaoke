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
