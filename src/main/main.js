'use strict';
/**
 * Meeting Copilot - main process.
 *
 * Wires together: the Python audio sidecar (what is being said), the Claude
 * brain (what to say back), the glass overlay (where it appears), and the
 * dashboard (brief before, notes after).
 */

const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, desktopCapturer } = require('electron');
const path = require('path');

// Anything that kills startup must leave a trace. A silent failure here shows
// up to the user as "the app opens but there are no windows", with nothing to
// go on -- which is exactly what happened.
const fsCrash = require('fs');
function logFatal(where, err) {
  const line = `[${new Date().toISOString()}] ${where}: ${(err && err.stack) || err}\n`;
  try {
    const logDir = app && app.isPackaged
      ? path.join(app.getPath('userData'), 'data')
      : path.join(__dirname, '..', '..', 'data');
    fsCrash.mkdirSync(logDir, { recursive: true });
    fsCrash.appendFileSync(path.join(logDir, 'startup-error.log'), line);
  } catch { /* nothing more we can do */ }
  try { process.stderr.write(line); } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => logFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => logFatal('unhandledRejection', e));

const store = require('./store');
const { AudioBridge, resolvePython, SETUP_HINT } = require('./bridge');
const wincap = require('./win-capture');
const sharewatch = require('./sharewatch');
const { Companion } = require('./companion');
const { Brain, clarifyBrief, summariseTranscript } = require('./brain');
const { codexStatus } = require('./codex');
const { TurnBuffer } = require('./turnbuffer');

const SIZES = {
  small: { width: 380, height: 430 },
  medium: { width: 520, height: 620 },
  large: { width: 720, height: 820 },
};

// How much conversation the brain sees.
//
// Raised from 12 after a real client call: the speech service splits people into
// many short turns (39% of hers were four words or fewer), so 12 turns covered
// barely a minute and answers drifted off-topic when the trigger was a fragment.
// 24 turns keeps the thread without noticeably slowing the request.
const CONTEXT_TURNS = 24;

// Below ~0.6 the text stops being readable; at 1.0 the window stops being
// layered, and a non-layered protected window captures as a black box.
const OPACITY_MIN = 0.60;
const OPACITY_MAX = 0.97;
const clampOpacity = (v) => Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Number(v) || 0.92));

let overlay = null;
let dashboard = null;
let bridge = null;
let brain = null;

let settings = store.getSettings();
let meeting = null;          // active meeting record
let listening = false;
let lastTheySaid = '';
let captureMode = null;      // what capture protection actually got applied
let shareState = { sharing: false, mode: null, title: null };
let captureSafe = null;      // measured: can this machine truly hide the overlay?
let hiddenByShare = false;
let stopShareWatch = null;
const phone = new Companion();
let clickThrough = false;
let turnsSinceSuggest = 0;

// Holds their sentences until they have actually stopped talking. See
// turnbuffer.js -- 95 s of continuous speech arrives as eight separate finals,
// and answering each one rewrites the panel while they are still mid-thought.
const themBuffer = new TurnBuffer({
  quietMs: 1200,      // half a sentence: wait, do not guess
  readyMs: 250,       // finished sentence: go almost immediately
  maxWaitMs: 60000,
  onWaiting: (info) => toOverlay('still-talking', info),
  onFlush: (text, info) => {
    lastTheySaid = text;
    if (settings.brain.autoAnswer && brain) {
      // Drop the sentences being answered out of the context window, or Claude
      // is shown them twice.
      const ctx = recentTurns().slice(0, -info.parts);
      const id = brain.answer(text, ctx);
      if (id == null) toOverlay('no-answer-needed', { text });
    }
    if (info.interim) toOverlay('interim-answer', { text });
  },
});

// ---------------------------------------------------------------- windows

function createOverlay() {
  const { size } = settings.overlay;
  const dim = SIZES[size] || SIZES.medium;
  const area = screen.getPrimaryDisplay().workArea;

  // Saved bounds are trusted only after checking they still land on a screen --
  // monitors change, and a drag to the edge can park it out of reach.
  const want = {
    x: settings.overlay.x != null ? settings.overlay.x : area.x + area.width - dim.width - 24,
    y: settings.overlay.y != null ? settings.overlay.y : area.y + 24,
    width: settings.overlay.width || dim.width,
    height: settings.overlay.height || dim.height,
  };
  const safe = ensureOnScreen(want);
  if (safe.x !== want.x || safe.y !== want.y || safe.width !== want.width || safe.height !== want.height) {
    settings = store.saveSettings({ overlay: safe });
  }
  const { x, y } = safe;

  overlay = new BrowserWindow({
    width: safe.width,
    height: safe.height,
    x, y,
    minWidth: 320,
    minHeight: 260,
    frame: false,
    // NOT `transparent: true`. Measured on this machine (tools/capture-variants.js):
    // a transparent content-protected window is punched out of a screen capture
    // as a solid BLACK RECTANGLE, which on a shared screen is more conspicuous
    // than the overlay itself. An opaque window made translucent with
    // setOpacity() becomes a layered window, and layered windows are genuinely
    // excluded from capture -- the viewer sees whatever is behind it.
    transparent: false,
    backgroundColor: '#0b0e14',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    title: 'Meeting Copilot',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,     // must keep rendering while Meet has focus
    },
  });

  // THE FEATURE: keep the overlay out of screen sharing.
  //
  // Electron's setContentProtection() alone applies WDA_MONITOR, which hides the
  // content by painting a solid black rectangle into the capture. hideFromCapture
  // applies WDA_EXCLUDEFROMCAPTURE instead, which removes the window from the
  // capture entirely wherever the OS/GPU supports it. See docs/docs/SCREEN-SHARE.md for the
  // measurements, including the case where this GPU cannot do better than black.
  // --demo: leave the panel VISIBLE to screen recorders, for recording a demo
  // of the app itself. Never use it in a real meeting.
  captureMode = process.argv.includes('--demo')
    ? { mode: 'demo', ok: false, detail: 'DEMO MODE: the panel is visible in recordings and screen shares.' }
    : wincap.hideFromCapture(overlay);

  // The glass effect AND the thing that makes exclusion work properly.
  overlay.setOpacity(clampOpacity(settings.overlay.opacity));

  // macOS only lets a window float over ANOTHER app's fullscreen Space (Chrome
  // in fullscreen Meet) if the app has no Dock presence while the flags are
  // set. Hide the Dock icon, set the flags, bring the icon back.
  if (process.platform === 'darwin') { try { app.dock.hide(); } catch { /* ignore */ } }
  overlay.setAlwaysOnTop(true, 'screen-saver');           // above fullscreen meetings
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'darwin') { setTimeout(() => { try { app.dock.show(); } catch { /* ignore */ } }, 1500); }

  overlay.loadFile(path.join(__dirname, '..', 'overlay', 'index.html'));

  overlay.on('moved', persistBounds);
  overlay.on('resized', persistBounds);
  overlay.on('closed', () => { overlay = null; });

  // Deliberately NOT restored from settings. Starting up unable to click
  // anything is a terrible first impression; Ctrl+Shift+X turns it on.
  clickThrough = false;
  settings = store.saveSettings({ overlay: { clickThrough: false } });

  return overlay;
}

function persistBounds() {
  if (!overlay) return;
  const b = overlay.getBounds();
  settings = store.saveSettings({ overlay: { x: b.x, y: b.y, width: b.width, height: b.height } });
}

/**
 * Keep the overlay somewhere the user can actually reach it.
 *
 * Real failure: a saved position of x=1157 y=742 on a 1366x768 screen left 26
 * pixels of a 659px-tall window on screen, hidden behind the taskbar -- the
 * overlay was "gone" with no way to get it back except a hotkey. Any drag near
 * an edge could do this, because the bounds are saved verbatim.
 *
 * Returns bounds guaranteed to have a usable amount of window on some display.
 */
function ensureOnScreen(bounds) {
  const MIN_VISIBLE = 120;          // px of window that must remain reachable
  const displays = screen.getAllDisplays();

  const visibleOn = (d) => {
    const a = d.workArea;
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return Math.min(Math.max(w, 0), Math.max(h, 0));
  };

  if (displays.some((d) => visibleOn(d) >= MIN_VISIBLE)) return bounds;

  // Nowhere sensible: put it back at the default corner of the primary display.
  const a = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, a.width - 48);
  const height = Math.min(bounds.height, a.height - 48);
  return {
    x: a.x + a.width - width - 24,
    y: a.y + 24,
    width,
    height,
  };
}

function createDashboard() {
  if (dashboard) { dashboard.show(); dashboard.focus(); return dashboard; }
  dashboard = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Meeting Copilot - Dashboard',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'dashboard.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboard.loadFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
  // Links in the dashboard (the credit line, the project page) open in the
  // system browser. Without this a click navigated the dashboard window itself
  // away to the website, with no way back. Only https links are handed out,
  // and the window never navigates anywhere but its own page.
  const external = (url) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); };
  dashboard.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  dashboard.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); external(url); }
  });
  dashboard.on('closed', () => {
    dashboard = null;
    if (!listening && overlay && !overlay.isDestroyed()) overlay.close();
  });
  return dashboard;
}

function toOverlay(channel, payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}
function toDashboard(channel, payload) {
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send(channel, payload);
}

/** Mirror to the phone. Never let a companion problem break the meeting. */
function toPhone(type, payload) {
  try { phone.send(type, payload || {}); } catch { /* ignore */ }
}

/**
 * Click-through: let the mouse pass through the overlay to the meeting behind it.
 *
 * The naive version -- setIgnoreMouseEvents(true) and leave it -- makes the whole
 * window dead to the mouse, INCLUDING the button that turns it back off and the
 * bar you drag it by. You lock yourself out and the only way back is the global
 * hotkey. So instead we turn it on with `forward: true` (the renderer still sees
 * mousemove) and let the renderer re-enable input whenever the cursor is over a
 * control. Transparent areas pass clicks through; the toolbar always works.
 */
function setClickThrough(on) {
  if (!overlay) return;
  clickThrough = !!on;
  overlay.setIgnoreMouseEvents(clickThrough, { forward: true });
  settings = store.saveSettings({ overlay: { clickThrough } });
  toOverlay('overlay:clickThrough', clickThrough);
}

// ---------------------------------------------------------------- meeting

function recentTurns() {
  if (!meeting) return [];
  return meeting.transcript.slice(-CONTEXT_TURNS).map((t) => ({ role: t.role, text: t.text }));
}

function persistMeeting() {
  if (meeting) store.saveMeeting(meeting);
}

async function startListening(meetingId) {
  if (listening) return { ok: true, meeting };

  meeting = meetingId ? store.getMeeting(meetingId) : store.createMeeting();
  if (!meeting) return { ok: false, error: 'Meeting not found.' };

  settings = store.getSettings();

  // Brain first: it is the slow one to warm up, and it can warm up while audio
  // models are still loading.
  brain = new Brain();
  wireBrain();
  await brain.start(meeting.brief, settings.brain);

  bridge = new AudioBridge();
  wireBridge();
  // Give the speech service the brief's jargon up front. Applying it afterwards
  // forces the stream to reconnect, and reconnects cost audio.
  const terms = collectTerms(meeting.brief);
  const audioCfg = { ...settings.audio, cloud: { ...settings.audio.cloud, keywords: terms } };
  const ok = await bridge.start(audioCfg);
  if (!ok) return { ok: false, error: bridge.lastError };

  // Local Whisper takes its hotwords by command (no reconnect involved).
  setTimeout(() => bridge.setHotwords(terms), 1500);

  if (settings.companion.enabled) {
    try {
      phone.clearHistory();
      phone.start(settings.companion.port);
      toDashboard('companion', { url: phone.url, connected: phone.connected });
    } catch (e) {
      toDashboard('error', { where: 'companion', message: 'Phone view could not start: ' + e.message });
    }
  }

  listening = true;
  toOverlay('state', publicState());
  toDashboard('state', publicState());
  toPhone('state', { listening: true });
  return { ok: true, meeting };
}

function collectTerms(brief) {
  const t = new Set();
  for (const term of (brief?.terms || [])) if (term) t.add(String(term).trim());
  for (const f of ['company', 'role', 'otherSide']) {
    const v = brief?.[f];
    if (v) String(v).split(/[,/|]/).forEach((s) => s.trim() && t.add(s.trim()));
  }
  return [...t].slice(0, 60);
}

async function stopListening() {
  listening = false;
  themBuffer.reset();
  if (bridge) { await bridge.stop(); bridge = null; }
  if (brain) { await brain.stop(); brain = null; }
  if (meeting) { meeting.endedAt = new Date().toISOString(); persistMeeting(); }
  toPhone('state', { listening: false });
  phone.stop();
  toOverlay('state', publicState());
  toDashboard('state', publicState());
  toDashboard('companion', { url: null, connected: 0 });
  return { ok: true };
}

function publicState() {
  return {
    listening,
    meetingId: meeting?.id || null,
    title: meeting?.brief?.title || '',
    devices: bridge?.devices || {},
    brainReady: !!brain?.ready,
    mock: !!brain?.mock,
    authError: brain?.authError || null,
    clickThrough: !!settings.overlay.clickThrough,
    opacity: clampOpacity(settings.overlay.opacity),
    capture: captureMode,
    share: shareState,
    captureSafe,
    settings,
  };
}

// ---------------------------------------------------------------- wiring

function wireBridge() {
  bridge.on('log', (line) => toOverlay('log', line));

  bridge.on('fatal', (msg) => {
    toOverlay('error', { where: 'audio', message: msg });
    toDashboard('error', { where: 'audio', message: msg });
  });

  bridge.on('event', (m) => {
    switch (m.t) {
      case 'level':
        themBuffer.noteLevel(m.them);
        toOverlay('level', m);
        break;

      case 'devices':
        toOverlay('devices', m);
        toDashboard('devices', m);
        break;

      case 'status':
        toOverlay('status', m);
        break;

      case 'lag':
        toOverlay('lag', m);
        break;

      case 'error':
        toOverlay('error', { where: m.where, message: m.msg });
        break;

      case 'partial':
        toOverlay('partial', m);
        toPhone('partial', { role: m.role, text: m.text });
        break;

      case 'final':
        onFinalTurn(m);
        break;

      default:
        break;
    }
  });
}

function onFinalTurn(m) {
  if (!meeting) return;
  const turn = { role: m.role, text: m.text, at: Date.now(), dur: m.dur };
  meeting.transcript.push(turn);
  persistMeeting();
  toOverlay('turn', turn);
  toDashboard('turn', turn);
  toPhone('turn', { role: turn.role, text: turn.text });

  if (m.role !== 'them') {
    // If he starts speaking, they have clearly finished -- answer now.
    if (themBuffer.held) themBuffer.flush(false);
    return;                             // never answer my own person
  }

  themBuffer.push(m.text);
  turnsSinceSuggest += 1;
  if (settings.brain.suggestions && turnsSinceSuggest >= 3 && brain && !brain.pending) {
    turnsSinceSuggest = 0;
    setTimeout(() => { if (brain && !brain.pending) brain.suggest(recentTurns()); }, 1200);
  }
}

function wireBrain() {
  brain.on('status', (s) => toOverlay('brain', s));
  brain.on('start', (s) => {
    toOverlay('answer:start', s);
    if (s.kind !== 'suggest') toPhone('answer', { phase: 'start' });
  });
  brain.on('delta', (d) => {
    toOverlay('answer:delta', d);
    if (d.kind !== 'suggest') toPhone('answer', { phase: 'delta', full: d.full });
  });
  brain.on('superseded', (s) => toOverlay('answer:superseded', s));

  brain.on('done', (d) => {
    toOverlay('answer:done', d);
    if (d.kind === 'suggest') {
      toPhone('suggest', {
        items: String(d.text || '').split(/\r?\n/)
          .map((x) => x.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 4),
      });
    } else {
      toPhone('answer', { phase: 'done', text: d.text, ms: d.ms, skipped: d.skipped });
    }
    if (!meeting) return;
    if (d.kind === 'answer' && !d.skipped) {
      // Store the question TEXT. The old `forTurn` index was captured when the
      // answer finished, so anything said in the meantime shifted it -- the
      // saved notes showed answers attributed to the wrong turn
