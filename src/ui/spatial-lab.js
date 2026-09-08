/**
 * Spatial Lab — enhanced speaker map interaction, elevation, energy, motion, orientation.
 *
 * Provides:
 *  - interactive speaker map (click solo, shift multi, group audition)
 *  - elevation view
 *  - spatial energy visualization
 *  - motion preview
 *  - listener orientation dial
 *
 * Monitoring solo/mute is monitoring only and never changes export.
 */

import { $ } from './dom.js';
import { drawSpeakerMap } from '../visualizers/speaker-map.js';
import { drawElevation } from '../visualizers/elevation-view.js';
import { drawMotion } from '../visualizers/motion-viz.js';
import { initSpatialEnergy } from '../visualizers/spatial-energy.js';
import { SPEAKERS, LAYOUTS } from '../audio/immersive/layouts.js';

export function initSpatialLab(opts) {
  const { store, getLiveGraph } = opts;
  const mainCanvas = $('#spatialMapMain');
  const elevCanvas = $('#spatialMapElevation');
  const motionCanvas = $('#spatialMotionViz');
  const motionSelect = $('#spatialMotionSelect');
  const motionLabel = $('#spatialMotionLabel');
  const groupStrip = $('#spatialGroupStrip');
  if (!mainCanvas) return { tick: () => {} };

  // Solo state — monitoring only
  const solo = new Set();
  let yaw = 0; // degrees, -180..180

  const energy = initSpatialEnergy({ store, getLive: getLiveGraph });

  // Group definitions for audition buttons
  const groups = {
    front: ['L', 'R', 'C', 'Lw', 'Rw'],
    centre: ['C'],
    surround: ['Ls', 'Rs', 'Lss', 'Rss'],
    rear: ['Lrs', 'Rrs'],
    height: ['Ltf', 'Rtf', 'Ltm', 'Rtm', 'Ltr', 'Rtr', 'SL1', 'SL2', 'SH1', 'SH2'],
    sub: ['LFE', 'Sub1', 'Sub2'],
  };
  // Resolve aliases: SL1 etc are Sonic Lab; just test by ring
  const groupFor = (id) => {
    const sp = SPEAKERS[id];
    if (!sp) return null;
    if (sp.lfe) return 'sub';
    if (sp.elevation > 20) return 'height';
    if (Math.abs(sp.azimuthAdm) <= 35) return 'front';
    if (Math.abs(sp.azimuthAdm) >= 130) return 'rear';
    return 'surround';
  };

  const layoutId = () => store.getState().immersive.layout;
  const target = () => store.getState().immersive.target;

  // Click handling on main canvas
  mainCanvas.addEventListener('click', (e) => {
    const layout = LAYOUTS[layoutId()];
    if (!layout) return;
    const rect = mainCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (mainCanvas.width / rect.width);
    const y = (e.clientY - rect.top) * (mainCanvas.height / rect.height);
    const cx = mainCanvas.width / 2;
    const cy = mainCanvas.height / 2 - 6;
    const R = Math.min(mainCanvas.width, mainCanvas.height) * 0.38;
    // Hit test speakers — same yaw rotation the map is drawn with, so clicking what you
    // see and highlighting what you clicked stay true regardless of listener orientation.
    const yawRad = (yaw * Math.PI) / 180;
    let hit = null;
    let bestDist = 14;
    for (const key of layout.channels) {
      const sp = SPEAKERS[key];
      if (!sp) continue;
      const az = (sp.azimuthHrtf * Math.PI) / 180 + yawRad;
      const elFactor = 1 - Math.min(0.45, Math.max(0, sp.elevation) / 90);
      const radius = R * elFactor;
      const sx = cx + Math.sin(az) * radius;
      const sy = cy - Math.cos(az) * radius * 0.84;
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestDist) {
        bestDist = d;
        hit = key;
      }
    }
    if (!hit) return;
    if (e.shiftKey || e.metaKey) {
      if (solo.has(hit)) solo.delete(hit);
      else solo.add(hit);
    } else {
      if (solo.size === 1 && solo.has(hit)) solo.clear();
      else {
        solo.clear();
        solo.add(hit);
      }
    }
    syncGroupButtons();
    // Honest copy: this highlights the map. There is no per-speaker AUDITION path yet,
    // so "solo, monitoring only" (audible) would be a lie in both directions.
    announce(
      `Speaker ${hit} ${solo.has(hit) ? 'highlighted' : 'unhighlighted'} on the map — audio and exports are unchanged`,
    );
  });

  const syncGroupButtons = () => {
    if (!groupStrip) return;
    for (const btn of groupStrip.querySelectorAll('[data-group]')) {
      const g = btn.dataset.group;
      void groups[g];
      // For generic groups, check if any solo member belongs to group; if solo empty, none pressed
      let pressed = false;
      if (solo.size) {
        for (const s of solo) {
          if ((groups[g] && groups[g].includes(s)) || groupFor(s) === g) pressed = true;
        }
      }
      btn.setAttribute('aria-pressed', String(pressed));
    }
  };

  groupStrip?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (!btn) return;
    const g = btn.dataset.group;
    const layout = LAYOUTS[layoutId()];
    if (!layout) return;
    const keys = layout.channels.filter((k) => {
      if (groups[g]) return groups[g].includes(k);
      return groupFor(k) === g;
    });
    const allSoloed = keys.length && keys.every((k) => solo.has(k));
    if (allSoloed) keys.forEach((k) => solo.delete(k));
    else keys.forEach((k) => solo.add(k));
    syncGroupButtons();
  });
  $('#spatialSoloClear')?.addEventListener('click', () => {
    solo.clear();
    syncGroupButtons();
  });

  // Motion
  let motionMode = 'static';
  motionSelect?.addEventListener('change', (e) => {
    motionMode = e.target.value;
    if (motionLabel) motionLabel.textContent = motionMode;
    drawMotion(motionCanvas, motionMode);
  });
  if (motionCanvas) drawMotion(motionCanvas, motionMode);

  // Orientation dial
  const dial = $('#orientDial');
  const orientBtns = [...document.querySelectorAll('.orient-btn')];
  const orientHint = $('#orientHint');
  const setYaw = (deg) => {
    yaw = ((deg + 180) % 360) - 180;
    if (dial) {
      dial.style.setProperty('--yaw', `${yaw}deg`);
      dial.setAttribute('aria-valuenow', String(Math.round(yaw)));
    }
    for (const b of orientBtns) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.yaw) === yaw));
    }
    if (orientHint) {
      orientHint.textContent = `${yaw}° — facing ${yaw === 0 ? 'front' : yaw === 90 ? 'left' : yaw === -90 ? 'right' : yaw === 180 || yaw === -180 ? 'rear' : 'custom'}. Drag dial or use ←/→. Rotates the map view; the rendered bed is listener-independent.`;
    }
    // Shared with the speaker-map draw (tick()) — the dial is a monitoring aid, not a
    // render parameter.
    store.setUi({ listenerYaw: yaw });
  };
  orientBtns.forEach((b) => b.addEventListener('click', () => setYaw(Number(b.dataset.yaw))));
  $('#orientReset')?.addEventListener('click', () => setYaw(0));
  if (dial) {
    let dragging = false;
    const angleFrom = (e) => {
      const r = dial.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      return Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
    };
    dial.addEventListener('pointerdown', (e) => {
      dragging = true;
      dial.setPointerCapture(e.pointerId);
      setYaw(angleFrom(e));
    });
    dial.addEventListener('pointermove', (e) => {
      if (dragging) setYaw(angleFrom(e));
    });
    dial.addEventListener('pointerup', () => (dragging = false));
    dial.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setYaw(yaw + 15);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setYaw(yaw - 15);
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setYaw(0);
      }
    });
  }
  setYaw(store.getState().ui.listenerYaw || 0);

  const tick = () => {
    const live = getLiveGraph ? getLiveGraph() : null;
    const lid = layoutId();
    const tgt = target();
    // Main map respects solo highlighting: we pass solo set via params override? For now draw normally but with solo dimming via alpha handled by our enhanced draw? Simple: draw standard map, but we add solo text overlay
    try {
      drawSpeakerMap(mainCanvas, {
        layoutId: lid,
        target: tgt,
        analyserL: live?.analyserL ?? null,
        analyserR: live?.analyserR ?? null,
        params: store.getState().immersive,
        solo,
        yaw,
      });
    } catch {
      void 0;
    }
    try {
      drawElevation(elevCanvas, { layoutId: lid });
    } catch {
      void 0;
    }
    try {
      drawMotion(motionCanvas, motionMode);
    } catch {
      void 0;
    }
    try {
      energy.tick();
    } catch {
      void 0;
    }
  };

  return {
    tick,
    get solo() {
      return solo;
    },
    get yaw() {
      return yaw;
    },
  };
}

function announce(msg) {
  const r = document.getElementById('live-region');
  if (r) {
    r.textContent = msg;
    setTimeout(() => {
      if (r.textContent === msg) r.textContent = '';
    }, 2000);
  }
}
