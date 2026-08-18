/**
 * Signal Rot — canonical application state, undo/redo, and session persistence.
 * The only place that mutates `P` (and immersive `IM`) is this module; the engine and UI
 * route every change through it so history, autosave, and coercion stay consistent.
 */
import { defaultState, clampState } from '../lib/params.js';
import { clamp } from '../lib/math.js';
import { ENGINE_NAME, ENGINE_VERSION } from '../lib/version.js';

export const IM_DEFAULTS = {
  layout: 'off',
  target: 'wavmc',
  centerExtract: 0.5,
  surrLevel: -3,
  surrDelay: 12,
  heightLevel: -6,
  heightDecorr: 0.5,
  lfeFreq: 120,
  lfeLevel: -3,
  frontRear: 0.5,
  binPreview: false,
};

const SESSION_KEY = 'signalrot.session.v2';
const MAX_UNDO = 100;

const clone = (v) => JSON.parse(JSON.stringify(v));

export const state = {
  P: defaultState(),
  preset: 'Flat',
  abMode: 'B',
  matchLoud: false,
  IM: { ...IM_DEFAULTS },
  _undo: [],
  _redo: [],
  _listeners: new Set(),
  _autosaveTimer: null,
};

export function subscribe(fn) {
  state._listeners.add(fn);
  return () => state._listeners.delete(fn);
}

function emit() {
  for (const fn of state._listeners) {
    try {
      fn();
    } catch (e) {
      console.warn('state listener error', e);
    }
  }
}

function snapshot() {
  return {
    P: clone(state.P),
    preset: state.preset,
    IM: clone(state.IM),
    abMode: state.abMode,
  };
}

/** Push the current state onto the undo stack (call BEFORE a mutation). */
export function commit() {
  state._undo.push(snapshot());
  if (state._undo.length > MAX_UNDO) state._undo.shift();
  state._redo = [];
}

/**
 * History commit with gesture coalescing: rapid changes of the same parameter
 * (a slider drag) reuse one undo entry so a single drag is one undo step.
 */
function commitCoalesced(key) {
  const now = Date.now();
  if (state._lastKey === key && now - state._lastTime < 400) {
    state._redo = [];
    state._lastTime = now;
    return;
  }
  state._undo.push(snapshot());
  if (state._undo.length > MAX_UNDO) state._undo.shift();
  state._redo = [];
  state._lastKey = key;
  state._lastTime = now;
}

function restore(s) {
  state.P = clampState(s.P);
  state.preset = s.preset || 'Custom';
  Object.assign(state.IM, IM_DEFAULTS, s.IM || {});
  state.abMode = s.abMode || 'B';
  state._lastKey = null;
  emit();
}

export function undo() {
  if (!state._undo.length) return false;
  state._redo.push(snapshot());
  restore(state._undo.pop());
  return true;
}

export function redo() {
  if (!state._redo.length) return false;
  state._undo.push(snapshot());
  restore(state._redo.pop());
  return true;
}

export function canUndo() {
  return state._undo.length > 0;
}

export function canRedo() {
  return state._redo.length > 0;
}

/** Set a single parameter (canonical value), with optional history + autosave. */
export function setParam(key, value, { record = true } = {}) {
  if (record) commitCoalesced(key);
  if (key === 'matchGains') {
    state.P.matchGains = Array.isArray(value)
      ? value.map((v) => clamp(Number(v) || 0, -8, 8))
      : [...state.P.matchGains];
  } else {
    const coerced = clampState({ [key]: value });
    state.P[key] = coerced[key];
  }
  emit();
  scheduleAutosave();
}

/** Merge several canonical values at once. */
export function setParams(obj, { record = true } = {}) {
  if (record) commit();
  state.P = clampState({ ...state.P, ...obj });
  emit();
  scheduleAutosave();
}

/** Replace the entire parameter state (used when applying a preset). */
export function replaceState(nextParams, name) {
  commit();
  state.P = clampState(nextParams);
  state.preset = name || 'Custom';
  emit();
  scheduleAutosave();
}

export function setPreset(name) {
  state.preset = name;
  emit();
  scheduleAutosave();
}

export function setAB(mode) {
  state.abMode = mode === 'A' ? 'A' : 'B';
  emit();
}

export function setIM(key, value) {
  state.IM[key] = value;
  emit();
  scheduleAutosave();
}

export function resetState() {
  commit();
  state.P = defaultState();
  state.preset = 'Flat';
  Object.assign(state.IM, IM_DEFAULTS);
  state.abMode = 'B';
  emit();
  scheduleAutosave();
}

/* ---------------- session persistence ---------------- */

export function serializeSession() {
  return {
    version: 2,
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    preset: state.preset,
    params: clone(state.P),
    immersive: clone(state.IM),
  };
}

function scheduleAutosave() {
  clearTimeout(state._autosaveTimer);
  state._autosaveTimer = setTimeout(saveSession, 400);
}

export function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(serializeSession()));
  } catch (e) {
    console.warn('session autosave failed', e);
  }
}

/** Restore a previous session (autosaved or user file). Returns { ok, message }. */
export function loadSession(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const p = j.params || j.P || {};
    state.P = clampState(p);
    state.preset = j.preset || 'Custom';
    Object.assign(state.IM, IM_DEFAULTS, j.immersive || j.IM || {});
    state._undo = [];
    state._redo = [];
    emit();
    scheduleAutosave();
    return { ok: true, message: 'Session restored' };
  } catch (e) {
    return { ok: false, message: 'Bad session file: ' + e.message };
  }
}

export function tryRestoreAutosave() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    loadSession(raw);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- deterministic texture seed ---------------- */

/** Ensure a concrete seed exists so live preview and offline export share textures. */
export function ensureTextureSeed() {
  if (!state.P.textureSeed) {
    state.P.textureSeed = (Math.random() * 0xffffffff) >>> 0;
    emit();
    scheduleAutosave();
  }
  return state.P.textureSeed;
}

export function rollTextureSeed() {
  commit();
  state.P.textureSeed = (Math.random() * 0xffffffff) >>> 0;
  emit();
  scheduleAutosave();
  return state.P.textureSeed;
}
