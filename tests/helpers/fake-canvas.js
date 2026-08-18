/**
 * A no-op 2D canvas context for jsdom.
 *
 * jsdom does not implement `<canvas>`; without this, `getContext('2d')` throws and the
 * boot smoke test cannot tell a real defect from a missing jsdom feature. Every method
 * the visualisers call is present and records nothing — the test asserts that drawing
 * *completes*, not what it drew.
 */
export function installFakeCanvas(win) {
  const context = {
    canvas: null,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px monospace',
    setTransform() {},
    scale() {},
    translate() {},
    rotate() {},
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    stroke() {},
    setLineDash() {},
    fillText() {},
    measureText: (t) => ({ width: String(t).length * 5 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    drawImage() {},
    putImageData() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  win.HTMLCanvasElement.prototype.getContext = function getContext() {
    context.canvas = this;
    return context;
  };
  // jsdom reports 0 for every layout measurement; give the canvases a plausible size so
  // `resizeCanvas` does not bail out and the drawing code actually runs.
  Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 900;
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 200;
    },
  });
  win.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 200, width: 900, height: 200 };
  };
  return context;
}
