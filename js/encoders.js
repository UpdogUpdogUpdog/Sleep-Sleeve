/* Sleep Sleeve encoders: BMP (1/4/24-bit) and a store-only ZIP writer. Global: SleepEncoders */
(function (global) {
  'use strict';

  // The panel's native levels. CrossPoint treats a BMP with ≤4 palette entries whose
  // luminances sit within ±21 of 0/85/170/255 as "native" and skips its own dithering.
  const NATIVE4 = [0, 85, 170, 255];

  /**
   * indices: Uint8Array of level indices (0..levels-1), row-major, top-down.
   * format: 'bmp4' (4-bit indexed, 4-entry palette), 'bmp1' (1-bit, 2-entry), 'bmp24'.
   */
  function encodeBMP(indices, W, H, levels, format) {
    const twoLevel = levels === 2;
    const values = twoLevel ? [0, 255] : NATIVE4;
    let bpp, palette;
    if (format === 'bmp24') { bpp = 24; palette = []; }
    else if (format === 'bmp1') { bpp = 1; palette = [0, 255]; }
    else { bpp = 4; palette = values; }

    // 1-bit output from 4-level indices: collapse to black/white (shouldn't normally happen;
    // the UI forces 2 shades when 1-bit is chosen).
    const toPal = (idx) => {
      if (bpp === 1) return twoLevel ? idx : (idx >= 2 ? 1 : 0);
      return idx;
    };

    const rowBytes = Math.ceil((W * bpp) / 32) * 4;
    const paletteBytes = palette.length * 4;
    const dataOffset = 14 + 40 + paletteBytes;
    const fileSize = dataOffset + rowBytes * H;
    const buf = new ArrayBuffer(fileSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // BITMAPFILEHEADER
    u8[0] = 0x42; u8[1] = 0x4d; // 'BM'
    dv.setUint32(2, fileSize, true);
    dv.setUint32(6, 0, true);
    dv.setUint32(10, dataOffset, true);
    // BITMAPINFOHEADER
    dv.setUint32(14, 40, true);
    dv.setInt32(18, W, true);
    dv.setInt32(22, H, true); // positive = bottom-up
    dv.setUint16(26, 1, true);
    dv.setUint16(28, bpp, true);
    dv.setUint32(30, 0, true); // BI_RGB, uncompressed
    dv.setUint32(34, rowBytes * H, true);
    dv.setInt32(38, 2835, true); // 72 dpi
    dv.setInt32(42, 2835, true);
    dv.setUint32(46, palette.length, true); // biClrUsed
    dv.setUint32(50, palette.length, true); // biClrImportant
    let p = 54;
    for (const g of palette) { u8[p++] = g; u8[p++] = g; u8[p++] = g; u8[p++] = 0; }

    for (let y = 0; y < H; y++) {
      const srcRow = (H - 1 - y) * W;
      const rowStart = dataOffset + y * rowBytes;
      if (bpp === 24) {
        for (let x = 0; x < W; x++) {
          const g = values[indices[srcRow + x]];
          const o = rowStart + x * 3;
          u8[o] = g; u8[o + 1] = g; u8[o + 2] = g;
        }
      } else if (bpp === 4) {
        for (let x = 0; x < W; x += 2) {
          const hi = toPal(indices[srcRow + x]);
          const lo = x + 1 < W ? toPal(indices[srcRow + x + 1]) : 0;
          u8[rowStart + (x >> 1)] = (hi << 4) | lo;
        }
      } else {
        for (let x = 0; x < W; x++) {
          if (toPal(indices[srcRow + x])) u8[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    return u8;
  }

  // ---------- ZIP (store) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Incremental zip builder. add(path, Uint8Array); toBlob() */
  function ZipWriter() {
    const parts = [];
    const central = [];
    let offset = 0;
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    function add(path, data) {
      const name = enc.encode(path);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true); // store
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      parts.push(local, data);

      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);
      offset += local.length + data.length;
    }

    function toBlob() {
      let cenSize = 0;
      for (const c of central) cenSize += c.length;
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, central.length, true);
      ev.setUint16(10, central.length, true);
      ev.setUint32(12, cenSize, true);
      ev.setUint32(16, offset, true);
      return new Blob([...parts, ...central, end], { type: 'application/zip' });
    }
    return { add, toBlob, get count() { return central.length; } };
  }

  global.SleepEncoders = { encodeBMP, ZipWriter, crc32, NATIVE4 };
})(typeof self !== 'undefined' ? self : this);
