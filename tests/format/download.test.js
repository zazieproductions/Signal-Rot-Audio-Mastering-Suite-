import { describe, it, expect } from 'vitest';
import { sanitizeFilename, baseNameOf } from '../../src/audio/encode/download.js';

describe('sanitizeFilename', () => {
  it('strips directory components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.wav')).toBe('evil.wav');
    expect(sanitizeFilename('/tmp/track.wav')).toBe('track.wav');
  });

  it('removes characters that break filesystems', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.wav')).toBe('abcdefgh.wav');
  });

  it('removes control characters', () => {
    expect(sanitizeFilename('good\u0000\u001fbad.wav')).toBe('goodbad.wav');
    // Tab is a control character and is removed outright, not converted to a space.
    expect(sanitizeFilename('tab\there.wav')).toBe('tabhere.wav');
  });

  /**
   * The pre-7.0 batch list wrote `file.name` straight into `innerHTML`, so a file called
   * `<img src=x onerror=alert(1)>.wav` executed script on drop. The UI now uses
   * `textContent` everywhere *and* filenames are sanitised before they reach a download.
   */
  it('neutralises an HTML-injection filename', () => {
    const hostile = '<img src=x onerror=alert(1)>.wav';
    const clean = sanitizeFilename(hostile);
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
  });

  it('rejects Windows reserved device names', () => {
    expect(sanitizeFilename('CON')).toBe('master');
    expect(sanitizeFilename('con.wav')).toBe('master');
    expect(sanitizeFilename('LPT9.txt')).toBe('master');
    expect(sanitizeFilename('PRN', { fallback: 'x' })).toBe('x');
    // Not reserved:
    expect(sanitizeFilename('CONCERT.wav')).toBe('CONCERT.wav');
  });

  it('drops leading dots and trailing dots or spaces', () => {
    expect(sanitizeFilename('.hidden.wav')).toBe('hidden.wav');
    expect(sanitizeFilename('name.  ')).toBe('name');
    expect(sanitizeFilename('  spaced  ')).toBe('spaced');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('')).toBe('master');
    expect(sanitizeFilename('///')).toBe('master');
    expect(sanitizeFilename(null)).toBe('master');
    expect(sanitizeFilename(undefined)).toBe('master');
    expect(sanitizeFilename('<<<>>>')).toBe('master');
  });

  it('truncates long names but preserves a short extension', () => {
    const long = `${'a'.repeat(300)}.wav`;
    const clean = sanitizeFilename(long);
    expect(clean.length).toBeLessThanOrEqual(120);
    expect(clean.endsWith('.wav')).toBe(true);
  });

  it('keeps unicode that is legal in filenames', () => {
    expect(sanitizeFilename('Vinyl Séance — 母音.wav')).toBe('Vinyl Séance — 母音.wav');
  });

  it('collapses runs of whitespace', () => {
    expect(sanitizeFilename('a     b.wav')).toBe('a b.wav');
  });
});

describe('baseNameOf', () => {
  it('strips the extension and sanitises', () => {
    expect(baseNameOf('My Track.wav')).toBe('My Track');
    expect(baseNameOf('../weird/name.flac')).toBe('name');
    expect(baseNameOf('no-extension')).toBe('no-extension');
  });

  it('falls back for an empty name', () => {
    expect(baseNameOf('')).toBe('master');
    expect(baseNameOf('.wav')).toBe('master');
  });

  it('keeps dots inside the name', () => {
    expect(baseNameOf('mix.v3.final.wav')).toBe('mix.v3.final');
  });
});
