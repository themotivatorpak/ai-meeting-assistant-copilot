'use strict';
/**
 * Flat-file persistence. Deliberately not SQLite: every native module is a
 * rebuild risk on this machine, and a meeting's worth of text is tiny.
 *
 * data/
 *   settings.json          app-wide settings
 *   meetings/<id>.json     one file per meeting: brief + transcript + notes
 */

const fs = require('fs');
const path = require('path');

let electronApp = null;
try {
  electronApp = require('electron').app;
} catch {
  electronApp = null;
}

const ROOT = (electronApp && electronApp.isPackaged)
  ? path.join(electronApp.getPath('userData'), 'data')
  : path.join(__dirname, '..', '..', 'data');
const MEETINGS = path.join(ROOT, 'meetings');
const SETTINGS = path.join(ROOT, 'settings.json');

const DEFAULT_SETTINGS = {
  overlay: {
    width: 520, height: 620, x: null, y: null, size: 'medium', opacity: 0.92,
    clickThrough: false,
    // If an ENTIRE-SCREEN share starts on a machine that cannot exclude the
    // overlay from capture, hide it rather than let the other side see a dark
    // rectangle. Sharing a window or a tab is unaffected.
    autoHideOnScreenShare: true,
  },
  audio: {
    backend: 'local',
    partial_model: 'tiny.en',
    final_model: 'tiny.en',
    compute_type: 'int8',
    cpu_threads: 3,
    language: 'en',
    partials: false,
    listen_me: true,
    echo_guard: true,
    // Pinned devices, by NAME (null = follow the Windows default, like Zoom's
    // "Same as System"). Names survive replugging; PortAudio indices do not.
    input_device: null,
    output_device: null,
    // Streaming, not batch: audio goes up WHILE they talk, so the final lands
    // ~0.2 s after they stop instead of ~2.7 s (which is upload time, not model
    // time). endpointing_ms is how long a pause ends a sentence.
    cloud: { provider: 'deepgram', api_key: '', model: 'nova-2',
             endpointing_ms: 500, interim_results: true },
  },
  brain: {
    // Live answers. Aliases rather than dated model ids, so the Claude CLI
    // picks the current model and an install never breaks when an old one is
    // retired. Haiku is the fastest to the first word (see docs/BENCHMARKS.md).
    model: 'haiku',
    // Prep questions and the closing summary: nobody is waiting on these.
    deepModel: 'sonnet',
    style: 'conversational',
    maxWords: 110,
    autoAnswer: true,
    suggestions: true,
    mock: false,
    apiKey: '',              // Anthropic key: only if the CLI cannot use the subscription
    provider: 'claude',      // 'claude' | 'codex' (ChatGPT subscription) | 'openai' (API key)
    openaiKey: '',           // OpenAI API key, only for provider 'openai'
    openaiModel: 'gpt-4o-mini',
    codexPath: '',           // optional: full path to the codex binary if it is not found
    codexModel: '',          // empty = the default model for a ChatGPT sign-in
    codexEffort: 'low',      // the fastest effort the ChatGPT sign-in accepts
    fallbackToOpenAI: true,  // if Claude fails mid-meeting, keep answering with a backup brain
  },
  // Read the answers on your phone instead of on screen. The only way to be
  // invisible in EVERY share mode, including entire-screen, on hardware that
  // cannot exclude a window from capture.
  companion: { enabled: true, port: 8899 },
  hotkeys: {
    toggleOverlay: 'Control+Shift+Space',
    clickThrough: 'Control+Shift+X',
    panic: 'Control+Shift+H',
    ask: 'Control+Shift+A',
    repeat: 'Control+Shift+R',
  },
};

function ensure() {
  for (const d of [ROOT, MEETINGS]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, obj) {
  ensure();
  // Write-then-rename so a crash mid-write cannot leave a truncated file.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] !== null
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

// ---------- settings ----------

// Settings saved by older versions hold dated model ids. Map them onto the
// aliases so the dropdowns show the right choice and a retired model id cannot
// break an install that was working.
function modelAlias(id) {
  const m = String(id || '').toLowerCase();
  for (const family of ['haiku', 'sonnet', 'opus']) if (m.includes(family)) return family;
  return id;
}

function getSettings() {
  ensure();
  const s = deepMerge(DEFAULT_SETTINGS, readJSON(SETTINGS, {}));
  s.brain.model = modelAlias(s.brain.model);
  s.brain.deepModel = modelAlias(s.brain.deepModel);
  return s;
}

function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch || {});
  writeJSON(SETTINGS, next);
  return next;
}

// ---------- meetings ----------

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function blankMeeting(id) {
  return {
    id,
    createdAt: new Date().toISOString(),
    endedAt: null,
    brief: {
      title: '',
      kind: 'client call',        // interview | client call | sales | standup | other
      company: '',
      role: '',
      otherSide: '',              // who is on the call
      goal: '',                   // what a win looks like
      background: '',             // my skills / product / the deal so far
      terms: [],                  // jargon, names, products -> Whisper hotwords
      questionsToAsk: [],
      docs: [],                   // pasted reference material
    },
    prep: { clarifiers: [], answers: {} },  // Claude's pre-meeting questions
    transcript: [],               // {role, text, at, dur}
    answers: [],                  // {forTurn, text, at, usedIt}
    notes: [],                    // {text, at, kind}
    summary: null,
  };
}

function meetingPath(id) {
  return path.join(MEETINGS, `${id}.json`);
}

function createMeeting() {
  ensure();
  const m = blankMeeting(newId());
  writeJSON(meetingPath(m.id), m);
  return m;
}

function getMeeting(id) {
  return readJSON(meetingPath(id), null);
}

function saveMeeting(m) {
  if (!m || !m.id) return null;
  writeJSON(meetingPath(m.id), m);
  return m;
}

function listMeetings() {
  ensure();
  return fs.readdirSync(MEETINGS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(MEETINGS, f), null))
    .filter(Boolean)
    .map((m) => ({
      id: m.id,
      title: m.brief?.title || m.brief?.company || 'Untitled meeting',
      kind: m.brief?.kind,
      createdAt: m.createdAt,
      endedAt: m.endedAt,
      turns: (m.transcript || []).length,
      hasSummary: !!m.summary,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function deleteMeeting(id) {
  try {
    fs.unlinkSync(meetingPath(id));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ROOT, MEETINGS,
  getSettings, saveSettings, DEFAULT_SETTINGS,
  createMeeting, getMeeting, saveMeeting, listMeetings, deleteMeeting,
  blankMeeting, newId,
};
