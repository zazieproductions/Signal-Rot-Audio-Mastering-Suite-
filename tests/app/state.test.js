import { describe, it, expect, vi } from 'vitest';
import { createStore, defaultImmersive } from '../../src/app/state.js';
import { defaultParameters, PARAMETERS } from '../../src/app/parameters.js';

describe('store', () => {
  it('starts from validated defaults', () => {
    const store = createStore();
    expect(store.getParameters()).toEqual(defaultParameters());
    expect(store.getState().immersive).toEqual(defaultImmersive());
    expect(store.getState().ui.abMode).toBe('B');
  });

  it('returns a copy of the parameters, not the live object', () => {
    const store = createStore();
    const p = store.getParameters();
    p.width = 99;
    p.matchGains[0] = 99;
    expect(store.getParameters().width).toBe(1);
    expect(store.getParameters().matchGains[0]).toBe(0);
  });

  it('clamps on write', () => {
    const store = createStore();
    store.setParameter('width', 1e9);
    expect(store.getParameters().width).toBe(PARAMETERS.width.max);
    store.setParameter('ceiling', 99);
    expect(store.getParameters().ceiling).toBe(PARAMETERS.ceiling.max);
  });

  it('ignores unknown keys and warns', () => {
    const store = createStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.setParameter('nope', 1);
    expect(warn).toHaveBeenCalled();
    expect(store.getParameters().nope).toBeUndefined();
    warn.mockRestore();
  });

  it('notifies subscribers with the set of changed slices', () => {
    const store = createStore();
    const seen = [];
    const unsubscribe = store.subscribe((_state, changed) => seen.push([...changed]));
    store.setParameter('width', 1.2);
    store.setUi({ abMode: 'A' });
    store.setImmersive({ layout: '5.1' });
    store.setSource({ name: 'x.wav' });
    store.setAnalysis({ running: true });
    expect(seen).toEqual([['parameters'], ['ui'], ['immersive'], ['source'], ['analysis']]);
    unsubscribe();
    store.setParameter('width', 1.3);
    expect(seen).toHaveLength(5);
  });

  it('does not notify when a write changes nothing', () => {
    const store = createStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.setParameter('width', 1);
    expect(calls).toBe(0);
  });

  it('survives a listener that throws', () => {
    const store = createStore();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.subscribe(() => {
      throw new Error('boom');
    });
    let reached = false;
    store.subscribe(() => {
      reached = true;
    });
    store.setParameter('width', 1.5);
    expect(reached).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('undo and redo', () => {
  it('walks backwards and forwards through parameter history', () => {
    const store = createStore();
    expect(store.canUndo()).toBe(false);
    store.setParameter('width', 1.2);
    store.setParameter('width', 1.4);
    expect(store.getParameters().width).toBe(1.4);

    expect(store.undo()).toBe(true);
    expect(store.getParameters().width).toBe(1.2);
    expect(store.undo()).toBe(true);
    expect(store.getParameters().width).toBe(1);
    expect(store.undo()).toBe(false);

    expect(store.redo()).toBe(true);
    expect(store.getParameters().width).toBe(1.2);
    expect(store.redo()).toBe(true);
    expect(store.getParameters().width).toBe(1.4);
    expect(store.redo()).toBe(false);
  });

  it('clears the redo stack on a new edit', () => {
    const store = createStore();
    store.setParameter('sat', 20);
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.setParameter('sat', 40);
    expect(store.canRedo()).toBe(false);
  });

  it('can skip history when asked', () => {
    const store = createStore();
    store.setParameter('sat', 10, { history: false });
    expect(store.canUndo()).toBe(false);
  });

  it('bounds the history depth', () => {
    const store = createStore();
    for (let i = 0; i < 200; i++) store.setParameter('sat', i % 100);
    let undos = 0;
    while (store.undo()) undos++;
    expect(undos).toBeLessThanOrEqual(60);
  });

  it('snapshots arrays by value', () => {
    const store = createStore();
    store.setParameters({ matchGains: [1, 2, 3, 4, 5, 6, 7, 8] });
    store.setParameters({ matchGains: [0, 0, 0, 0, 0, 0, 0, 0] });
    store.undo();
    expect(store.getParameters().matchGains).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('setParameters', () => {
  it('merges by default and replaces on request', () => {
    const store = createStore();
    store.setParameters({ width: 1.5, sat: 30 });
    store.setParameters({ warm: 2 });
    expect(store.getParameters().width).toBe(1.5);
    store.setParameters({ warm: 3 }, { replace: true });
    expect(store.getParameters().width).toBe(1);
    expect(store.getParameters().warm).toBe(3);
  });

  it('validates the merged result', () => {
    const store = createStore();
    store.setParameters({ width: 1e6, bogus: true });
    expect(store.getParameters().width).toBe(PARAMETERS.width.max);
    expect(store.getParameters().bogus).toBeUndefined();
  });
});

describe('reset and module bypass', () => {
  it('resets deterministically', () => {
    const store = createStore();
    store.setParameters({ width: 2, sat: 80, tape: 50 });
    store.setUi({ presetName: 'Rust', moduleBypass: { tone: true } });
    store.reset();
    expect(store.getParameters()).toEqual(defaultParameters());
    expect(store.getState().ui.presetName).toBe('Transparent');
    expect(store.getState().ui.moduleBypass).toEqual({});
  });

  it('toggles module bypass', () => {
    const store = createStore();
    store.toggleModuleBypass('tone');
    expect(store.getState().ui.moduleBypass.tone).toBe(true);
    store.toggleModuleBypass('tone');
    expect(store.getState().ui.moduleBypass.tone).toBe(false);
  });
});

describe('autosave', () => {
  it('is a no-op without localStorage and does not throw', () => {
    const store = createStore();
    expect(() => store.setParameter('width', 1.1)).not.toThrow();
    expect(store.restoreAutosave()).toBe(false);
    expect(() => store.clearAutosave()).not.toThrow();
  });
});
