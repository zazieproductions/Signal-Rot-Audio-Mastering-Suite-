/**
 * Preset browser — taxonomy, search, favorites, intensity.
 *
 * Extends the existing preset panel with:
 *  - category filter pills
 *  - search
 *  - favorites (localStorage, lightweight)
 *  - intensity / loudness hints
 *  - tags: transparent / dynamic / warm / bright / dark / wide / dense / lo-fi / immersive
 */

import { PRESET_GROUPS } from '../presets/index.js';
import { $, el } from './dom.js';

const FAV_KEY = 'signal-rot:favorites';

function loadFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
}
function saveFavs(set) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...set])); } catch { void 0; }
}

export function initPresetBrowserEnhanced(_opts) {
  const host = $('#presetGroups');
  if (!host) return { sync: () => {} };

  // Insert toolbar before host
  const toolbar = el('div', { class: 'preset-toolbar', id: 'presetToolbar' }, [
    el('div', { class: 'preset-search' }, [
      el('input', { id: 'presetSearch', type: 'search', placeholder: 'Search presets — “tape”, “warm”, “-14”, “holographic”', 'aria-label': 'Search presets' }),
    ]),
    el('div', { class: 'preset-filters', id: 'presetFilters' }),
  ]);
  host.parentElement.insertBefore(toolbar, host);

  const searchInput = toolbar.querySelector('#presetSearch');
  const filtersHost = toolbar.querySelector('#presetFilters');

  const favs = loadFavs();
  let activeFilter = 'all';
  let query = '';

  const categories = [
    { id: 'all', label: 'All' },
    { id: 'favorites', label: '★ Favorites' },
    ...PRESET_GROUPS.map((g) => ({ id: g.id, label: g.label.split('—')[0].trim() })),
  ];

  for (const cat of categories) {
    const pill = el('button', {
      class: 'pill',
      'aria-pressed': String(activeFilter === cat.id),
      dataset: { filter: cat.id },
      text: cat.label,
      onclick: () => {
        activeFilter = cat.id;
        for (const p of filtersHost.querySelectorAll('.pill')) p.setAttribute('aria-pressed', String(p.dataset.filter === activeFilter));
        applyFilters();
      },
    });
    filtersHost.append(pill);
  }

  const applyFilters = () => {
    const q = query.trim().toLowerCase();
    const cards = [...host.querySelectorAll('.preset')];
    let visible = 0;
    for (const card of cards) {
      const name = (card.dataset.preset || '').toLowerCase();
      const desc = (card.querySelector('.pd')?.textContent || '').toLowerCase();
      const tag = (card.querySelector('.pt')?.textContent || '').toLowerCase();
      const group = card.dataset.group || '';
      const isFav = favs.has(card.dataset.preset);
      let show = true;
      if (activeFilter === 'favorites') show = isFav;
      else if (activeFilter !== 'all') show = group === activeFilter;
      if (show && q) show = name.includes(q) || desc.includes(q) || tag.includes(q);
      card.hidden = !show;
      // Cards are inside grids; hide empty groups
      if (show) visible++;
    }
    // Hide group labels/grids that have no visible cards
    for (const grid of host.querySelectorAll('.presets')) {
      const anyVisible = [...grid.querySelectorAll('.preset')].some((c) => !c.hidden);
      grid.hidden = !anyVisible;
      const label = grid.previousElementSibling;
      if (label && label.classList.contains('grouplab')) label.hidden = !anyVisible;
    }
    // Show empty state
    let empty = host.querySelector('#presetEmpty');
    if (visible === 0) {
      if (!empty) {
        empty = el('div', { class: 'hint', id: 'presetEmpty', text: 'No presets match — clear search or try another category.', style: 'padding:12px; text-align:center;' });
        host.append(empty);
      }
      empty.hidden = false;
    } else if (empty) empty.hidden = true;
  };

  searchInput.addEventListener('input', (e) => {
    query = e.target.value;
    applyFilters();
  });

  // Enhance existing cards with group dataset and fav button + intensity
  const enhance = () => {
    const allCards = [...host.querySelectorAll('.preset')];
    for (const group of PRESET_GROUPS) {
      for (const preset of group.presets) {
        const card = allCards.find((c) => c.dataset.preset === preset.name);
        if (!card) continue;
        card.dataset.group = group.id;
        // Add fav button if not already
        if (!card.querySelector('.preset-fav')) {
          const favBtn = el('button', {
            class: 'preset-fav',
            'aria-label': `Favorite ${preset.name}`,
            'aria-pressed': String(favs.has(preset.name)),
            text: favs.has(preset.name) ? '★' : '☆',
            title: favs.has(preset.name) ? 'Remove from favorites' : 'Add to favorites',
            onclick: (e) => {
              e.stopPropagation();
              if (favs.has(preset.name)) favs.delete(preset.name);
              else favs.add(preset.name);
              saveFavs(favs);
              favBtn.setAttribute('aria-pressed', String(favs.has(preset.name)));
              favBtn.textContent = favs.has(preset.name) ? '★' : '☆';
              if (activeFilter === 'favorites') applyFilters();
            },
          });
          card.append(favBtn);
          card.style.position = 'relative';
        }
        // Add intensity hint under description if missing
        if (!card.querySelector('.preset-intensity') && preset.parameters) {
          const intense = (() => {
            const p = preset.parameters;
            let score = 0;
            if (p.sat) score += p.sat / 20;
            if (p.tape) score += p.tape / 60;
            if (p.width && p.width > 1.4) score += (p.width - 1.2) * 2;
            if (p.drive && p.drive > 2) score += 0.6;
            if (preset.risk === 'destructive') score += 1.2;
            if (score > 1.6) return 'intense';
            if (score > 0.8) return 'moderate';
            if (score > 0.2) return 'gentle';
            return 'transparent';
          })();
          const tag = el('span', { class: 'preset-tag', text: intense });
          const loudTag = preset.parameters.targetLUFS ? el('span', { class: 'preset-tag', text: `${preset.parameters.targetLUFS} LUFS` }) : null;
          const wrap = el('div', { style: 'margin-top:6px; display:flex; gap:4px; flex-wrap:wrap;' }, [tag, loudTag]);
          wrap.className = 'preset-intensity';
          card.append(wrap);
        }
      }
    }
    applyFilters();
  };

  // Wait a tick for preset-panel to have rendered
  setTimeout(enhance, 0);
  return { sync: applyFilters };
}
