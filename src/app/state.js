/**
 * Application state container.
 *
 * One canonical object, one way to change it, subscriptions for everything that needs to
 * react. No module reaches into another module's variables.
 *
 * ── Design ───────────────────────────────────────────────────────────────────────────
 *  · `state.parameters` is validated on every write through `app/parameters.js`.
 *  · `state.ui`, `state.source`, `state.analysis`, `state.immersive` hold everything else.
 *  · `subscribe(listener)` fires after every commit, with the set of changed top-level
 *    keys, so listeners can cheaply skip work.
 *  · Undo/redo is a bounded ring of parameter snapshots. Only parameter changes are
 *    undoable — undoing "loaded a file" is not a thing anyone wants.
 *  · A debounced autosave writes the session (parameters + immersive + UI preferences,
 *    never audio) to `localStorage`.
 */

import { defaultParameters, validateParameters, coerceParameter } from './parameters.js';
import { ENGINE_VERSION, PRESET_SCHEMA_VERSION } from './constants.js';

const AUTOSAVE_KEY = 'signal-rot:session:v3';
const UNDO_DEPTH = 60;

/** Default immersive settings. */
export function defaultImmersive() {
  return {
    layout: 'off',
    target: 'wavmc',
    centerExtract: 0.5,
    surrLevelDb: -3,
    surrDelayMs: 12,
    heightLevelDb: -6,
    heightDecorr: 0.5,
    lfeFreqHz: 120,
    lfeLevelDb: -3,
    frontRear: 0.5,
    binauralPreview: false,
    // Spatial engine (§7–§13): the classic single-band up-mixer stays the default
    // ("basic"); "spatial" is the source-aware, per-band synthesiser. Everything
    // below is inert while the mode is `basic`, so existing sessions render exactly
    // as before.
    mode: 'basic',
    spatialPreset: 'natural-room',
    motion: 'static',
    motionRate: 1,
    motionDepth: 1,
    envelopment: 0.5,
    frontFocus: 0.5,
    rearDepth: 0.5,
    roomSize: 0.5,
    heightFocus: 0.5,
    heightSpread: 0.5,
    yawDeg: 0,
    audition: {
      solo: null, // null | 'front' | 'side' | 'rear' | 'height' | 'sub' — monitoring only
      muted: [], // groups muted — monitoring only
    },
  };
}

/** Default UI state. */
function defaultUi() {
  return {
    theme: 'dark',
    tab: 'presets',
    workspace: 'master',
    abMode: 'B',
    audition: 'stereo',
    matchLoudness: false,
    abDim: false,
    listenerYaw: 0,
    presetName: 'Transparent',
    moduleBypass: {},
    rendering: false,
    exportFormat: 'wav24',
    exportSampleRate: 0,
    signalFlowOpen: true,
    macroAdvancedOpen: false,
  };
}

/**
 * @typedef {object} AppState
 * @property {Record<string, any>} parameters
 * @property {ReturnType<typeof defaultImmersive>} immersive
 * @property {ReturnType<typeof defaultUi>} ui
 * @property {object} source
 * @property {object} analysis
 */

function initialState() {
  return {
    parameters: defaultParameters(),
    immersive: defaultImmersive(),
    ui: defaultUi(),
    source: {
      /** @type {AudioBuffer|null} */ buffer: null,
      name: '',
      /** @type {AudioBuffer|null} */ referenceBuffer: null,
      referenceName: '',
      durationSeconds: 0,
      sampleRate: 0,
      channels: 0,
    },
    analysis: {
      /** @type {object|null} */ original: null,
      /** @type {object|null} */ processed: null,
      /** @type {object|null} */ match: null,
      running: false,
    },
  };
}

export function createStore() {
  let state = initialState();
  /** @type {Set<(s:AppState, changed:Set<string>)=>void>} */
  const listeners = new Set();

  /** @type {Record<string, any>[]} */
  const undoStack = [];
  /** @type {Record<string, any>[]} */
  const redoStack = [];
  let autosaveTimer = null;
  let suppressHistory = 0;

  const notify = (changed) => {
    for (const l of listeners) {
      try {
        l(state, changed);
      } catch (error) {
        // A broken listener must not take the engine down mid-render.
        console.error('[signal-rot] store listener threw:', error);
      }
    }
  };

  const scheduleAutosave = () => {
    if (typeof localStorage === 'undefined') return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          AUTOSAVE_KEY,
          JSON.stringify({
            schemaVersion: PRESET_SCHEMA_VERSION,
            engineVersion: ENGINE_VERSION,
            savedAt: new Date().toISOString(),
            parameters: state.parameters,
            immersive: state.immersive,
            ui: {
              theme: state.ui.theme,
              tab: state.ui.tab,
              workspace: state.ui.workspace,
              presetName: state.ui.presetName,
              moduleBypass: state.ui.moduleBypass,
              exportFormat: state.ui.exportFormat,
              exportSampleRate: state.ui.exportSampleRate,
              signalFlowOpen: state.ui.signalFlowOpen,
            },
          }),
        );
      } catch {
        // Quota exceeded or storage disabled — autosave is a convenience, not a contract.
      }
    }, 400);
  };

  const pushHistory = () => {
    if (suppressHistory > 0) return;
    undoStack.push({ ...state.parameters, matchGains: state.parameters.matchGains.slice() });
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    redoStack.length = 0;
  };

  const api = {
    /** @returns {AppState} */
    getState: () => state,

    /** Current parameter snapshot (a copy — mutating it does nothing). */
    getParameters: () => ({
      ...state.parameters,
      matchGains: state.parameters.matchGains.slice(),
    }),

    /**
     * @param {(s:AppState, changed:Set<string>)=>void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Set one parameter. Value is coerced and clamped against the schema.
     * @param {string} key
     * @param {any} value
     * @param {object} [opts]
     * @param {boolean} [opts.history] record for undo (default true)
     */
    setParameter(key, value, opts = {}) {
      const coerced = coerceParameter(key, value);
      if (coerced === undefined) {
        console.warn(`[signal-rot] setParameter: unknown key "${key}"`);
        return;
      }
      if (state.parameters[key] === coerced) return;
      if (opts.history !== false) pushHistory();
      state = { ...state, parameters: { ...state.parameters, [key]: coerced } };
      scheduleAutosave();
      notify(new Set(['parameters']));
    },

    /**
     * Replace many parameters at once (preset application, preset load, reset).
     * @param {Record<string, any>} patch
     * @param {object} [opts]
     * @param {boolean} [opts.replace] start from defaults instead of merging
     * @param {boolean} [opts.history]
     */
    setParameters(patch, opts = {}) {
      if (opts.history !== false) pushHistory();
      const base = opts.replace ? defaultParameters() : state.parameters;
      const merged = { ...base, ...patch };
      const { parameters } = validateParameters(merged);
      state = { ...state, parameters };
      scheduleAutosave();
      notify(new Set(['parameters']));
    },

    /** Patch the immersive settings. */
    setImmersive(patch) {
      state = { ...state, immersive: { ...state.immersive, ...patch } };
      scheduleAutosave();
      notify(new Set(['immersive']));
    },

    /** Patch UI state. Never autosaved except for the whitelisted preferences. */
    setUi(patch) {
      state = { ...state, ui: { ...state.ui, ...patch } };
      scheduleAutosave();
      notify(new Set(['ui']));
    },

    /** Patch source info. */
    setSource(patch) {
      state = { ...state, source: { ...state.source, ...patch } };
      notify(new Set(['source']));
    },

    /** Patch analysis results. */
    setAnalysis(patch) {
      state = { ...state, analysis: { ...state.analysis, ...patch } };
      notify(new Set(['analysis']));
    },

    /** Toggle a module's bypass in the signal-flow view. */
    toggleModuleBypass(moduleId) {
      const current = !!state.ui.moduleBypass[moduleId];
      api.setUi({ moduleBypass: { ...state.ui.moduleBypass, [moduleId]: !current } });
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    undo() {
      const prev = undoStack.pop();
      if (!prev) return false;
      redoStack.push({ ...state.parameters, matchGains: state.parameters.matchGains.slice() });
      suppressHistory++;
      state = { ...state, parameters: prev };
      suppressHistory--;
      scheduleAutosave();
      notify(new Set(['parameters']));
      return true;
    },

    redo() {
      const next = redoStack.pop();
      if (!next) return false;
      undoStack.push({ ...state.parameters, matchGains: state.parameters.matchGains.slice() });
      suppressHistory++;
      state = { ...state, parameters: next };
      suppressHistory--;
      scheduleAutosave();
      notify(new Set(['parameters']));
      return true;
    },

    /** Deterministic reset to schema defaults. */
    reset() {
      pushHistory();
      state = {
        ...state,
        parameters: defaultParameters(),
        ui: { ...state.ui, presetName: 'Transparent', moduleBypass: {} },
      };
      scheduleAutosave();
      notify(new Set(['parameters', 'ui']));
    },

    /** Restore an autosaved session, if one exists and parses. */
    restoreAutosave() {
      if (typeof localStorage === 'undefined') return false;
      let raw;
      try {
        raw = localStorage.getItem(AUTOSAVE_KEY);
      } catch {
        return false;
      }
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        const { parameters } = validateParameters(parsed.parameters);
        suppressHistory++;
        state = {
          ...state,
          parameters,
          immersive: { ...defaultImmersive(), ...(parsed.immersive ?? {}) },
          ui: { ...state.ui, ...(parsed.ui ?? {}) },
        };
        suppressHistory--;
        notify(new Set(['parameters', 'immersive', 'ui']));
        return true;
      } catch {
        // Corrupt autosave: drop it rather than fail to boot.
        try {
          localStorage.removeItem(AUTOSAVE_KEY);
        } catch {
          /* ignore */
        }
        return false;
      }
    },

    clearAutosave() {
      try {
        localStorage.removeItem(AUTOSAVE_KEY);
      } catch {
        /* ignore */
      }
    },
  };

  return api;
}

/** @typedef {ReturnType<typeof createStore>} Store */
