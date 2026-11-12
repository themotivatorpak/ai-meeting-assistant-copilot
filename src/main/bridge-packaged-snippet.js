// Update for src/main/bridge.js
// Replace the ENGINE / CANDIDATES / spawn block (around lines 19-39 and 102-108)
// so packaged builds launch the bundled PyInstaller executable (audio-engine.exe)
// while local development continues using .venv and audio/engine.py.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function resolveAudioEngineCommand(appRoot) {
  const packagedExe = path.join(process.resourcesPath || '', 'audio-engine', 'audio-engine.exe');

  if (app && app.isPackaged && fs.existsSync(packagedExe)) {
    return {
      exe: packagedExe,
      baseArgs: [],
      cwd: path.dirname(packagedExe),
    };
  }

  // Development fallback (mirrors original src/main/bridge.js)
  const engineScript = path.join(appRoot, 'audio', 'engine.py');
  const isMac = process.platform === 'darwin';
  const candidates = isMac
    ? [
        [path.join(appRoot, '.venv', 'bin', 'python3'), []],
        ['/opt/homebrew/bin/python3', []],
        ['python3', []],
      ]
    : [
        [path.join(appRoot, '.venv', 'Scripts', 'python.exe'), []],
        ['py', ['-3.11']],
        ['py', ['-3']],
        ['python', []],
        ['python3', []],
      ];

  // Use the same candidate picker already in bridge.js, then prepend ['-u', engineScript]:
  return {
    candidates,
    engineScript,
    cwd: appRoot,
  };
}

// When spawning in bridge.js:
// If packaged (cmd.baseArgs exists):
//   const args = ['--port', String(this.port), '--config', CONFIG];
//   this.proc = spawn(cmd.exe, args, { cwd: cmd.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
// Else (dev mode):
//   const args = [...this.python.pre, '-u', ENGINE, '--port', String(this.port), '--config', CONFIG];
//   this.proc = spawn(this.python.exe, args, { cwd: APP_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
