/*
 * Art catalogue: thousands of public-domain paintings shipped with the app
 * as catalog/paintings.json (built by tools/build-catalog-museums.py from
 * museums' open data), searched instantly on the device, plus an optional
 * gallery feed (catalog/galleries.json) of pieces for sale.
 *
 * Images are hotlinked from the museums' own image servers (and Wikimedia
 * Commons), chosen because they allow cross-origin use, which AR textures
 * require; the catalogue stores only ids and the URLs are built here.
 *
 * Every piece becomes the app's artwork shape:
 *   { id, title, artist, date, year, medium, imageUrl, thumbnailUrl,
 *     imageFallbacks, source, museumUrl?, wikiUrl?, buyUrl?, price?,
 *     gallery?, printUrl?, widthCm?, heightCm?, tags, highlight }
 */
(function (global) {
    'use strict';

    const state = { catalog: null, loading: null, galleries: null, galleriesLoading: null, base: '' };

    // Where to send people who want a print of a public-domain piece; the
    // {q} placeholder receives "title artist" URL-encoded
    const PRINT_SEARCH = 'https://www.google.com/search?tbm=shop&q={q}';

    function printUrl(art) {
        const q = encodeURIComponent(`${art.title} ${art.artist} art print`.replace(/\s+/g, ' ').trim());
        return PRINT_SEARCH.replace('{q}', q);
    }

    // Commons shards files by the MD5 of their name: /a/ab/File.jpg
    function md5(str) {
        const bytes = new TextEncoder().encode(str);
        const K = new Uint32Array(64);
        for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
        const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
            4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
        const len = bytes.length;
        const padded = new Uint8Array(((len + 8 >> 6) + 1) << 6);
        padded.set(bytes);
        padded[len] = 0x80;
        const bits = len * 8;
        const dv = new DataView(padded.buffer);
        dv.setUint32(padded.length - 8, bits >>> 0, true);
        dv.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true);
        let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
        const M = new Uint32Array(16);
        for (let off = 0; off < padded.length; off += 64) {
            for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
            let A = a0, B = b0, C = c0, D = d0;
            for (let i = 0; i < 64; i++) {
                let F, g;
                if (i < 16) { F = (B & C) | (~B & D); g = i; }
                else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
                else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
                else { F = C ^ (B | ~D); g = (7 * i) % 16; }
                F = (F + A + K[i] + M[g]) >>> 0;
                A = D; D = C; C = B;
                B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
            }
            a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
        }
        const hex = (n) => [0, 8, 16, 24].map((sh) => ((n >>> sh) & 255).toString(16).padStart(2, '0')).join('');
        return hex(a0) + hex(b0) + hex(c0) + hex(d0);
    }

    function commonsUrls(base, file) {
        const h = md5(file);
        const enc = encodeURIComponent(file);
        const thumb = (w) => `${base}thumb/${h[0]}/${h.slice(0, 2)}/${enc}/${w}px-${enc}`;
        return { image: thumb(1000), thumbnail: thumb(320), fallbacks: [thumb(640), `${base}${h[0]}/${h.slice(0, 2)}/${enc}`] };
    }

    function norm(s) {
        return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    }

    // Museum entries name their source (e.s) and image id (e.u); the file
    // header carries each source's URL templates. Commons entries carry the
    // file name (e.f) instead and their URLs are derived from its MD5.
    const fill = (tpl, e) => tpl.replace('{u}', encodeURIComponent(e.u)).replace('{i}', encodeURIComponent(e.i));

    function toArt(e, cat) {
        const src = e.s && cat.sources && cat.sources[e.s];
        const art = {
            id: (src ? e.s : 'wd') + '-' + e.i,
            title: e.t,
            artist: e.a,
            artistBio: e.b || '',
            culture: e.c || '',
            date: e.d || '',
            year: e.y || null,
            medium: e.m || '',
            kind: e.k || 'painting',
            tags: e.g || [],
            highlight: !!e.hl
        };
        if (src) {
            art.imageUrl = fill(src.image, e);
            art.thumbnailUrl = fill(src.thumb, e);
            art.imageFallbacks = (src.fallbacks || []).map((t) => fill(t, e));
            art.source = src.name;
            art.museumUrl = fill(src.page, e);
        } else {
            const u = commonsUrls(cat.imgBase, e.f);
            art.imageUrl = u.image;
            art.thumbnailUrl = u.thumbnail;
            art.imageFallbacks = u.fallbacks;
            art.source = e.c || 'Wikimedia Commons';
            art.museumUrl = cat.filePage.replace('{file}', encodeURIComponent(e.f));
            art.commonsPage = true;
        }
        if (e.p && cat.wikiUrl) art.wikiUrl = cat.wikiUrl.replace('{title}', encodeURIComponent(e.p.replace(/ /g, '_')));
        if (e.w && e.h) { art.widthCm = e.w; art.heightCm = e.h; }
        art.printUrl = printUrl(art);
        return art;
    }

    // Browse order: how widely a work is written about (Wikipedia sitelinks)
    // ranks famous pieces first
    function rankOf(e) {
        return -Math.min(60, e.l || 0) / 10;
    }

    function buildIndex(cat) {
        cat.items.forEach((e) => {
            e._hay = norm([e.t, e.a, e.b, e.c, e.m, e.d, (e.g || []).join(' ')].join(' '));
            e._title = norm(e.t);
            e._artist = norm(e.a);
            e._rank = rankOf(e);
        });
        const tagCounts = new Map();
        cat.items.forEach((e) => (e.g || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
        cat.topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    }

    function load() {
        if (state.catalog) return Promise.resolve(state.catalog);
        if (!state.loading) {
            state.loading = fetch(state.base + 'catalog/paintings.json', { cache: 'force-cache' })
                .then((r) => { if (!r.ok) throw new Error('catalog ' + r.status); return r.json(); })
                .then((cat) => { buildIndex(cat); state.catalog = cat; return cat; })
                .catch((err) => { state.loading = null; throw err; });
        }
        return state.loading;
    }

    /*
     * opts.kind: 'painting' | 'photo' | undefined (all)
     * opts.tag: a subject tag to require — opts.limit: max results (default 400)
     * An empty query browses: highlights first.
     */
    async function search(query, opts) {
        opts = opts || {};
        const cat = await load();
        const tokens = norm(query).split(' ').filter(Boolean);
        const tag = opts.tag ? String(opts.tag).toLowerCase() : null;
        const limit = opts.limit || 400;
        const scored = [];
        for (const e of cat.items) {
            if (opts.kind && (e.k || 'painting') !== opts.kind) continue;
            if (tag && !(e.g || []).some((t) => t.toLowerCase() === tag)) continue;
            let score = e.hl ? 2 : 0;
            let ok = true;
            for (const tk of tokens) {
                if (e._title.includes(tk)) score += 6;
                else if (e._artist.includes(tk)) score += 5;
                else if (e._hay.includes(tk)) score += 1;
                else { ok = false; break; }
            }
            if (!ok) continue;
            if (e.w && e.h) score += 0.5; // real dimensions hang truer
            score -= e._rank * 0.1;       // department order breaks ties
            scored.push([score, e]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        return { total: scored.length, items: scored.slice(0, limit).map(([, e]) => toArt(e, cat)) };
    }

    async function count() {
        const cat = await load();
        return cat.count || cat.items.length;
    }

    async function topTags() {
        const cat = await load();
        return cat.topTags;
    }

    // Gallery feed: pieces for sale, listed by galleries in catalog/galleries.json
    function loadGalleries() {
        if (state.galleries) return Promise.resolve(state.galleries);
        if (!state.galleriesLoading) {
            state.galleriesLoading = fetch(state.base + 'catalog/galleries.json', { cache: 'no-cache' })
                .then((r) => (r.ok ? r.json() : { galleries: [] }))
                .then((feed) => {
                    const items = [];
                    (feed.galleries || []).forEach((g) => {
                        (g.items || []).forEach((p, i) => {
                            if (!p.imageUrl || !p.title) return;
                            items.push({
                                id: 'gallery-' + (p.id || (norm(g.name) + '-' + i)),
                                title: p.title,
                                artist: p.artist || g.name,
                                date: p.year ? String(p.year) : '',
                                year: p.year || null,
                                medium: p.medium || '',
                                kind: 'forsale',
                                imageUrl: p.imageUrl,
                                thumbnailUrl: p.thumbnailUrl || p.imageUrl,
                                source: g.name,
                                gallery: g.name,
                                galleryUrl: g.url || '',
                                buyUrl: p.buyUrl || g.url || '',
                                price: p.price != null ? formatPrice(p.price, p.currency || g.currency) : '',
                                widthCm: p.widthCm, heightCm: p.heightCm,
                                tags: p.tags || [],
                                highlight: false
                            });
                        });
                    });
                    state.galleries = { count: items.length, items, galleryCount: (feed.galleries || []).length };
                    return state.galleries;
                })
                .catch(() => { state.galleries = { count: 0, items: [], galleryCount: 0 }; return state.galleries; });
        }
        return state.galleriesLoading;
    }

    function formatPrice(n, currency) {
        try {
            return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP', maximumFractionDigits: 0 }).format(n);
        } catch (e) {
            return (currency || '£') + ' ' + n;
        }
    }

    async function forSale(query) {
        const feed = await loadGalleries();
        const tokens = norm(query).split(' ').filter(Boolean);
        const items = feed.items.filter((a) => {
            const hay = norm([a.title, a.artist, a.gallery, a.medium, a.tags.join(' ')].join(' '));
            return tokens.every((t) => hay.includes(t));
        });
        return { total: items.length, items, galleryCount: feed.galleryCount };
    }

    // The real-world width to hang a piece at, in metres, from its catalogued
    // dimensions, within a range that still reads on a phone screen
    function hangWidthM(art, fallback) {
        if (art && art.widthCm) return Math.min(2.2, Math.max(0.35, art.widthCm / 100));
        return fallback;
    }

    const api = { load, search, count, topTags, forSale, loadGalleries, hangWidthM, printUrl, commonsUrls, md5,
        setBase(b) { state.base = b; } };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.ArtCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
