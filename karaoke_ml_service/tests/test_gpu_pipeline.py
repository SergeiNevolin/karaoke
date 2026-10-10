"""Оркестратор KaraokePipeline: стадии/прогресс, владение шагами, видео, текст."""
from __future__ import annotations

import pytest
from fakes import FakeAligner, FakePitch, FakeSeparator, FakeTranscriber, wav

import karaoke_ml_service.pipeline as pipeline_mod
from karaoke_ml_service.config import STAGE_PROGRESS
from karaoke_ml_service.pipeline import KaraokePipeline, PipelineError


def _pipe(**kw) -> KaraokePipeline:
    defaults = dict(separator=FakeSeparator(), transcriber=FakeTranscriber(),
                    pitch_extractor=FakePitch(), aligner=FakeAligner(),
                    keep_whisper=False)
    defaults.update(kw)
    return KaraokePipeline(**defaults)


def _src(tmp_path):
    return wav(tmp_path / "in.wav", seconds=1.0)


def test_stage_sequence_and_progress(tmp_path):
    events = []
    res = _pipe().run(_src(tmp_path), tmp_path / "work", lang="ru",
                      on_stage=lambda s, p: events.append((s, p)))
    assert [s for s, _ in events] == ["separation", "separation",
                                      "lyrics", "lyrics", "pitch", "pitch", "export"]
    assert events[0][1] == STAGE_PROGRESS["separation"][0]
    assert events[1][1] == STAGE_PROGRESS["separation"][1]
    assert events[2][1] == STAGE_PROGRESS["lyrics"][0]
    assert events[3][1] == STAGE_PROGRESS["lyrics"][1]
    assert events[4][1] == STAGE_PROGRESS["pitch"][0]
    assert events[5][1] == STAGE_PROGRESS["pitch"][1]
    assert events[6][1] == STAGE_PROGRESS["export"][0]
    progresses = [p for _, p in events]
    assert progresses == sorted(progresses), "прогресс должен идти вверх"
    assert set(res) == {"vocals", "minus", "original", "lyrics", "pitch"}
    assert res["lyrics"]["language"] == "ru"
    from pathlib import Path
    assert Path(res["vocals"]).is_file() and Path(res["minus"]).is_file()
    assert Path(res["original"]).is_file()  # demux-вход, из него original.mp3


def test_lang_passed_to_transcriber(tmp_path):
    tr = FakeTranscriber()
    _pipe(transcriber=tr).run(_src(tmp_path), tmp_path / "work", lang="en")
    assert tr.calls[-1][1] == "en"


def test_custom_text_overlay(tmp_path):
    res = _pipe().run(_src(tmp_path), tmp_path / "work", text="hello brave world")
    texts = " ".join(s["text"] for s in res["lyrics"]["segments"])
    assert "brave" in texts, texts


def test_audio_ext_no_demux(monkeypatch, tmp_path):
    monkeypatch.setattr(pipeline_mod, "demux",
                        lambda *a, **kw: pytest.fail("для аудио demux не нужен"))
    sep = FakeSeparator()
    src = _src(tmp_path)
    _pipe(separator=sep).run(src, tmp_path / "work")
    assert sep.calls == [src]


def test_video_calls_demux(monkeypatch, tmp_path):
    seen = {}

    def fake_demux(src, dst):
        seen["src"] = src
        wav(dst)

    monkeypatch.setattr(pipeline_mod, "demux", fake_demux)
    video = tmp_path / "in.mp4"
    video.write_bytes(b"fake-video")
    sep = FakeSeparator()
    _pipe(separator=sep).run(video, tmp_path / "work")
    assert seen["src"] == video
    assert sep.calls == [tmp_path / "work" / "in.wav"]


def test_video_without_ffmpeg(monkeypatch, tmp_path):
    monkeypatch.setattr(pipeline_mod.shutil, "which", lambda name: None)
    with pytest.raises(PipelineError, match="ffmpeg"):
        _pipe().run(tmp_path / "in.mp4", tmp_path / "work")


def test_owned_steps_closed_after_run(monkeypatch, tmp_path):
    made = {}

    class SpySep(FakeSeparator):
        def __init__(self, **kw):
            super().__init__(**kw)
            made["sep"] = self

    class SpyTr(FakeTranscriber):
        def __init__(self, **kw):
            super().__init__(**kw)
            made["tr"] = self

    class SpyPx(FakePitch):
        def __init__(self, **kw):
            super().__init__(**kw)
            made["px"] = self

    class SpyAl(FakeAligner):
        def __init__(self, **kw):
            super().__init__(**kw)
            made["al"] = self

    monkeypatch.setattr(pipeline_mod, "VocalSeparator", lambda **kw: SpySep(**kw))
    monkeypatch.setattr(pipeline_mod, "Transcriber", lambda **kw: SpyTr(**kw))
    monkeypatch.setattr(pipeline_mod, "PitchExtractor", lambda: SpyPx())
    monkeypatch.setattr(pipeline_mod, "WordAligner", lambda **kw: SpyAl(**kw))
    KaraokePipeline(keep_whisper=False).run(_src(tmp_path), tmp_path / "work")
    assert made["sep"].closed and made["tr"].closed and made["px"].closed
    assert made["al"].closed, "свой алайнер выгружаем (VRAM под CREPE)"


def test_injected_steps_not_closed(tmp_path):
    sep, tr, px = FakeSeparator(), FakeTranscriber(), FakePitch()
    al = FakeAligner()
    _pipe(separator=sep, transcriber=tr, pitch_extractor=px, aligner=al).run(
        _src(tmp_path), tmp_path / "work")
    assert not (sep.closed or tr.closed or px.closed), "чужие экземпляры не наши"
    assert not al.closed, "инжектированный алайнер не закрываем"


def test_shared_whisper_not_closed_and_reused(monkeypatch, tmp_path):
    tr = FakeTranscriber()
    monkeypatch.setattr(pipeline_mod, "shared_transcriber", lambda: tr)
    p = KaraokePipeline(keep_whisper=True, aligner=FakeAligner())
    p.run(_src(tmp_path), tmp_path / "w1")
    p.run(_src(tmp_path), tmp_path / "w2")
    assert not tr.closed, "кэш процесса не выгружаем"
    assert len(tr.calls) == 2


def test_step_error_propagates(tmp_path):
    class Angry(FakeSeparator):
        def separate(self, src, out_dir):
            raise RuntimeError("demucs умер")

    with pytest.raises(RuntimeError, match="demucs умер"):
        _pipe(separator=Angry()).run(_src(tmp_path), tmp_path / "work")


def test_aligner_called_with_vocals_and_lang(tmp_path):
    tr, al = FakeTranscriber(), FakeAligner()
    _pipe(transcriber=tr, aligner=al).run(
        _src(tmp_path), tmp_path / "work", lang="ru")
    assert len(al.calls) == 1
    vocals, lang = al.calls[0]
    assert vocals.name == "vocals.wav", vocals
    assert lang == "ru"


def test_align_disabled_skips_aligner(tmp_path):
    al = FakeAligner()
    res = _pipe(aligner=al, enable_align=False).run(
        _src(tmp_path), tmp_path / "work")
    assert al.calls == []
    assert res["lyrics"]["segments"][0]["words"][0]["s"] == 0.0


def test_aligner_error_does_not_fail_job(tmp_path):
    class AngryAligner(FakeAligner):
        def align(self, vocals, segments, lang=None):
            raise RuntimeError("align умер")

    res = _pipe(aligner=AngryAligner()).run(_src(tmp_path), tmp_path / "work")
    assert res["lyrics"]["segments"][0]["text"] == "a"


def test_align_before_custom_text_transfer(tmp_path):
    """Выравнивание идёт до наложения своего текста — transfer наследует точные якоря."""

    class ShiftAligner(FakeAligner):
        def align(self, vocals, segments, lang=None):
            super().align(vocals, segments, lang)
            out = []
            for seg in segments:
                out.append({**seg, "start": seg["start"] + 0.2, "end": seg["end"] + 0.2,
                            "words": [{**w, "s": w["s"] + 0.2, "e": w["e"] + 0.2}
                                      for w in seg["words"]]})
            return out

    res = _pipe(aligner=ShiftAligner()).run(
        _src(tmp_path), tmp_path / "work", text="a")
    assert res["lyrics"]["segments"][0]["words"][0]["s"] == pytest.approx(0.2)
