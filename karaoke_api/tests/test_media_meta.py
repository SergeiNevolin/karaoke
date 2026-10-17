"""Обложка из тегов: выбор фронта, тегов-подобьектов мимикрёй под mutagen API."""
import base64

from mutagen.flac import Picture
from mutagen.id3 import APIC, ID3

from karaoke_api.media_meta import _cover_from_tags, cover_bytes


def _id3(pics: list[APIC]) -> ID3:
    tags = ID3()
    for p in pics:
        tags.add(p)
    return tags


def test_id3_front_cover_beats_larger_other():
    big = APIC(encoding=0, mime="image/png", type=0, desc="", data=b"x" * 10_000)
    front = APIC(encoding=0, mime="image/jpeg", type=3, desc="", data=b"front" * 500)
    assert _cover_from_tags(_id3([big, front])) == b"front" * 500


def test_id3_without_front_takes_largest():
    small = APIC(encoding=0, mime="image/png", type=0, data=b"aa")
    big = APIC(encoding=0, mime="image/png", type=4, data=b"b" * 900)
    assert _cover_from_tags(_id3([small, big])) == b"b" * 900


def test_id3_without_apic_is_none():
    assert _cover_from_tags(_id3([])) is None


def test_flac_picture():
    pic = Picture()
    pic.mime = "image/png"
    pic.type = 3
    pic.data = b"flac-art"
    holder = type("T", (), {"pictures": [pic]})()
    assert _cover_from_tags(holder) == b"flac-art"
    holder2 = type("T", (), {"pictures": []})()
    assert _cover_from_tags(holder2) is None


def test_mp4_covr():
    jpg = b"\xff\xd8fake-jpeg"
    holder = type("T", (), {"get": lambda self, key: [jpg] if key == "covr" else []})()
    assert _cover_from_tags(holder) == jpg


def test_ogg_metadata_block_picture():
    pic = Picture()
    pic.mime = "image/jpeg"
    pic.type = 3
    pic.data = b"ogg-art"
    b64 = base64.b64encode(pic.write()).decode("ascii")
    holder = {"METADATA_BLOCK_PICTURE": [b64]}
    assert _cover_from_tags(holder) == b"ogg-art"


def test_pure_garbage_tags_are_none():
    class Weird:
        pass

    assert _cover_from_tags(Weird()) is None


def test_cover_bytes_unknown_file_returns_none(tmp_path):
    p = tmp_path / "song.mp3"
    p.write_bytes(b"not-an-audio-file")
    assert cover_bytes(p) is None
