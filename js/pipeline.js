/* Sleep Sleeve image pipeline.
 * Pure functions, no DOM. Loaded as a classic script in both the page and the worker,
 * so it exposes a single global: SleepPipeline.
 *
 * Data flow for one render:
 *   RGBA source ─► linear luminance + alpha (cached)
 *              ─► optional 90° rotation
 *              ─► composite transparent corners onto the background (linear light)
 *              ─► resample to placed size (linear light, separable filter)
 *              ─► encode to perceptual (sRGB transfer) ─► levels/gamma/contrast/brightness ─► unsharp
 *              ─► paste into the W×H frame (letterbox pixels are flagged as "background")
 *              ─► dither image pixels only to the panel's 2 or 4 levels ─► Uint8 indices
 */
(function (global) {
  'use strict';

  // ---------- transfer functions ----------
  const SRGB_TO_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linToSrgb(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }
  function srgbToLin(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  // 4096-entry LUT for the hot linear→sRGB path
  const LIN_LUT_N = 4096;
  const LIN_TO_SRGB = new Float32Array(LIN_LUT_N + 1);
  for (let i = 0; i <= LIN_LUT_N; i++) LIN_TO_SRGB[i] = linToSrgb(i / LIN_LUT_N);
  function linToSrgbFast(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    const f = v * LIN_LUT_N, i = f | 0, t = f - i;
    return LIN_TO_SRGB[i] + (LIN_TO_SRGB[i + 1] - LIN_TO_SRGB[i]) * t;
  }

  // ---------- source preparation ----------
  /** RGBA bytes → { w, h, lum: linear relative luminance (Rec. 709), alpha: 0..1 } */
  function prepareSource(rgba, w, h) {
    const n = w * h;
    const lum = new Float32Array(n);
    const alpha = new Float32Array(n);
    let hasAlpha = false;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      lum[i] = 0.2126 * SRGB_TO_LIN[rgba[p]] + 0.7152 * SRGB_TO_LIN[rgba[p + 1]] + 0.0722 * SRGB_TO_LIN[rgba[p + 2]];
      const a = rgba[p + 3] / 255;
      alpha[i] = a;
      if (a < 1) hasAlpha = true;
    }
    return { w, h, lum, alpha, hasAlpha };
  }

  /** Rotate a prepared source by 0, 90 (clockwise) or 270 degrees. */
  function rotateSource(src, deg) {
    if (!deg) return src;
    const { w, h } = src;
    const lum = new Float32Array(w * h), alpha = new Float32Array(w * h);
    const nw = h, nh = w;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * w + x;
        let nx, ny;
        if (deg === 90) { nx = h - 1 - y; ny = x; }
        else { nx = y; ny = w - 1 - x; } // 270
        const d = ny * nw + nx;
        lum[d] = src.lum[s];
        alpha[d] = src.alpha[s];
      }
    }
    return { w: nw, h: nh, lum, alpha, hasAlpha: src.hasAlpha };
  }

  // ---------- resampling ----------
  function sinc(x) {
    if (x === 0) return 1;
    const px = Math.PI * x;
    return Math.sin(px) / px;
  }
  const FILTERS = {
    lanczos3: { support: 3, fn: (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
    mitchell: {
      support: 2,
      fn: (x) => {
        const B = 1 / 3, C = 1 / 3;
        x = Math.abs(x);
        if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
        if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
        return 0;
      },
    },
    box: { support: 0.5, fn: (x) => (x > -0.5 && x <= 0.5 ? 1 : 0) },
  };

  /** Per-output-pixel contribution lists for one axis. */
  function contributions(srcLen, dstLen, filterName) {
    const scale = dstLen / srcLen;
    const out = new Array(dstLen);
    if (filterName === 'nearest') {
      for (let i = 0; i < dstLen; i++) {
        const j = Math.min(srcLen - 1, Math.floor((i + 0.5) / scale));
        out[i] = { start: j, weights: new Float32Array([1]) };
      }
      return out;
    }
    const f = FILTERS[filterName] || FILTERS.lanczos3;
    const fscale = Math.max(1, 1 / scale);
    const support = f.support * fscale;
    for (let i = 0; i < dstLen; i++) {
      const center = (i + 0.5) / scale;
      const lo = Math.max(0, Math.floor(center - support));
      const hi = Math.min(srcLen - 1, Math.ceil(center + support));
      const ws = new Float32Array(hi - lo + 1);
      let sum = 0;
      for (let j = lo; j <= hi; j++) {
        const wgt = f.fn((j + 0.5 - center) / fscale);
        ws[j - lo] = wgt;
        sum += wgt;
      }
      if (sum !== 0) for (let k = 0; k < ws.length; k++) ws[k] /= sum;
      else { ws.fill(0); ws[Math.min(ws.length - 1, Math.round(center - 0.5) - lo)] = 1; }
      out[i] = { start: lo, weights: ws };
    }
    return out;
  }

  /** Separable resize of a single-channel float image. */
  function resize(src, sw, sh, dw, dh, filterName) {
    if (sw === dw && sh === dh) return Float32Array.from(src);
    const cx = contributions(sw, dw, filterName);
    const cy = contributions(sh, dh, filterName);
    const tmp = new Float32Array(dw * sh);
    for (let y = 0; y < sh; y++) {
      const row = y * sw, orow = y * dw;
      for (let x = 0; x < dw; x++) {
        const c = cx[x];
        let acc = 0;
        const ws = c.weights, base = row + c.start;
        for (let k = 0; k < ws.length; k++) acc += src[base + k] * ws[k];
        tmp[orow + x] = acc;
      }
    }
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const c = cy[y], ws = c.weights, orow = y * dw;
      for (let x = 0; x < dw; x++) {
        let acc = 0;
        for (let k = 0; k < ws.length; k++) acc += tmp[(c.start + k) * dw + x] * ws[k];
        out[orow + x] = acc;
      }
    }
    return out;
  }

  // ---------- placement ----------
  /**
   * Returns { dw, dh, ox, oy, filter } — the scaled image size and its top-left offset in the frame.
   * Offsets can be negative (cropped) or positive (letterboxed); align 0..1 picks where.
   */
  function computePlacement(sw, sh, W, H, s) {
    const zoom = Math.max(0.1, (s.zoom || 100) / 100);
    let sx, sy, filter = s.resample || 'lanczos3';
    switch (s.fit) {
      case 'cover': sx = sy = Math.max(W / sw, H / sh) * zoom; break;
      case 'width': sx = sy = (W / sw) * zoom; break;
      case 'height': sx = sy = (H / sh) * zoom; break;
      case 'stretch': sx = (W / sw) * zoom; sy = (H / sh) * zoom; break;
      case 'native': sx = sy = 1; filter = 'nearest'; break;
      case 'integer': {
        const k = Math.floor(Math.min(W / sw, H / sh));
        if (k >= 1) { sx = sy = k; filter = 'nearest'; }
        else {
          const n = Math.ceil(Math.max(sw / W, sh / H));
          sx = sy = 1 / n; filter = 'box';
        }
        break;
      }
      case 'contain':
      default: sx = sy = Math.min(W / sw, H / sh) * zoom;
    }
    let dw, dh;
    if (s.fit === 'integer' && sx < 1) {
      const n = Math.round(1 / sx);
      dw = Math.floor(sw / n); dh = Math.floor(sh / n);
    } else {
      dw = Math.max(1, Math.round(sw * sx));
      dh = Math.max(1, Math.round(sh * sy));
    }
    const ax = s.alignX == null ? 0.5 : s.alignX;
    const ay = s.alignY == null ? 0.5 : s.alignY;
    const ox = Math.round((W - dw) * ax);
    const oy = Math.round((H - dh) * ay);
    return { dw, dh, ox, oy, filter };
  }

  // ---------- tone ----------
  function percentileLevels(lum, alpha, lo, hi) {
    const hist = new Uint32Array(1024);
    let count = 0;
    for (let i = 0; i < lum.length; i++) {
      if (alpha && alpha[i] < 0.5) continue;
      const v = linToSrgbFast(lum[i]);
      hist[Math.min(1023, (v * 1023 + 0.5) | 0)]++;
      count++;
    }
    if (!count) return [0, 1];
    const loN = count * lo, hiN = count * hi;
    let acc = 0, black = 0, white = 1;
    for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= loN) { black = i / 1023; break; } }
    acc = 0;
    for (let i = 1023; i >= 0; i--) { acc += hist[i]; if (acc >= count - hiN) { white = i / 1023; break; } }
    if (white - black < 0.05) return [0, 1];
    return [black, white];
  }

  /** In-place tone mapping of perceptual values. */
  function applyTone(buf, s, levels) {
    const [black, white] = levels;
    const span = white - black;
    const gamma = s.gamma || 1;
    const invG = 1 / gamma;
    const c = (s.contrast || 0) / 100; // -1..1
    const b = (s.brightness || 0) / 100; // -1..1
    // Contrast as a smooth S-curve that keeps 0 and 1 fixed.
    const k = c >= 0 ? 1 + c * 4 : 1 / (1 - c * 4 * 0.75);
    for (let i = 0; i < buf.length; i++) {
      let v = (buf[i] - black) / span;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (gamma !== 1) v = Math.pow(v, invG);
      if (c !== 0) {
        // symmetric power curve around 0.5
        v = v < 0.5 ? 0.5 * Math.pow(2 * v, k) : 1 - 0.5 * Math.pow(2 * (1 - v), k);
      }
      v += b;
      buf[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  function unsharp(buf, w, h, amount, sigma) {
    if (!amount) return;
    const r = Math.max(1, Math.ceil(sigma * 2.5));
    const kern = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) { kern[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += kern[i + r]; }
    for (let i = 0; i < kern.length; i++) kern[i] /= sum;
    const tmp = new Float32Array(w * h), blur = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k; acc += buf[y * w + xx] * kern[k + r]; }
      tmp[y * w + x] = acc;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k; acc += tmp[yy * w + x] * kern[k + r]; }
      blur[y * w + x] = acc;
    }
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] + amount * (buf[i] - blur[i]);
      buf[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  // ---------- dithering ----------
  const KERNELS = {
    'floyd-steinberg': { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
    atkinson: { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
    'jarvis-judice-ninke': { div: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
    stucki: { div: 42, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
    burkes: { div: 32, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]] },
    sierra: { div: 32, k: [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]] },
    'sierra-lite': { div: 4, k: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
  };

  const BAYER8 = (() => {
    const m = [[0, 2], [3, 1]];
    let cur = m;
    for (let n = 2; n < 8; n *= 2) {
      const nxt = [];
      for (let y = 0; y < n * 2; y++) {
        nxt.push([]);
        for (let x = 0; x < n * 2; x++) {
          const q = (y < n ? 0 : 2) + (x < n ? 0 : 1);
          const add = [0, 2, 3, 1][q];
          nxt[y].push(4 * cur[y % n][x % n] + add);
        }
      }
      cur = nxt;
    }
    const out = new Float32Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[y * 8 + x] = (cur[y][x] + 0.5) / 64;
    return out;
  })();

  function nearestLevel(v, P) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < P.length; k++) { const d = Math.abs(v - P[k]); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  /**
   * buf: perceptual 0..1 values (W×H). mask: 1 = image pixel, 0 = background (left untouched).
   * P: target level values in the space we dither in. Returns Uint8Array of level indices.
   */
  function dither(buf, mask, W, H, P, bgIndex, s) {
    const out = new Uint8Array(W * H);
    const method = s.dither || 'atkinson';
    const strength = s.diffusion == null ? 1 : s.diffusion / 100;
    const linear = !!s.ditherLinear;
    const Pd = linear ? P.map(srgbToLin) : P.slice();
    const work = new Float32Array(W * H);
    for (let i = 0; i < work.length; i++) work[i] = linear ? srgbToLin(buf[i]) : buf[i];

    if (method === 'none' || method === 'bayer') {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask[i]) { out[i] = bgIndex; continue; }
        const v = work[i];
        if (method === 'none') { out[i] = nearestLevel(v, Pd); continue; }
        // ordered: find the bracketing pair of levels and threshold inside it
        let k = 0;
        while (k < Pd.length - 2 && v > Pd[k + 1]) k++;
        const lo = Pd[k], hi = Pd[k + 1];
        const t = (v - lo) / (hi - lo);
        const thr = 0.5 + (BAYER8[(y & 7) * 8 + (x & 7)] - 0.5) * strength;
        out[i] = t > thr ? k + 1 : k;
      }
      return out;
    }

    const kern = KERNELS[method] || KERNELS.atkinson;
    const serp = s.serpentine !== false;
    for (let y = 0; y < H; y++) {
      const rev = serp && (y & 1);
      for (let n = 0; n < W; n++) {
        const x = rev ? W - 1 - n : n;
        const i = y * W + x;
        if (!mask[i]) { out[i] = bgIndex; continue; }
        let v = work[i];
        v = v < -0.5 ? -0.5 : v > 1.5 ? 1.5 : v;
        const q = nearestLevel(v, Pd);
        out[i] = q;
        const err = (v - Pd[q]) * strength;
        if (err === 0) continue;
        for (let k = 0; k < kern.k.length; k++) {
          const e = kern.k[k];
          const xx = x + (rev ? -e[0] : e[0]);
          const yy = y + e[1];
          if (xx < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (!mask[j]) continue; // never push error into the letterbox
          work[j] += (err * e[2]) / kern.div;
        }
      }
    }
    return out;
  }

  // ---------- full render ----------
  /**
   * src: prepared source (already rotated). W,H: panel size. s: settings.
   * Returns { indices, gray (Uint8 pre-dither preview), placement, levels }
   */
  function render(src, W, H, s) {
    const twoLevel = s.shades === 2;
    const P = twoLevel ? [0, 1] : [0, s.mid1 == null ? 1 / 3 : s.mid1, s.mid2 == null ? 2 / 3 : s.mid2, 1];
    const bgIndexMap4 = { black: 0, dark: 1, light: 2, white: 3 };
    let bgIndex = bgIndexMap4[s.background] ?? 3;
    if (twoLevel) bgIndex = bgIndex >= 2 ? 1 : 0;
    const bgPerc = P[bgIndex];
    const bgLin = srgbToLin(bgPerc);

    // composite transparency onto background (linear light)
    let lum = src.lum;
    if (src.hasAlpha) {
      lum = new Float32Array(src.lum.length);
      for (let i = 0; i < lum.length; i++) {
        const a = src.alpha[i];
        lum[i] = src.lum[i] * a + bgLin * (1 - a);
      }
    }

    const pl = computePlacement(src.w, src.h, W, H, s);
    const scaled = resize(lum, src.w, src.h, pl.dw, pl.dh, pl.filter);
    // linear → perceptual
    for (let i = 0; i < scaled.length; i++) scaled[i] = linToSrgbFast(scaled[i]);

    const levels = s.autoLevels ? percentileLevels(src.lum, src.hasAlpha ? src.alpha : null, 0.005, 0.005) : [0, 1];
    applyTone(scaled, s, levels);
    if (s.sharpen) unsharp(scaled, pl.dw, pl.dh, s.sharpen / 100, 0.8);

    // resample the alpha too, so transparent card corners count as background for dithering
    let scaledAlpha = null;
    if (src.hasAlpha) {
      const af = pl.filter === 'nearest' || pl.filter === 'box' ? pl.filter : 'mitchell';
      scaledAlpha = resize(src.alpha, src.w, src.h, pl.dw, pl.dh, af);
    }

    const frame = new Float32Array(W * H).fill(bgPerc);
    const mask = new Uint8Array(W * H);
    const x0 = Math.max(0, pl.ox), y0 = Math.max(0, pl.oy);
    const x1 = Math.min(W, pl.ox + pl.dw), y1 = Math.min(H, pl.oy + pl.dh);
    for (let y = y0; y < y1; y++) {
      const sy = y - pl.oy;
      for (let x = x0; x < x1; x++) {
        const sx = x - pl.ox;
        const si = sy * pl.dw + sx, di = y * W + x;
        if (scaledAlpha && scaledAlpha[si] < 0.02) continue; // fully transparent corner: stays clean background
        frame[di] = scaled[si];
        mask[di] = 1;
      }
    }

    const indices = dither(frame, mask, W, H, P, bgIndex, s);
    const gray = new Uint8ClampedArray(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.round(frame[i] * 255);
    return { indices, gray, placement: pl, levels: P, bgIndex };
  }

  global.SleepPipeline = {
    prepareSource, rotateSource, computePlacement, resize, render, dither,
    linToSrgb, srgbToLin, KERNELS,
  };
})(typeof self !== 'undefined' ? self : this);
