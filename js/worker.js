/* Off-main-thread renderer. Protocol:
 *  {type:'source', id, w, h, rgba(ArrayBuffer)}      → {type:'source-ok', id}
 *  {type:'render', job, id, W, H, settings}          → {type:'render-ok', job, indices, gray, placement}
 *  {type:'drop', id}
 */
importScripts('pipeline.js');

const cache = new Map(); // id → { base, rotated: {90:…, 270:…} }
const MAX = 10;

function remember(id, entry) {
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > MAX) cache.delete(cache.keys().next().value);
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'source') {
      const base = SleepPipeline.prepareSource(new Uint8ClampedArray(m.rgba), m.w, m.h);
      remember(m.id, { base, rotated: {} });
      self.postMessage({ type: 'source-ok', id: m.id });
    } else if (m.type === 'render') {
      const entry = cache.get(m.id);
      if (!entry) { self.postMessage({ type: 'render-miss', job: m.job, id: m.id }); return; }
      remember(m.id, entry);
      const rot = m.settings.rotate || 0;
      let src = entry.base;
      if (rot) src = entry.rotated[rot] || (entry.rotated[rot] = SleepPipeline.rotateSource(entry.base, rot));
      const r = SleepPipeline.render(src, m.W, m.H, m.settings);
      self.postMessage(
        { type: 'render-ok', job: m.job, indices: r.indices, gray: r.gray, placement: r.placement, levels: r.levels, bgIndex: r.bgIndex },
        [r.indices.buffer, r.gray.buffer]
      );
    } else if (m.type === 'drop') {
      cache.delete(m.id);
    }
  } catch (err) {
    self.postMessage({ type: 'error', job: m.job, id: m.id, message: String(err && err.message || err) });
  }
};
