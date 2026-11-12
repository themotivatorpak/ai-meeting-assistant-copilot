# Windows Installer Build Guide

This kit packages **[tanzeeldevAi/ai-meeting-assistant-copilot](https://github.com/tanzeeldevAi/ai-meeting-assistant-copilot)** (MIT License, Copyright (c) 2026 Tanzeel Ur Rehman `@tanzeeldevAi`) into a self-contained Windows NSIS `.exe` installer.

## What Is Included in This Kit
- `LICENSE` — Verbatim MIT License from the upstream repository.
- `THIRD_PARTY_LICENSES.md` — Copyright and license notices for all bundled runtimes and libraries.
- `electron-builder.yml` — Windows NSIS installer configuration (non-one-click so the MIT License screen is shown to users, plus `extraResources` for the bundled Python engine and license files).
- `build/audio-engine.spec` — PyInstaller specification that freezes `audio/engine.py` and its dependencies (`faster-whisper`, `PyAudioWPatch`, `webrtcvad-wheels`, `numpy`, `scipy`, `websockets`) into `dist-python/audio-engine/audio-engine.exe`.
- `build/installer.nsh` — NSIS check that looks for Google Chrome or Brave and asks the user before opening the Chrome download page if neither is installed.
- `src/main/bridge-packaged-snippet.js` — Drop-in helper logic for `src/main/bridge.js` so packaged builds launch `resources/audio-engine/audio-engine.exe` instead of `.venv\Scripts\python.exe`.
- `.github/workflows/build-windows.yml` — Automated GitHub Actions workflow to build the `.exe` on `windows-latest`.

## Step 1: Clone the Upstream Repository
```cmd
git clone https://github.com/tanzeeldevAi/ai-meeting-assistant-copilot.git
cd ai-meeting-assistant-copilot
```

## Step 2: Copy These Kit Files into the Repo
Copy the contents of this kit into the root of `ai-meeting-assistant-copilot/` (keeping the `build/` and `.github/workflows/` folder structure).

## Step 3: Update `src/main/bridge.js`
Open `src/main/bridge.js` and use the logic in `src/main/bridge-packaged-snippet.js`:
- When `app.isPackaged` is `true`, spawn `path.join(process.resourcesPath, 'audio-engine', 'audio-engine.exe')` with `['--port', String(this.port), '--config', CONFIG]`.
- When running in dev mode (`!app.isPackaged`), keep the existing `.venv\Scripts\python.exe` + `audio/engine.py` path.

> **Note on `CONFIG` path:** If `src/main/bridge.js` or `src/main/store.js` writes config files inside `APP_ROOT`, make sure packaged builds write to `app.getPath('userData')` instead, because `C:\Program Files\` is read-only for standard Windows users.

## Step 4: Build the Installer

### Option A: Automated Build via GitHub Actions (Recommended)
1. Push your fork/repo with these files to GitHub.
2. Open the **Actions** tab, select **Build Windows Installer**, and click **Run workflow**.
3. Download the `.exe` installer from the workflow's **Artifacts** section.

### Option B: Local Build on Windows
Requires **Node.js >= 18** and **Python 3.10–3.12** on your build machine:
```cmd
python -m venv .venv-build
.venv-build\Scripts\activate
pip install --upgrade pip
pip install -r audio\requirements.txt
pip install pyinstaller

pyinstaller build\audio-engine.spec --distpath dist-python --workpath build\pyi-work --noconfirm

npm install
npm install --no-save electron-builder
npx electron-builder --win nsis --config electron-builder.yml
```
Your installer will be created in `dist-installer\AI Meeting Assistant Copilot-Setup-1.0.0-x64.exe`.
