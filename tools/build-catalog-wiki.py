#!/usr/bin/env python3
"""
Builds catalog/paintings.json from English Wikipedia's painting articles and
their Wikidata items — the same output as build-catalog-commons.py, using the
Wikipedia and Wikidata action APIs (which are not throttled like the query
service). Images are Wikimedia Commons files, the one image host that
reliably allows cross-origin use (needed for AR textures).

Usage: python3 -I tools/build-catalog-wiki.py [--max-pages 12000] [--out catalog/paintings.json]
"""
import json, sys, time, re, argparse
import urllib.request, urllib.parse, urllib.error

WIKI = "https://en.wikipedia.org/w/api.php"
WD = "https://www.wikidata.org/w/api.php"
UA = {"User-Agent": "ARArtGallery-catalog-builder/1.0 (scott@bamsound.com)"}
ROOT_CATEGORY = "Category:Paintings by artist"
MAX_YEAR = 1925
PAINTING = "Q3305213"
UNIT_TO_CM = {"Q174728": 1.0, "Q174789": 0.1, "Q11573": 100.0, "Q218593": 2.54, "Q3710": 30.48}
last_request = [0.0]


def get(url, params, tries=6):
    url = url + "?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(tries):
        gap = 0.25 - (time.time() - last_request[0])
        if gap > 0:
            time.sleep(gap)
        last_request[0] = time.time()
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            retry = e.headers.get("Retry-After")
            wait = min(600, int(retry)) if retry and retry.isdigit() else 10 * (attempt + 1)
            print("  HTTP %d — waiting %ds" % (e.code, wait), flush=True)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print("  network error %s — waiting 15s" % e, flush=True)
            time.sleep(15)
    return None


def category_members(title, cmtype):
    out, cont = [], {}
    while True:
        d = get(WIKI, {"action": "query", "list": "categorymembers", "cmtitle": title, "cmtype": cmtype,
                       "cmlimit": "500", "cmnamespace": "14" if cmtype == "subcat" else "0", **cont})
        if not d:
            break
        out.extend(m["title"] for m in d.get("query", {}).get("categorymembers", []))
        cont = d.get("continue") or {}
        if not cont:
            break
    return out


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def wikibase_ids(titles):
    ids = {}
    for batch in chunks(titles, 50):
        d = get(WIKI, {"action": "query", "prop": "pageprops", "ppprop": "wikibase_item", "titles": "|".join(batch), "redirects": "1"})
        for p in (d or {}).get("query", {}).get("pages", {}).values():
            q = (p.get("pageprops") or {}).get("wikibase_item")
            if q:
                ids[q] = p.get("title")
    return ids


def entities(qids, props):
    out = {}
    for batch in chunks(qids, 50):
        d = get(WD, {"action": "wbgetentities", "ids": "|".join(batch), "props": props, "languages": "en"})
        out.update((d or {}).get("entities", {}))
    return out


def claim_value(ent, prop):
    for c in ent.get("claims", {}).get(prop, []):
        v = c.get("mainsnak", {}).get("datavalue", {}).get("value")
        if v is not None:
            return v
    return None


def claim_values(ent, prop):
    vals = []
    for c in ent.get("claims", {}).get(prop, []):
        v = c.get("mainsnak", {}).get("datavalue", {}).get("value")
        if v is not None:
            vals.append(v)
    return vals


def qid_of(v):
    return v.get("id") if isinstance(v, dict) else None


def cm(v):
    if not isinstance(v, dict):
        return None
    try:
        amount = float(v.get("amount"))
    except (TypeError, ValueError):
        return None
    f = UNIT_TO_CM.get((v.get("unit") or "").rsplit("/", 1)[-1])
    if f is None:
        return None
    amount *= f
    return round(amount, 1) if 2 < amount < 1200 else None


def year_of(v):
    if not isinstance(v, dict):
        return None
    m = re.match(r"([+-]\d+)-", v.get("time", ""))
    return int(m.group(1)) if m else None


def clean(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="catalog/paintings.json")
    ap.add_argument("--max-pages", type=int, default=12000)
    args = ap.parse_args()
    t0 = time.time()

    artist_cats = category_members(ROOT_CATEGORY, "subcat")
    print("artist categories:", len(artist_cats), flush=True)
    pages = []
    seen = set()
    for i, cat in enumerate(artist_cats):
        for t in category_members(cat, "page"):
            if t not in seen and not t.startswith("List of"):
                seen.add(t)
                pages.append(t)
        if (i + 1) % 100 == 0:
            print("  %d categories scanned, %d articles, %.0fs" % (i + 1, len(pages), time.time() - t0), flush=True)
        if len(pages) >= args.max_pages:
            break
    pages = pages[: args.max_pages]
    print("painting articles:", len(pages), flush=True)

    ids = wikibase_ids(pages)
    print("wikidata items:", len(ids), "%.0fs" % (time.time() - t0), flush=True)

    ents = entities(list(ids.keys()), "claims|labels|sitelinks")
    print("entities fetched:", len(ents), "%.0fs" % (time.time() - t0), flush=True)

    # Labels for creators, collections and genres/movements, in batches
    ref_ids = set()
    for ent in ents.values():
        for prop in ("P170", "P195", "P136", "P135"):
            for v in claim_values(ent, prop):
                q = qid_of(v)
                if q:
                    ref_ids.add(q)
    labels = {}
    for batch in chunks(sorted(ref_ids), 50):
        d = get(WD, {"action": "wbgetentities", "ids": "|".join(batch), "props": "labels", "languages": "en"})
        for q, ent in (d or {}).get("entities", {}).items():
            labels[q] = ent.get("labels", {}).get("en", {}).get("value")
    print("reference labels:", len(labels), "%.0fs" % (time.time() - t0), flush=True)

    items = []
    for q, ent in ents.items():
        if not any(qid_of(v) == PAINTING for v in claim_values(ent, "P31")):
            continue
        img = claim_value(ent, "P18")
        if not isinstance(img, str) or not re.search(r"\.(jpe?g|png)$", img, re.I):
            continue
        year = year_of(claim_value(ent, "P571"))
        if year is not None and year > MAX_YEAR:
            continue
        if year is None:
            continue
        title = clean(ent.get("labels", {}).get("en", {}).get("value")) or clean(ids.get(q))
        if not title:
            continue
        creators = [labels.get(qid_of(v)) for v in claim_values(ent, "P170")]
        creators = [c for c in creators if c]
        colls = [labels.get(qid_of(v)) for v in claim_values(ent, "P195")]
        colls = [c for c in colls if c]
        tags = sorted({labels.get(qid_of(v)) for p in ("P136", "P135") for v in claim_values(ent, p) if labels.get(qid_of(v))})
        links = len(ent.get("sitelinks", {}))
        e = {"i": q, "t": title[:140], "a": creators[0] if creators else "Unknown artist", "y": year, "d": str(year),
             "f": img.replace(" ", "_"), "k": "painting", "l": links}
        w, h = cm(claim_value(ent, "P2049")), cm(claim_value(ent, "P2048"))
        if w and h:
            e["w"], e["h"] = w, h
        if colls:
            e["c"] = colls[0][:80]
        if tags:
            e["g"] = tags[:6]
        if links >= 20:
            e["hl"] = 1
        wiki = ent.get("sitelinks", {}).get("enwiki", {}).get("title") or ids.get(q)
        if wiki:
            e["p"] = wiki
        items.append(e)

    items.sort(key=lambda e: (-e["l"], e["a"].lower(), e["t"].lower()))
    out = {
        "source": "Wikipedia + Wikidata + Wikimedia Commons (public domain)",
        "built": time.strftime("%Y-%m-%d"),
        "imgBase": "https://upload.wikimedia.org/wikipedia/commons/",
        "filePage": "https://commons.wikimedia.org/wiki/File:{file}",
        "itemUrl": "https://www.wikidata.org/wiki/{id}",
        "wikiUrl": "https://en.wikipedia.org/wiki/{title}",
        "count": len(items),
        "items": items,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("done: %d paintings (%d with dimensions, %d highlights, %d artists), %.1f MB, %.0fs" % (
        len(items), sum(1 for e in items if e.get("w")), sum(1 for e in items if e.get("hl")),
        len({e["a"] for e in items}), len(json.dumps(out, ensure_ascii=False, separators=(",", ":"))) / 1e6,
        time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
