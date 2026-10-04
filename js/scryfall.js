/* Scryfall link parsing + polite API client. Global: Scryfall */
(function (global) {
  'use strict';

  const API = 'https://api.scryfall.com';
  // Scryfall's published limits: /cards/search, /cards/named, /cards/random, /cards/collection
  // are 2 req/s; everything else 10 req/s. *.scryfall.io image hosts are not rate limited.
  const SLOW = /\/cards\/(search|named|random|collection)\b/;
  let nextSlot = { slow: 0, fast: 0 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function apiGet(url, { signal, onWait } = {}) {
    const lane = SLOW.test(url) ? 'slow' : 'fast';
    const gap = lane === 'slow' ? 550 : 110;
    const now = performance.now();
    const at = Math.max(now, nextSlot[lane]);
    nextSlot[lane] = at + gap;
    if (at > now) await sleep(at - now);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
      if (res.status === 429) {
        // Scryfall limits a client for 30 s after a 429. Back off rather than hammering.
        onWait && onWait(30);
        await sleep(30000);
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (body && (body.details || body.warnings?.join(' '))) || `Scryfall returned HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return body;
    }
    throw new Error('Scryfall is rate limiting this browser. Wait a minute and try again.');
  }

  /**
   * Turn whatever the user pasted into an API request plan.
   * Returns { kind: 'card'|'search', url, label }.
   */
  function parseInput(raw) {
    const text = (raw || '').trim();
    if (!text) throw new Error('Paste a Scryfall card, set or search link, or type a Scryfall search.');

    let u = null;
    if (/^https?:\/\//i.test(text) || /^(www\.)?scryfall\.com\//i.test(text) || /^api\.scryfall\.com\//i.test(text)) {
      try { u = new URL(/^https?:/i.test(text) ? text : 'https://' + text); } catch (_) { u = null; }
    }

    if (!u) {
      // Plain Scryfall search syntax, e.g. "t:dragon r:mythic"
      return searchPlan({ q: text });
    }

    const host = u.hostname.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (host === 'api.scryfall.com') {
      return { kind: parts[0] === 'cards' && parts[1] !== 'search' ? 'card' : 'search', url: u.toString(), label: 'API request' };
    }
    if (host !== 'scryfall.com') throw new Error('That link is not on scryfall.com. Paste a Scryfall card, set or search link.');

    // /card/{set}/{collector}/{slug}  or  /card/{set}/{collector}/{lang}/{slug}
    if (parts[0] === 'card' && parts.length >= 3) {
      const set = parts[1], num = parts[2];
      const maybeLang = parts[3];
      const langCodes = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht', 'he', 'la', 'grc', 'ar', 'sa', 'ph', 'qya'];
      let url = `${API}/cards/${encodeURIComponent(set)}/${encodeURIComponent(num)}`;
      if (maybeLang && parts.length >= 5 && langCodes.includes(maybeLang)) url += `/${maybeLang}`;
      return { kind: 'card', url, label: `${set.toUpperCase()} #${num}` };
    }

    // /sets/{code}
    if (parts[0] === 'sets' && parts[1]) {
      const code = parts[1];
      const p = { q: `e:${code}`, unique: 'prints', order: u.searchParams.get('order') || 'set', dir: u.searchParams.get('dir') || 'asc', include_extras: 'true' };
      return searchPlan(p, `Set ${code.toUpperCase()}`);
    }

    // /search?q=...
    if (parts[0] === 'search') {
      const q = u.searchParams.get('q');
      if (!q) throw new Error('That search link has no query. Run the search on Scryfall, then copy the address bar.');
      const p = { q };
      for (const k of ['unique', 'order', 'dir', 'include_extras', 'include_multilingual', 'include_variations']) {
        const v = u.searchParams.get(k);
        if (v) p[k] = v;
      }
      return searchPlan(p);
    }

    throw new Error('Use a link to a card (/card/…), a set (/sets/…) or a search (/search?q=…).');
  }

  function searchPlan(params, label) {
    const sp = new URLSearchParams(params);
    return { kind: 'search', url: `${API}/cards/search?${sp}`, label: label || `Search: ${params.q}` };
  }

  /** Resolve a plan into an array of card objects. onProgress(loaded, total). */
  async function load(plan, { signal, onProgress, onWait, limit = 1500 } = {}) {
    if (plan.kind === 'card') {
      const c = await apiGet(plan.url, { signal, onWait });
      if (c.object === 'list') return c.data;
      return [c];
    }
    const cards = [];
    let url = plan.url;
    let total = null;
    while (url) {
      const page = await apiGet(url, { signal, onWait });
      if (total == null) total = page.total_cards;
      cards.push(...page.data);
      onProgress && onProgress(cards.length, total);
      if (cards.length >= limit) break;
      url = page.has_more ? page.next_page : null;
    }
    return cards.slice(0, limit);
  }

  /** All printings of a card that have images, oldest first. */
  async function printings(card, { signal } = {}) {
    const base = card.prints_search_uri;
    if (!base) return [card];
    const u = new URL(base);
    u.searchParams.set('order', 'released');
    u.searchParams.set('dir', 'asc');
    u.searchParams.set('include_extras', 'true');
    u.searchParams.set('include_variations', 'true');
    const all = [];
    let url = u.toString();
    while (url) {
      const page = await apiGet(url, { signal });
      all.push(...page.data);
      url = page.has_more ? page.next_page : null;
    }
    return all.filter((c) => faces(c).length);
  }

  /** Keep the first printing of each distinct artwork (by illustration id). */
  function uniqueByArt(list, keep) {
    const keyOf = (c) => faces(c).map((f) => f.illustration_id || f.image_uris.png).join('|');
    const keepKey = keep ? keyOf(keep) : null;
    const seen = new Set();
    return list.filter((c) => {
      if (keep && c.id === keep.id) return true;
      const k = keyOf(c);
      if (k === keepKey || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Faces that carry their own images. Single-image layouts return one pseudo-face. */
  function faces(card) {
    if (card.image_uris) {
      return [{ name: card.name, artist: card.artist, illustration_id: card.illustration_id, image_uris: card.image_uris }];
    }
    if (Array.isArray(card.card_faces)) {
      return card.card_faces
        .filter((f) => f.image_uris)
        .map((f) => ({ name: f.name, artist: f.artist || card.artist, illustration_id: f.illustration_id, image_uris: f.image_uris }));
    }
    return [];
  }

  global.Scryfall = { parseInput, load, printings, uniqueByArt, faces, apiGet };
})(typeof self !== 'undefined' ? self : this);
