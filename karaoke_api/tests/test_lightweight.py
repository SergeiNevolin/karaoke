"""Рантайм лёгкого бэкенда не должен тянуть тяжёлые зависимости.

Проверяем в отдельном процессе: блокируем импорт torch/demucs/whisper/
CREPE/librosa/soundfile/scipy и импортируем всё, что крутится на VDS.
Упадёт — значит, кто-то притащил GPU-мир в рантайм.
"""
import subprocess
import sys
from string import Template

LIGHT_MODULES = [
    "karaoke_api.app",
    "karaoke_api.worker",
    "karaoke_api.api.songs",
    "karaoke_api.api.jobs",
    "karaoke_api.store.songs",
    "karaoke_api.store.publish",
    "karaoke_api.lyrics",
    "karaoke_api.config",
    "karaoke_api.auth",
    "karaoke_api.gpu_client",
    # karaoke_api.cli.export/fixtures — тоже лёгкие (импортируют только store/config).
    # karaoke_api.cli.rebuild_pitch тут нет сознательно: он ДВИЖОК перегона,
    # живёт там же, где torch (GPU-бокс / dev-машина).
    "karaoke_api.cli.export",
    "karaoke_api.cli.fixtures",
]

BLOCKED = {
    "torch", "librosa", "demucs", "faster_whisper", "whisper",
    "torchcrepe", "soundfile", "scipy", "pygame", "sounddevice",
}

PROBE = Template("""
import importlib
import importlib.abc
import sys

BLOCKED = $blocked


class Blocker(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in BLOCKED:
            raise ImportError(f"запрещён в лёгком рантайме: {fullname}")
        return None


sys.meta_path.insert(0, Blocker())
for mod in list(sys.modules):
    if mod.split('.')[0] in BLOCKED:
        del sys.modules[mod]

for name in $modules:
    importlib.import_module(name)
print("LIGHT OK")
""")


def test_light_runtime():
    probe = PROBE.substitute(blocked=repr(BLOCKED), modules=repr(LIGHT_MODULES))
    r = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-2000:]
    assert "LIGHT OK" in r.stdout
