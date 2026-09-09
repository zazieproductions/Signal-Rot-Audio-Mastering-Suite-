/**
 * Source analysis — concise hero for the loaded track.
 *
 * Shows: duration, sample rate, channels, integrated, true peak, crest,
 *        stereo correlation, spectral balance hint, plus source-aware note.
 * Uses real analysis results from state.analysis.original / processed.
 */
import { $, el, replaceChildren } from './dom.js';

export function initSourceHero(opts) {
  const { store } = opts;
  const host = $('#sourceHero');
  const body = $('#sourceHeroBody');
  const onboard = $('#sourceOnboard');
  if (!host || !body) return { sync: () => {} };

  const render = () => {
    const { source, analysis } = store.getState();
    const hasFile = !!source.buffer;
    host.hidden = false; // always show — empty state is onboarding
    // Always keep the hero visible; onboard vs stats toggle internally
    if (!hasFile) {
      host.querySelector('.hd span')?.replaceChildren(document.createTextNode('Source'));
      const hint = $('#sourceHeroHint');
      if (hint) hint.textContent = 'no file loaded — drop audio or click Import';
      if (onboard) onboard.hidden = false;
      // hide stats if they exist
      const stats = body.querySelector('.source-stats');
      if (stats) stats.remove();
      return;
    }

    if (onboard) onboard.hidden = true;
    const stats = analysis.original || {};
    const p = store.getParameters();
    // Build or replace stats
    let container = body.querySelector('.source-stats');
    if (!container) {
      container = el('div', { class: 'source-stats' });
      body.append(container);
    }

    const duration = source.durationSeconds || (source.buffer ? source.buffer.duration : 0);
    const fmtDuration = `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
    const integrated = Number.isFinite(stats.integrated) ? `${stats.integrated.toFixed(1)} LUFS` : '—';
    const peak = stats.peaks ? `${(stats.peaks.truePeakDb ?? stats.peaks.peakDb ?? 0).toFixed(1)} dBTP` : '—';
    const crest = Number.isFinite(stats.crestDb) ? `${stats.crestDb.toFixed(1)} dB` : (Number.isFinite(stats.integrated) && Number.isFinite(stats.peaks?.truePeakDb) ? `${(stats.peaks.truePeakDb - stats.integrated).toFixed(1)} dB` : '—');
    const corr = stats.correlation != null ? Number(stats.correlation).toFixed(2) : (store.getState().analysis.processed?.correlation?.toFixed(2) ?? '—');
    // Light spectral hint: use match analysis if available or simple description from tone params
    let spectralHint = '—';
    if (stats.spectralBalance) spectralHint = stats.spectralBalance;
    else if (p.tilt > 0.5) spectralHint = 'tilted bright';
    else if (p.tilt < -0.5) spectralHint = 'tilted dark';
    else spectralHint = 'balanced';

    const sourceAdaptiveNote = (() => {
      // truthful adaptation note: if match gains are active, we adapted; otherwise simple tonal
      if (Array.isArray(p.matchGains) && p.matchGains.some((g) => Math.abs(g) > 0.4)) return 'Reference match is nudging the tonal balance.';
      if (Math.abs(p.tilt) > 0.6) return `Tilt ${p.tilt > 0 ? 'brightens' : 'darkens'} the overall balance.`;
      if (Number.isFinite(stats.integrated) && stats.integrated > -11) return 'Loud source — limiter budget will be tighter.';
      if (Number.isFinite(stats.integrated) && stats.integrated < -20) return 'Quiet/delicate source — headroom is generous.';
      return 'No automatic tonal correction — processing follows your controls.';
    })();

    replaceChildren(
      container,
      el('div', { class: 'source-hero has-file' }, [
        el('div', {}, [
          el('div', { style: 'font: 700 14px var(--ui); color: var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;', text: source.name || 'Untitled' }),
          el('div', { class: 'source-meta' }, [
            el('span', { html: `<b>⏱</b> ${fmtDuration}` }),
            el('span', { html: `<b>◐</b> ${(source.sampleRate || source.buffer?.sampleRate || 0) / 1000} kHz` }),
            el('span', { html: `<b>◧</b> ${source.channels || source.buffer?.numberOfChannels || 0} ch` }),
            el('span', { html: `<b>◇</b> ${source.buffer ? 'decoded' : ''} ${source.buffer ? Math.round(source.buffer.length / source.buffer.sampleRate / 60 * 10) / 10 : ''}` }),
          ]),
          el('div', { class: 'source-analysis' }, [
            el('div', { class: 'sa-item' }, [el('div', { class: 'k', text: 'Integrated' }), el('div', { class: 'v', text: integrated }), el('div', { class: 'u', text: 'BS.1770-4 gated' })]),
            el('div', { class: 'sa-item' }, [el('div', { class: 'k', text: 'True peak' }), el('div', { class: 'v', text: peak }), el('div', { class: 'u', text: 'polyphase est.' })]),
            el('div', { class: 'sa-item' }, [el('div', { class: 'k', text: 'Crest' }), el('div', { class: 'v', text: crest }), el('div', { class: 'u', text: 'peak − LUFS' })]),
            el('div', { class: 'sa-item' }, [el('div', { class: 'k', text: 'Correlation' }), el('div', { class: 'v', text: String(corr) }), el('div', { class: 'u', text: 'stereo coherence' })]),
            el('div', { class: 'sa-item' }, [el('div', { class: 'k', text: 'Spectral' }), el('div', { class: 'v', text: spectralHint }), el('div', { class: 'u', text: 'balance hint' })]),
            el('div', { class: 'sa-item' }, [el('div', { class: 'k', text: 'Engine' }), el('div', { class: 'v', text: p.normalize ? `${p.targetLUFS.toFixed(1)} LUFS tgt` : 'no norm' }), el('div', { class: 'u', text: `ceiling ${p.ceiling.toFixed(1)} dBTP` })]),
          ]),
          el('div', { class: 'callout', style: 'margin-top:12px', text: sourceAdaptiveNote }),
        ]),
        el('div', { style: 'background: var(--panel2); border:1px solid var(--line2); border-radius: var(--r); padding:10px;' }, [
          el('div', { class: 'k', style: 'font:600 8px var(--mono); letter-spacing:0.12em; text-transform:uppercase; color:var(--faint); margin-bottom:6px', text: 'What happens next' }),
          el('div', { class: 'hint', text: 'Choose a Preset profile, then refine with perceptual macros. A/B at matched loudness before exporting.' }),
          el('div', { style: 'display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;' }, [
            el('button', { class: 'btn tiny ghost', text: 'Presets →', onclick: () => document.getElementById('presetCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }),
            el('button', { class: 'btn tiny ghost', text: 'Macros →', onclick: () => document.getElementById('macroCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }),
          ]),
        ]),
      ]),
    );

    const hint = $('#sourceHeroHint');
    if (hint) hint.textContent = `${fmtDuration} · ${(source.sampleRate / 1000).toFixed(1)} kHz · ${source.channels} ch`;
  };

  store.subscribe((_s, changed) => {
    if (changed.has('source') || changed.has('analysis') || changed.has('parameters')) render();
  });
  render();
  return { sync: render };
}
