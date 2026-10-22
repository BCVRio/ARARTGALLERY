/*
 * Art catalogue: thousands of public-domain works shipped with the app as
 * catalog/met.json (built by tools/build-catalog.py from The Met's Open
 * Access API), searched instantly on the device, plus an optional gallery
 * feed (catalog/galleries.json) of pieces that are actually for sale.
 *
 * Every piece becomes the app's artwork shape:
 *   { id, title, artist, date, year, medium, imageUrl, thumbnailUrl, source,
 *     museumUrl?, buyUrl?, price?, gallery?, printUrl?, widthCm?, heightCm?,
 *     tags, highlight }
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

    function norm(s) {
        return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function toArt(e, cat) {
        const art = {
            id: 'met-' + e.i,
            title: e.t,
            artist: e.a,
            artistBio: e.b || '',
            culture: e.c || '',
            date: e.d || '',
            year: e.y || null,
            medium: e.m || '',
            kind: e.k,
            imageUrl: cat.imgPrefix + e.img,
            thumbnailUrl: cat.imgPrefix + e.img,
            source: 'The Met',
            museumUrl: cat.pageUrl.replace('{id}', e.i),
            tags: e.g || [],
            highlight: !!e.hl
        };
        if (e.w && e.h) { art.widthCm = e.w; art.heightCm = e.h; }
        art.printUrl = printUrl(art);
        return art;
    }

    // The museum's image path starts with its department code; walls suit
    // easel paintings best, so European and American pictures lead a browse
    const DEPT_RANK = { ep: 0, rl: 1, ad: 2, ap: 2, ma: 3, md: 4, cl: 4, is: 5, as: 6, ph: 7 };
    function deptRank(e) {
        const code = (e.img || '').slice(0, 2);
        return code in DEPT_RANK ? DEPT_RANK[code] : 8;
    }

    function buildIndex(cat) {
        cat.items.forEach((e) => {
            e._hay = norm([e.t, e.a, e.b, e.c, e.m, e.d, (e.g || []).join(' ')].join(' '));
            e._title = norm(e.t);
            e._artist = norm(e.a);
            e._rank = deptRank(e);
        });
        const tagCounts = new Map();
        cat.items.forEach((e) => (e.g || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
        cat.topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    }

    function load() {
        if (state.catalog) return Promise.resolve(state.catalog);
        if (!state.loading) {
            state.loading = fetch(state.base + 'catalog/met.json', { cache: 'force-cache' })
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
            if (opts.kind && e.k !== opts.kind) continue;
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

    const api = { load, search, count, topTags, forSale, loadGalleries, hangWidthM, printUrl,
        setBase(b) { state.base = b; } };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.ArtCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
