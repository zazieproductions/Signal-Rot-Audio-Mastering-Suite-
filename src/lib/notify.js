/**
 * Signal Rot — minimal DOM notification + download helpers.
 * (Browser-only; the DSP/encode modules never import this.)
 */

export function toast(m, ms = 2200) {
  const t = document.querySelector('#toast');
  if (!t) return;
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), ms);
}

/**
 * Trigger a browser download of a Blob.
 * Falls back to a data URL when object URLs are unavailable.
 */
export function download(blob, name) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.querySelector('#dlAnchor') || document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    const reader = new FileReader();
    reader.onload = () => {
      const a = document.querySelector('#dlAnchor') || document.createElement('a');
      a.href = reader.result;
      a.download = name;
      a.click();
    };
    reader.onerror = () => toast('Download failed — file is ready but could not auto-save.');
    reader.readAsDataURL(blob);
  }
}

export function downloadJSON(obj, name) {
  download(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), name);
}
