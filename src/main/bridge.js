'use strict';
/**
 * Owns the Python audio sidecar: picks a working interpreter (or bundled
 * executable in packaged builds), launches it, holds a WebSocket to it, and
 * restarts it if it dies mid-meeting.
 *
 * Everything the sidecar emits (transcript finals, levels, device changes,
 * errors) is re-emitted here as Node events for main.js to route.
 */

const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const WebSocket = require('ws');

let electronApp = null;
try {
  electronApp = require('electron').app;
} catch {
  electronApp = null;
}

const APP_ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(APP_ROOT, 'audio', 'engine.py');
const PACKAGED_ENGINE = path.join(
  process.resourcesPath || '',
  'audio-engine',
  process.platform === 'win32' ? 'audio-engine.exe' : 'audio-engine'
);

function getConfigPath() {
  if (electronApp && electronApp.isPackaged) {
    return path.join(electronApp.getPath('userData'), 'data', 'audio-config.json');
  }
  return path.join(APP_ROOT, 'data', 'audio-config.json');
}

// Ordered by preference. The sidecar needs pyaudiowpatch (Windows) or
// sounddevice (Mac), which is only installed for one of these, so we probe
// rather than guess.
const IS_MAC = process.platform === 'darwin';
const CANDIDATES = IS_MAC
  ? [
      [path.join(APP_ROOT, '.venv', 'bin', 'python3'), []],
      ['/opt/homebrew/bin/python3', []],
      ['python3', []],
    ]
  : [
      [path.join(APP_ROOT, '.venv', 'Scripts', 'python.exe'), []],
      ['py', ['-3.11']],
      ['py', ['-3']],
      ['python', []],
      ['python3', []],
    ];
// Everything the sidecar imports, so a Python that only has some of it is
// passed over instead of chosen and then dying on the first missing import.
const PROBE = IS_MAC
  ? 'import sounddevice, scipy, faster_whisper, webrtcvad, websockets; print("ok")'
  : 'import pyaudiowpatch, scipy, faster_whisper, webrtcvad, websockets; print("ok")';
const SETUP_HINT = IS_MAC
  ? 'Run SETUP-MAC.command'
  : 'Run SETUP.bat';

function resolvePython() {
  if (electronApp && electronApp.isPackaged && fs.existsSync(PACKAGED_ENGINE)) {
    return { exe: PACKAGED_ENGINE, pre: [], packaged: true };
  }

  for (const [exe, pre] of CANDIDATES) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) continue;
    try {
      const r = spawnSync(exe, [...pre, '-c', PROBE],
        { encoding: 'utf8', timeout: 25000, windowsHide: true });
      if (r.status === 0 && String(r.stdout).includes('ok')) {
        return { exe, pre, packaged: false };
      }
    } catch { /* try next */ }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

class AudioBridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ws = null;
    this.port = null;
    this.python = null;
    this.ready = false;
    this.stopping = false;
    this.lastError = null;
    this.devices = {};
    this._retry = null;
    this._backoff = 1000;
  }

  async start(audioSettings) {
    this.stopping = false;
    this.python = this.python || resolvePython();
    if (!this.python) {
      this.lastError =
        'No Python with the audio packages was found. ' + SETUP_HINT;
      this.emit('fatal', this.lastError);
      return false;
    }

    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(audioSettings, null, 2), 'utf8');

    this.port = await freePort();
    const args = this.python.packaged
      ? ['--port', String(this.port), '--config', configPath]
      : [...this.python.pre, '-u', ENGINE, '--port', String(this.port), '--config', configPath];

    this.proc = spawn(this.python.exe, args, {
      cwd: this.python.packaged ? path.dirname(this.python.exe) : APP_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (b) => this.emit('log', String(b).trim()));
    this.proc.stderr.on('data', (b) => {
      const s = String(b).trim();
      if (s) this.emit('log', s);
    });

    this.proc.on('exit', (code) => {
      this.ready = false;
      this.emit('closed', code);
      if (!this.stopping) {
        this.emit('log', `[bridge] sidecar exited (${code}); restarting`);
        this._scheduleRestart(audioSettings);
      }
    });

    this._connect(audioSettings);
    return true;
  }

  _connect(audioSettings) {
    const url = `ws://127.0.0.1:${this.port}`;
    let attempts = 0;

    const tryOnce = () => {
      if (this.stopping) return;
      attempts += 1;
      const ws = new WebSocket(url);

      ws.on('open', () => {
        this.ws = ws;
        this.ready = true;
        this._backoff = 1000;
        this.emit('log', `[bridge] connected to sidecar on ${url}`);
      });

      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'devices') this.devices = m;
        if (m.t === 'error') this.lastError = m.msg;
        this.emit('event', m);
      });

      ws.on('close', () => {
        if (this.ws === ws) { this.ws = null; this.ready = false; }
      });

      ws.on('error', () => {
        // Startup can be slow on a 2-core machine when Claude is warming up at
        // the same time, so be patient rather than declaring it dead.
        if (this.stopping) return;
        if (attempts < 180) setTimeout(tryOnce, 500);
        else this.emit('fatal', 'Audio sidecar never came up. See the log for details.');
      });
    };

    tryOnce();
  }

  _scheduleRestart(audioSettings) {
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.start(audioSettings), this._backoff);
    this._backoff = Math.min(this._backoff * 2, 15000);
  }

  send(obj) {
    if (this.ws && this.ready) {
      try { this.ws.send(JSON.stringify(obj)); return true; } catch { /* fallthrough */ }
    }
    return false;
  }

  setHotwords(terms) { return this.send({ c: 'hotwords', terms: terms || [] }); }
  pause() { return this.send({ c: 'pause' }); }
  resume() { return this.send({ c: 'resume' }); }
  rebuild() { return this.send({ c: 'rebuild' }); }

  async restart(audioSettings) {
    await this.stop();
    return this.start(audioSettings);
  }

  stop() {
    this.stopping = true;
    clearTimeout(this._retry);
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
    this.ws = null;
    this.ready = false;
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      const p = this.proc;
      this.proc = null;
      const done = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2500);
      p.once('exit', () => { clearTimeout(done); resolve(); });
      try { p.kill(); } catch { clearTimeout(done); resolve(); }
    });
  }
}

module.exports = { AudioBridge, resolvePython, SETUP_HINT };
