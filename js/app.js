/* Sleep Sleeve UI. Depends on: SleepPipeline, SleepEncoders, Scryfall (classic scripts). */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // Panel sizes are portrait framebuffers, as CrossPoint's guide specifies for custom sleep BMPs.
  const MODELS = {
    x3: { key: 'x3', name: 'X3', W: 528, H: 792, folder: 'X3' },
    x4: { key: 'x4', name: 'X4', W: 480, H: 800, folder: 'X4' },
  };

  const DEFAULTS = {
    models: ['x3', 'x4'],
    source: 'png',
    rotate: 0,
    fit: 'contain',
    zoom: 100,
    alignX: 0.5,
    alignY: 0.5,
    resample: 'lanczos3',
    background: 'white',
    autoLevels: false,
    brightness: 0,
    contrast: 0,
    gamma: 1,
    sharpen: 0,
    shades: 4,
    dither: 'floyd-steinberg',
    diffusion: 100,
    serpentine: true,
    ditherLinear: false,
    mid1: 1 / 3,
    mid2: 2 / 3,
    credit: 'auto',
    format: 'bmp4',
    folder: '.sleep',
    bothFaces: false,
    uniqueArt: true,
  };
  const NUMERIC = new Set(['rotate', 'zoom', 'alignX', 'alignY', 'brightness', 'contrast', 'gamma', 'sharpen', 'shades', 'diffusion', 'mid1', 'mid2']);
  const STORE_KEY = 'sleep-sleeve:v1';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (_) { /* storage blocked: use defaults */ }
    return Object.assign({}, DEFAULTS);
  }
  let S = loadSettings();
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (_) { /* ignore */ }
  }

  const state = {
    cards: [],
    activeKey: null,
    view: 'dither',
    loadAbort: null,
    printAbort: null,
    exportAbort: null,
    lastResults: {}, // model → { indices, nLevels, entry, face }
    focusModel: null,
  };

  // ---------------------------------------------------------------- image fetch + decode
  const blobCache = new Map();
  async function getBlob(url, signal) {
    if (blobCache.has(url)) {
      const b = blobCache.get(url);
      blobCache.delete(url); blobCache.set(url, b);
      return b;
    }
    // cache:'no-store' matters: Scryfall only sends Access-Control-Allow-Origin when the request
    // carries an Origin header, and doesn't send Vary: Origin, so a cached no-CORS copy would fail.
    const res = await fetch(url, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal });
    if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status}).`);
    const blob = await res.blob();
    blobCache.set(url, blob);
    while (blobCache.size > 24) blobCache.delete(blobCache.keys().next().value);
    return blob;
  }

  async function decode(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, data: img.data };
  }

  // ---------------------------------------------------------------- renderer (worker with fallback)
  const Renderer = (() => {
    let worker = null;
    const known = new Set();
    const waiting = new Map();
    let seq = 0;
    const local = new Map();

    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = (e) => {
        const m = e.data;
        const key = m.type === 'source-ok' ? 'src:' + m.id : 'job:' + m.job;
        const w = waiting.get(key);
        if (!w) return;
        waiting.delete(key);
        if (m.type === 'error') w.reject(new Error(m.message));
        else w.resolve(m);
      };
      worker.onerror = () => {
        // e.g. opened from file:// where workers are blocked. Fall back to the main thread.
        worker = null;
        for (const w of waiting.values()) w.reject(new Error('__worker_failed__'));
        waiting.clear();
      };
    } catch (_) { worker = null; }

    function wait(key) { return new Promise((resolve, reject) => waiting.set(key, { resolve, reject })); }

    async function ensure(url, signal) {
      if (known.has(url)) return;
      const blob = await getBlob(url, signal);
      const img = await decode(blob);
      if (!worker) {
        local.set(url, { base: SleepPipeline.prepareSource(img.data, img.w, img.h), rotated: {} });
        while (local.size > 6) local.delete(local.keys().next().value);
        known.add(url);
        return;
      }
      const p = wait('src:' + url);
      const buf = img.data.buffer;
      worker.postMessage({ type: 'source', id: url, w: img.w, h: img.h, rgba: buf }, [buf]);
      await p;
      known.add(url);
    }

    function renderLocal(url, W, H, settings) {
      const entry = local.get(url);
      const rot = settings.rotate || 0;
      let src = entry.base;
      if (rot) src = entry.rotated[rot] || (entry.rotated[rot] = SleepPipeline.rotateSource(entry.base, rot));
      return SleepPipeline.render(src, W, H, settings);
    }

    async function render(url, W, H, settings, signal) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await ensure(url, signal);
          if (!worker) {
            if (!local.has(url)) { known.delete(url); continue; }
            return renderLocal(url, W, H, settings);
          }
          const job = ++seq;
          const p = wait('job:' + job);
          worker.postMessage({ type: 'render', job, id: url, W, H, settings });
          const m = await p;
          if (m.type === 'render-miss') { known.delete(url); continue; }
          return m;
        } catch (err) {
          if (err.message === '__worker_failed__') { known.clear(); continue; }
          throw err;
        }
      }
      throw new Error('Could not render this image.');
    }

    // Worker responses for render-miss come back as resolved messages; route them too.
    return { render, prefetch: (url) => getBlob(url).catch(() => {}) };
  })();

  // ---------------------------------------------------------------- helpers
  function faceList(card) { return Scryfall.faces(card); }
  function faceOf(entry, i) {
    const fs = faceList(entry.card);
    return fs[Math.min(i == null ? entry.face : i, fs.length - 1)];
  }
  function imageUrl(face) {
    const u = face.image_uris;
    return u[S.source] || u.png || u.large || u.normal;
  }
  function activeEntry() { return state.cards.find((c) => c.key === state.activeKey) || null; }
  function selectedModels() { return S.models.filter((m) => MODELS[m]); }
  function slug(s) {
    return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'card';
  }
  function fileBase(entry, faceIdx) {
    const c = entry.card;
    const f = faceOf(entry, faceIdx);
    return `${slug(c.set)}-${slug(c.collector_number)}-${slug(f.name)}`;
  }
  function tones() {
    if (S.shades === 2) return [0, 255];
    return [0, Math.round(S.mid1 * 255), Math.round(S.mid2 * 255), 255];
  }
  function renderSettings() {
    // a plain object for postMessage; 1-bit output always means two shades
    const s = Object.assign({}, S);
    if (s.format === 'bmp1') s.shades = 2;
    return s;
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  function setStatus(el, msg, isError) {
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  // ---------------------------------------------------------------- credit line
  function creditNeeded(pl, W, H) {
    if (S.credit === 'never') return false;
    if (S.credit === 'always') return true;
    if (S.source === 'art_crop') return true;
    return pl.ox < 0 || pl.oy < 0 || pl.ox + pl.dw > W || pl.oy + pl.dh > H;
  }

  const creditCanvas = document.createElement('canvas');
  function applyCredit(indices, W, H, nLevels, bgIndex, artist) {
    const bandH = 18;
    creditCanvas.width = W; creditCanvas.height = bandH;
    const ctx = creditCanvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, bandH);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    let size = 12;
    const left = artist ? `Illus. ${artist}` : '';
    const right = '™ & © Wizards of the Coast';
    let fits = false;
    while (size >= 9) {
      ctx.font = `600 ${size}px "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, sans-serif`;
      if (ctx.measureText(left).width + ctx.measureText(right).width + 24 <= W - 16) { fits = true; break; }
      size--;
    }
    ctx.fillText(left, 8, bandH / 2 + 0.5);
    if (fits) { ctx.textAlign = 'right'; ctx.fillText(right, W - 8, bandH / 2 + 0.5); ctx.textAlign = 'left'; }
    const px = ctx.getImageData(0, 0, W, bandH).data;
    const bandIdx = bgIndex;
    const inkIdx = bandIdx >= nLevels / 2 ? 0 : nLevels - 1;
    const y0 = H - bandH;
    for (let y = 0; y < bandH; y++) for (let x = 0; x < W; x++) {
      const ink = px[(y * W + x) * 4] < 128;
      indices[(y0 + y) * W + x] = ink ? inkIdx : bandIdx;
    }
  }

  /** Render one card face for one model and return final indices plus description. */
  async function produce(entry, faceIdx, model, signal) {
    const face = faceOf(entry, faceIdx);
    const url = imageUrl(face);
    const s = renderSettings();
    const r = await Renderer.render(url, model.W, model.H, s, signal);
    const nLevels = s.shades === 2 ? 2 : 4;
    const indices = r.indices instanceof Uint8Array ? r.indices : new Uint8Array(r.indices);
    const credited = creditNeeded(r.placement, model.W, model.H);
    if (credited) applyCredit(indices, model.W, model.H, nLevels, r.bgIndex, face.artist);
    return { indices, gray: r.gray, placement: r.placement, nLevels, credited, face };
  }

  // ---------------------------------------------------------------- previews
  const deviceEls = {};
  const BEZEL = () => (window.innerWidth < 760 ? 16 : 28);

  /** Readers to draw right now: all of them when they fit side by side at 1:1, otherwise one, picked with tabs. */
  function shownModels() {
    const models = selectedModels();
    const tabs = $('#device-tabs');
    if (models.length < 2) { tabs.hidden = true; return models; }
    const avail = $('#previews').clientWidth - 32;
    const total = models.reduce((a, k) => a + MODELS[k].W + BEZEL(), 0) + 24 * (models.length - 1);
    if (avail >= total) { tabs.hidden = true; return models; }
    if (!models.includes(state.focusModel)) state.focusModel = models[0];
    tabs.hidden = false;
    if (tabs.dataset.for !== models.join(',')) {
      tabs.dataset.for = models.join(',');
      tabs.textContent = '';
      for (const k of models) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'seg-btn'; b.dataset.focus = k;
        b.textContent = MODELS[k].name;
        b.addEventListener('click', () => { state.focusModel = k; schedulePreview(0); });
        tabs.appendChild(b);
      }
    }
    for (const b of $$('[data-focus]', tabs)) b.setAttribute('aria-pressed', String(b.dataset.focus === state.focusModel));
    return [state.focusModel];
  }

  function ensureDevices() {
    const wrap = $('#previews');
    const models = shownModels();
    for (const k of Object.keys(deviceEls)) {
      if (!models.includes(k)) { deviceEls[k].root.remove(); delete deviceEls[k]; }
    }
    $('.placeholder', wrap)?.remove();
    if (!models.length) {
      wrap.insertAdjacentHTML('beforeend', '<p class="placeholder">Choose at least one reader above to see a preview.</p>');
      return models;
    }
    for (const k of models) {
      if (deviceEls[k]) continue;
      const m = MODELS[k];
      const root = document.createElement('figure');
      root.className = 'device';
      root.style.margin = '0';
      root.innerHTML = `
        <div class="device-body"><canvas width="${m.W}" height="${m.H}" role="img" aria-label="${m.name} preview"></canvas></div>
        <figcaption class="device-cap"><b>${m.name}</b>, ${m.W} × ${m.H}<br><span class="desc">Waiting for a card</span></figcaption>
        <div class="device-actions"><button type="button" class="btn" data-save="${k}" disabled>Save this BMP</button></div>`;
      wrap.appendChild(root);
      deviceEls[k] = { root, canvas: $('canvas', root), desc: $('.desc', root), save: $('[data-save]', root) };
      deviceEls[k].save.addEventListener('click', () => saveSingle(k));
    }
    for (const k of models) wrap.appendChild(deviceEls[k].root);
    sizeDevices(models);
    return models;
  }

  function sizeDevices(models) {
    const avail = $('#previews').clientWidth - 32;
    for (const k of models) {
      const scale = Math.min(1, (avail - BEZEL()) / MODELS[k].W);
      const c = deviceEls[k].canvas;
      c.style.width = Math.floor(MODELS[k].W * scale) + 'px';
      c.style.height = Math.floor(MODELS[k].H * scale) + 'px';
      // pixel-exact at 1:1; smooth when shrinking so the dither pattern doesn't alias into stripes
      c.style.imageRendering = scale >= 1 ? 'pixelated' : 'auto';
    }
  }

  function paint(canvas, data, isGray, nLevels) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const t = nLevels === 2 ? [0, 255] : tones();
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const v = isGray ? data[i] : t[data[i]];
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function describe(pl, W, H, credited) {
    const cropX = Math.max(0, -pl.ox) + Math.max(0, pl.ox + pl.dw - W);
    const cropY = Math.max(0, -pl.oy) + Math.max(0, pl.oy + pl.dh - H);
    const barX = Math.max(0, pl.ox) + Math.max(0, W - (pl.ox + pl.dw));
    const barY = Math.max(0, pl.oy) + Math.max(0, H - (pl.oy + pl.dh));
    const bits = [`image ${pl.dw} × ${pl.dh} px`];
    if (cropX || cropY) bits.push(`${[cropX && cropX + ' px cropped across', cropY && cropY + ' px cropped down'].filter(Boolean).join(' and ')}`);
    if (barX || barY) bits.push(`${[barX && barX + ' px of side bars', barY && barY + ' px of top and bottom bars'].filter(Boolean).join(' and ')}`);
    if (credited) bits.push('credit line added');
    const s = bits.join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  let previewTimer = 0, previewToken = 0, previewAbort = null;
  function schedulePreview(delay = 80) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, delay);
  }

  async function updatePreview() {
    const models = ensureDevices();
    const token = ++previewToken;
    if (previewAbort) previewAbort.abort();
    previewAbort = new AbortController();
    const entry = activeEntry();
    for (const k of models) deviceEls[k].save.disabled = true;
    if (!entry) {
      for (const k of models) {
        const ctx = deviceEls[k].canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, MODELS[k].W, MODELS[k].H);
        deviceEls[k].desc.textContent = 'Load cards to preview';
      }
      return;
    }
    for (const k of models) deviceEls[k].desc.textContent = 'Rendering…';
    for (const k of models) {
      const m = MODELS[k];
      try {
        const out = await produce(entry, entry.face, m, previewAbort.signal);
        if (token !== previewToken) return;
        state.lastResults[k] = { indices: out.indices, nLevels: out.nLevels, entry, face: entry.face };
        if (state.view === 'gray') paint(deviceEls[k].canvas, out.gray, true);
        else paint(deviceEls[k].canvas, out.indices, false, out.nLevels);
        deviceEls[k].desc.textContent = describe(out.placement, m.W, m.H, out.credited);
        deviceEls[k].save.disabled = false;
      } catch (err) {
        if (token !== previewToken || err.name === 'AbortError') return;
        deviceEls[k].desc.textContent = friendlyImageError(err);
      }
    }
  }

  function friendlyImageError(err) {
    if (err && /Failed to fetch|NetworkError|Load failed/i.test(err.message)) {
      return 'The scan could not be downloaded. Check your connection, or that a content blocker isn’t blocking cards.scryfall.io.';
    }
    return (err && err.message) || 'Something went wrong rendering this card.';
  }

  function saveSingle(k) {
    const r = state.lastResults[k];
    if (!r) return;
    const m = MODELS[k];
    const bmp = SleepEncoders.encodeBMP(r.indices, m.W, m.H, r.nLevels, S.format);
    download(new Blob([bmp], { type: 'image/bmp' }), `${fileBase(r.entry, r.face)}-${k}.bmp`);
  }

  // ---------------------------------------------------------------- dither ramp in the masthead
  function drawRamp() {
    const c = $('#ramp');
    const scale = 2;
    const W = Math.max(8, Math.floor(c.clientWidth / scale));
    const H = 20;
    c.width = W; c.height = H;
    const buf = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = x / (W - 1);
    const mask = new Uint8Array(W * H).fill(1);
    const s = renderSettings();
    const P = s.shades === 2 ? [0, 1] : [0, s.mid1, s.mid2, 1];
    const idx = SleepPipeline.dither(buf, mask, W, H, P, 0, s);
    paint(c, idx, false, P.length);
  }

  // ---------------------------------------------------------------- card list
  function cardSubtitle(card) {
    return `${(card.set || '').toUpperCase()} #${card.collector_number}${card.set_name ? ', ' + card.set_name : ''}`;
  }

  function renderList() {
    const ul = $('#card-list');
    ul.textContent = '';
    const frag = document.createDocumentFragment();
    for (const e of state.cards) {
      const li = document.createElement('li');
      li.className = 'card-row';
      li.dataset.key = e.key;
      li.innerHTML = `
        <input type="checkbox" aria-label="Include in download">
        <button type="button" class="card-pick"><img alt="" loading="lazy" decoding="async"><span><span class="nm"></span><span class="st"></span></span></button>`;
      fillRow(li, e);
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    $('#cards-empty').hidden = state.cards.length > 0;
    updateCount();
    markActive();
  }

  function fillRow(li, e) {
    const f = faceOf(e);
    $('img', li).src = f.image_uris.small || f.image_uris.normal;
    $('.nm', li).textContent = e.card.name;
    $('.st', li).textContent = cardSubtitle(e.card);
    $('input', li).checked = e.include;
    li.classList.toggle('excluded', !e.include);
  }

  function updateCount() {
    const inc = state.cards.filter((c) => c.include).length;
    $('#card-count').textContent = state.cards.length ? `${inc} of ${state.cards.length} in the download` : '';
    updateExportLabel();
  }

  function markActive() {
    for (const li of $$('.card-row')) {
      const on = li.dataset.key === state.activeKey;
      li.classList.toggle('active', on);
      $('.card-pick', li).setAttribute('aria-current', on ? 'true' : 'false');
    }
  }

  function selectCard(key) {
    state.activeKey = key;
    markActive();
    renderMeta();
    loadPrintings();
    schedulePreview(0);
  }

  function renderMeta() {
    const e = activeEntry();
    const meta = $('#card-meta');
    const facesEl = $('#faces');
    if (!e) { meta.textContent = ''; facesEl.hidden = true; $('#printings-wrap').hidden = true; return; }
    const f = faceOf(e);
    meta.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = f.name;
    const a = document.createElement('a');
    a.href = e.card.scryfall_uri || '#';
    a.rel = 'noopener'; a.target = '_blank';
    a.textContent = 'View on Scryfall';
    meta.append(strong, `Illustrated by ${f.artist || 'unknown artist'}. ${cardSubtitle(e.card)}. `, a);

    const fs = faceList(e.card);
    facesEl.hidden = fs.length < 2;
    facesEl.textContent = '';
    if (fs.length > 1) {
      fs.forEach((ff, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'seg-btn';
        b.textContent = `${i === 0 ? 'Front' : 'Back'}: ${ff.name}`;
        b.setAttribute('aria-pressed', String(i === e.face));
        b.addEventListener('click', () => { e.face = i; renderMeta(); refreshRow(e); schedulePreview(0); });
        facesEl.appendChild(b);
      });
    }
  }

  function refreshRow(e) {
    const li = $(`.card-row[data-key="${CSS.escape(e.key)}"]`);
    if (li) fillRow(li, e);
  }

  // ---------------------------------------------------------------- printings
  let printTimer = 0;
  function loadPrintings() {
    clearTimeout(printTimer);
    const e = activeEntry();
    const wrap = $('#printings-wrap');
    if (!e) { wrap.hidden = true; return; }
    if (e.prints) { renderPrintings(e); return; }
    wrap.hidden = false;
    $('#printings').innerHTML = '<li class="note">Looking up other printings…</li>';
    printTimer = setTimeout(async () => {
      if (state.printAbort) state.printAbort.abort();
      state.printAbort = new AbortController();
      try {
        const list = await Scryfall.printings(e.card, { signal: state.printAbort.signal });
        e.prints = list;
        if (activeEntry() === e) renderPrintings(e);
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (activeEntry() === e) $('#printings').innerHTML = `<li class="note">Couldn’t load printings: ${escapeHtml(err.message)}</li>`;
      }
    }, 350);
  }

  function renderPrintings(e) {
    const wrap = $('#printings-wrap');
    const ul = $('#printings');
    const list = S.uniqueArt ? Scryfall.uniqueByArt(e.prints, e.card) : e.prints;
    wrap.hidden = false;
    ul.textContent = '';
    if (list.length <= 1) { ul.innerHTML = '<li class="note">This is the only printing with this art.</li>'; return; }
    for (const p of list) {
      const f = faceList(p)[Math.min(e.face, faceList(p).length - 1)];
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(p.id === e.card.id));
      b.title = `${p.set_name} #${p.collector_number}, ${f.artist || ''}`;
      const img = document.createElement('img');
      img.alt = ''; img.loading = 'lazy'; img.src = f.image_uris.small;
      const cap = document.createElement('span');
      cap.textContent = `${p.set.toUpperCase()} #${p.collector_number}`;
      b.append(img, cap);
      b.addEventListener('click', () => {
        e.card = p;
        e.face = Math.min(e.face, faceList(p).length - 1);
        refreshRow(e); renderMeta(); renderPrintings(e); schedulePreview(0);
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------------------------------------------------------------- loading cards
  async function loadCards(text) {
    const status = $('#load-status');
    let plan;
    try { plan = Scryfall.parseInput(text); } catch (err) { setStatus(status, err.message, true); return; }
    if (state.loadAbort) state.loadAbort.abort();
    state.loadAbort = new AbortController();
    const btn = $('#load-btn');
    btn.disabled = true;
    setStatus(status, 'Asking Scryfall…');
    try {
      const cards = await Scryfall.load(plan, {
        signal: state.loadAbort.signal,
        onProgress: (n, total) => setStatus(status, `Loaded ${n} of ${total} cards…`),
        onWait: (s) => setStatus(status, `Scryfall asked us to slow down. Retrying in ${s} seconds…`),
      });
      const usable = cards.filter((c) => faceList(c).length);
      const skipped = cards.length - usable.length;
      state.cards = usable.map((c, i) => ({ key: c.id + ':' + i, card: c, face: 0, include: true, prints: null }));
      state.lastResults = {};
      renderList();
      if (state.cards.length) selectCard(state.cards[0].key);
      else { state.activeKey = null; renderMeta(); schedulePreview(0); }
      let msg = `${usable.length} card${usable.length === 1 ? '' : 's'} from ${plan.label}.`;
      if (skipped) msg += ` ${skipped} without scans were skipped.`;
      if (cards.length >= 1500) msg += ' Stopped at 1,500 cards; narrow the search to get the rest.';
      setStatus(status, msg);
      try { localStorage.setItem(STORE_KEY + ':link', text); } catch (_) { /* ignore */ }
    } catch (err) {
      if (err.name === 'AbortError') return;
      const msg = err.status === 404 ? `No cards found. ${err.message}` : err.message;
      setStatus(status, msg, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- export
  function exportPlan() {
    const models = selectedModels().map((k) => MODELS[k]);
    const jobs = [];
    for (const e of state.cards) {
      if (!e.include) continue;
      const nf = faceList(e.card).length;
      const facesToDo = S.bothFaces && nf > 1 ? [...Array(nf).keys()] : [e.face];
      for (const f of facesToDo) jobs.push({ e, f });
    }
    return { models, jobs };
  }

  function updateExportLabel() {
    const { models, jobs } = exportPlan();
    const btn = $('#export-btn');
    const n = jobs.length * models.length;
    btn.textContent = n ? `Download ZIP (${n} screen${n === 1 ? '' : 's'})` : 'Download ZIP';
    btn.disabled = !n || !!state.exportAbort;
  }

  async function exportZip() {
    const status = $('#export-status');
    const { models, jobs } = exportPlan();
    if (!models.length) { setStatus(status, 'Choose at least one reader at the top.', true); return; }
    if (!jobs.length) { setStatus(status, 'Include at least one card in the list.', true); return; }
    state.exportAbort = new AbortController();
    const signal = state.exportAbort.signal;
    const prog = $('#export-progress');
    prog.hidden = false;
    $('#cancel-btn').hidden = false;
    updateExportLabel();
    const zip = SleepEncoders.ZipWriter();
    const used = new Set();
    const multi = models.length > 1;
    const total = jobs.length * models.length;
    let done = 0, failed = 0;
    try {
      for (let j = 0; j < jobs.length; j++) {
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        // warm the next few downloads while this one renders
        for (let k = 1; k <= 3 && j + k < jobs.length; k++) Renderer.prefetch(imageUrl(faceOf(jobs[j + k].e, jobs[j + k].f)));
        const { e, f } = jobs[j];
        let base = fileBase(e, f);
        let name = base, n = 2;
        while (used.has(name)) name = `${base}-${n++}`;
        used.add(name);
        for (const m of models) {
          try {
            const out = await produce(e, f, m, signal);
            const bmp = SleepEncoders.encodeBMP(out.indices, m.W, m.H, out.nLevels, S.format);
            zip.add(`${multi ? m.folder + '/' : ''}${S.folder}/${name}.bmp`, bmp);
          } catch (err) {
            if (err.name === 'AbortError') throw err;
            failed++;
          }
          done++;
          prog.firstElementChild.style.width = `${(done / total) * 100}%`;
          setStatus(status, `Rendering ${done} of ${total}: ${e.card.name}`);
        }
      }
      if (!zip.count) { setStatus(status, 'Nothing rendered. Check your connection and try again.', true); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      download(zip.toBlob(), `sleep-sleeve-${stamp}.zip`);
      const where = multi ? `X3/${S.folder} and X4/${S.folder}` : S.folder;
      setStatus(status, `Saved ${zip.count} screens. Copy the ${S.folder} folder from ${where} to the root of the SD card.${failed ? ` ${failed} could not be rendered.` : ''}`);
    } catch (err) {
      if (err.name === 'AbortError') setStatus(status, `Stopped after ${done} of ${total}. Nothing was downloaded.`);
      else setStatus(status, err.message, true);
    } finally {
      state.exportAbort = null;
      prog.hidden = true;
      prog.firstElementChild.style.width = '0';
      $('#cancel-btn').hidden = true;
      updateExportLabel();
    }
  }

  // ---------------------------------------------------------------- settings UI
  const SOURCE_HINTS = {
    png: 'Scryfall’s largest scan, 745 × 1040 with rounded corners. Corners take the background shade.',
    border_crop: 'Scan without the black border, 480 × 680. That is exactly the X4’s width, so 1 : 1 pixels needs no resampling there.',
    art_crop: 'Just the illustration. Size varies by card. A credit line with the artist’s name is added automatically.',
  };
  const FIT_HINTS = {
    contain: 'The whole image is visible; leftover space shows the background.',
    cover: 'The screen is filled edge to edge; whatever overhangs is cropped. Use the position sliders to choose what stays.',
    width: 'Matches the screen width. Tall images are cropped top and bottom, short ones get bars.',
    height: 'Matches the screen height. Wide images are cropped at the sides.',
    stretch: 'Distorts the image to match the screen exactly.',
    integer: 'Scales by a whole number (2×, 3×) or a whole fraction (½, ⅓) so every source pixel maps evenly.',
    native: 'One scan pixel per screen pixel, no resampling.',
  };

  function syncUI() {
    for (const b of $$('[data-set][data-value]')) {
      const k = b.dataset.set;
      b.setAttribute('aria-pressed', String(String(S[k]) === b.dataset.value));
    }
    for (const el of $$('input[type=range][data-set]')) {
      const k = el.dataset.set;
      el.value = S[k];
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = formatValue(k, S[k]);
    }
    for (const el of $$('input[type=checkbox][data-set]')) el.checked = !!S[el.dataset.set];
    for (const el of $$('select[data-set]')) el.value = S[el.dataset.set];
    for (const b of $$('#device-toggles .toggle')) b.setAttribute('aria-pressed', String(S.models.includes(b.dataset.model)));
    $('#unique-art').checked = !!S.uniqueArt;
    $('#source-hint').textContent = SOURCE_HINTS[S.source] || '';
    $('#fit-hint').textContent = FIT_HINTS[S.fit] || '';

    const fixedScale = S.fit === 'native' || S.fit === 'integer';
    disableRange('zoom', fixedScale);
    disableRange('alignX', S.fit === 'stretch');
    disableRange('alignY', S.fit === 'stretch');
    disableRange('diffusion', S.dither === 'none');
    const serp = $('input[data-set=serpentine]');
    serp.disabled = S.dither === 'bayer' || S.dither === 'none';
    serp.closest('.check').style.opacity = serp.disabled ? 0.4 : 1;
    $('#resample').disabled = fixedScale;
    const two = S.shades === 2 || S.format === 'bmp1';
    for (const k of ['mid1', 'mid2']) disableRange(k, two);
    updateExportLabel();
  }

  function disableRange(k, off) {
    const label = $(`.range[data-for="${k}"]`);
    if (!label) return;
    label.classList.toggle('disabled', off);
    $('input', label).disabled = off;
  }

  function formatValue(k, v) {
    switch (k) {
      case 'zoom': return `${Math.round(v)} %`;
      case 'alignX': return v < 0.02 ? 'Left' : v > 0.98 ? 'Right' : `${Math.round(v * 100)} %`;
      case 'alignY': return v < 0.02 ? 'Top' : v > 0.98 ? 'Bottom' : `${Math.round(v * 100)} %`;
      case 'gamma': return v.toFixed(2);
      case 'mid1': case 'mid2': return String(Math.round(v * 255));
      case 'diffusion': case 'sharpen': return `${Math.round(v)} %`;
      default: return (v > 0 ? '+' : '') + Math.round(v);
    }
  }

  function setSetting(k, v) {
    S[k] = v;
    // keep file type and shade count consistent
    if (k === 'format' && v === 'bmp1') S.shades = 2;
    if (k === 'shades' && v === 4 && S.format === 'bmp1') S.format = 'bmp4';
    saveSettings();
    syncUI();
    if (['shades', 'dither', 'diffusion', 'serpentine', 'mid1', 'mid2', 'ditherLinear', 'format'].includes(k)) drawRamp();
    if (k === 'folder' || k === 'bothFaces') return;
    schedulePreview(k === 'zoom' || k.startsWith('align') || k === 'mid1' || k === 'mid2' ? 60 : 0);
  }

  function bindControls() {
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-set][data-value]');
      if (!b) return;
      const k = b.dataset.set;
      const v = NUMERIC.has(k) ? Number(b.dataset.value) : b.dataset.value;
      setSetting(k, v);
    });
    for (const el of $$('input[type=range][data-set]')) {
      el.addEventListener('input', () => setSetting(el.dataset.set, parseFloat(el.value)));
    }
    for (const el of $$('input[type=checkbox][data-set]')) {
      el.addEventListener('change', () => setSetting(el.dataset.set, el.checked));
    }
    for (const el of $$('select[data-set]')) {
      el.addEventListener('change', () => setSetting(el.dataset.set, el.value));
    }
    $('#reset-cal').addEventListener('click', () => {
      S.mid1 = DEFAULTS.mid1; S.mid2 = DEFAULTS.mid2; S.ditherLinear = false;
      saveSettings(); syncUI(); drawRamp(); schedulePreview(0);
    });
    $('#unique-art').addEventListener('change', (ev) => {
      S.uniqueArt = ev.target.checked; saveSettings();
      const e = activeEntry();
      if (e && e.prints) renderPrintings(e);
    });

    for (const b of $$('#device-toggles .toggle')) {
      b.addEventListener('click', () => {
        const k = b.dataset.model;
        const set = new Set(S.models);
        set.has(k) ? set.delete(k) : set.add(k);
        S.models = Object.keys(MODELS).filter((m) => set.has(m));
        saveSettings(); syncUI(); schedulePreview(0);
      });
    }

    for (const b of $$('[data-view]')) {
      b.addEventListener('click', () => {
        state.view = b.dataset.view;
        for (const o of $$('[data-view]')) o.setAttribute('aria-pressed', String(o === b));
        schedulePreview(0);
      });
    }

    $('#load-form').addEventListener('submit', (ev) => { ev.preventDefault(); loadCards($('#link').value); });
    for (const b of $$('[data-example]')) {
      b.addEventListener('click', () => { $('#link').value = b.dataset.example; loadCards(b.dataset.example); });
    }

    $('#card-list').addEventListener('click', (ev) => {
      const li = ev.target.closest('.card-row');
      if (!li) return;
      if (ev.target.matches('input[type=checkbox]')) return;
      selectCard(li.dataset.key);
    });
    $('#card-list').addEventListener('change', (ev) => {
      if (!ev.target.matches('input[type=checkbox]')) return;
      const li = ev.target.closest('.card-row');
      const e = state.cards.find((c) => c.key === li.dataset.key);
      e.include = ev.target.checked;
      li.classList.toggle('excluded', !e.include);
      updateCount();
    });
    $('#card-list').addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const i = state.cards.findIndex((c) => c.key === state.activeKey);
      const j = Math.max(0, Math.min(state.cards.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
      if (j === i) return;
      ev.preventDefault();
      selectCard(state.cards[j].key);
      $(`.card-row[data-key="${CSS.escape(state.cards[j].key)}"] .card-pick`)?.focus();
    });
    $('#select-all').addEventListener('click', () => { state.cards.forEach((c) => (c.include = true)); renderList(); });
    $('#select-none').addEventListener('click', () => { state.cards.forEach((c) => (c.include = false)); renderList(); });

    $('#export-btn').addEventListener('click', exportZip);
    $('#cancel-btn').addEventListener('click', () => state.exportAbort && state.exportAbort.abort());

    let rt = 0, lastW = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === lastW) return; // ignore mobile toolbar height changes
      lastW = window.innerWidth;
      clearTimeout(rt);
      rt = setTimeout(() => { drawRamp(); schedulePreview(0); }, 150);
    });
  }

  // ---------------------------------------------------------------- start
  function init() {
    bindControls();
    syncUI();
    ensureDevices();
    drawRamp();
    renderList();
    schedulePreview(0);
    // the credit line is drawn with the page font, so wait for it before the first real render
    if (document.fonts && document.fonts.load) document.fonts.load('600 12px "Atkinson Hyperlegible Next"').catch(() => {});

    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('link');
    let last = null;
    try { last = localStorage.getItem(STORE_KEY + ':link'); } catch (_) { /* ignore */ }
    if (fromUrl) { $('#link').value = fromUrl; loadCards(fromUrl); }
    else if (last) $('#link').value = last;
  }

  init();
})();
