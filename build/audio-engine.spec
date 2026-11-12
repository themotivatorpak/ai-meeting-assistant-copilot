# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for bundling audio/engine.py and audio/devtest.py
# Run from repo root on Windows: pyinstaller build/audio-engine.spec --distpath dist-python --workpath build/pyi-work --noconfirm

from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None
ROOT = Path(SPECPATH).resolve().parent
AUDIO_DIR = ROOT / "audio"

datas = []
binaries = []
hiddenimports = [
    "capture",
    "devices",
    "resampler",
    "stt",
    "stt_cloud",
    "stt_stream",
    "vad",
    "pyaudiowpatch",
    "webrtcvad",
    "websockets",
    "scipy.signal",
    "scipy.ndimage",
]

for pkg in ("faster_whisper", "ctranslate2", "onnxruntime", "tokenizers", "huggingface_hub"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

hiddenimports += collect_submodules("websockets")

a = Analysis(
    [str(AUDIO_DIR / "engine.py")],
    pathex=[str(AUDIO_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

b = Analysis(
    [str(AUDIO_DIR / "devtest.py")],
    pathex=[str(AUDIO_DIR)],
    binaries=[],
    datas=[],
    hiddenimports=["devices", "pyaudiowpatch", "numpy"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

MERGE((a, "engine", "audio-engine"), (b, "devtest", "devtest"))

pyz_a = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe_a = EXE(
    pyz_a,
    a.scripts,
    [],
    exclude_binaries=True,
    name="audio-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

pyz_b = PYZ(b.pure, b.zipped_data, cipher=block_cipher)
exe_b = EXE(
    pyz_b,
    b.scripts,
    [],
    exclude_binaries=True,
    name="devtest",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(
    exe_a,
    a.binaries,
    a.zipfiles,
    a.datas,
    exe_b,
    b.binaries,
    b.zipfiles,
    b.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="audio-engine",
)
