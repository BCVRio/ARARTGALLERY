#!/usr/bin/env python3
"""
Builds catalog/paintings.json: notable public-domain paintings from Wikidata,
with images on Wikimedia Commons — the one image host that reliably allows
cross-origin use, which AR textures need. Each entry carries title, artist,
year, collection, genre/movement tags, real dimensions where recorded, the
Commons file name (image URLs are derived on the device) and the English
Wikipedia article where one exists.

Usage: python3 -I tools/build-catalog-commons.py [--pages 8] [--out catalog/paintings.json]

The Wikidata query service is rate limited; the script honours Retry-After
and spaces queries out, so a full build can take a while.
"""
import json, sys, time, re, argparse
import urllib.request, urllib.parse, urllib.error

ENDPOINT = "https://query.wikidata.org/sparql"
UA = {"User-Agent": "ARArtGallery-catalog-builder/1.0 (scott@bamsound.com)", "Accept": "application/sparql-results+json"}
PAGE = 1000
MIN_SITELINKS = 4          # notable works first; raise for a smaller, more famous set
MAX_YEAR = 1925            # keeps to works safely in the public domain

QUERY = """
SELECT ?item ?itemLabel ?creatorLabel ?year ?img ?sitelinks ?w ?wUnit ?h ?hUnit ?collectionLabel ?article
       (GROUP_CONCAT(DISTINCT ?tagLabel; separator="|") AS ?tags)
WHERE {
  {
    SELECT ?item (SAMPLE(?image) AS ?img) (MIN(YEAR(?inception)) AS ?year) ?sitelinks WHERE {
      ?item wdt:P31 wd:Q3305213; wdt:P18 ?image; wdt:P571 ?inception; wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks >= %(min_links)d)
      FILTER(YEAR(?inception) <= %(max_year)d)
    } GROUP BY ?item ?sitelinks
    ORDER BY DESC(?sitelinks) LIMIT %(limit)d OFFSET %(offset)d
  }
  OPTIONAL { ?item wdt:P170 ?creator . }
  OPTIONAL { ?item wdt:P195 ?collection . }
  OPTIONAL { ?item p:P2049/psv:P2049 ?wn . ?wn wikibase:quantityAmount ?w ; wikibase:quantityUnit ?wUnit . }
  OPTIONAL { ?item p:P2048/psv:P2048 ?hn . ?hn wikibase:quantityAmount ?h ; wikibase:quantityUnit ?hUnit . }
  OPTIONAL { ?item wdt:P136 ?tag . } OPTIONAL { ?item wdt:P135 ?tag . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en" .
    ?item rdfs:label ?itemLabel . ?creator rdfs:label ?creatorLabel .
    ?collection rdfs:label ?collectionLabel . ?tag rdfs:label ?tagLabel .
  }
}
GROUP BY ?item ?itemLabel ?creatorLabel ?year ?img ?sitelinks ?w ?wUnit ?h ?hUnit ?collectionLabel ?article
"""

UNIT_TO_CM = {"Q174728": 1.0, "Q174789": 0.1, "Q11573": 100.0, "Q218593": 2.54, "Q3710": 30.48}


def run_query(q, tries=12):
    url = ENDPOINT + "?" + urllib.parse.urlencode({"query": q, "format": "json"})
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)["results"]["bindings"]
        except urllib.error.HTTPError as e:
            retry = e.headers.get("Retry-After")
            wait = min(1300, int(retry)) if retry and retry.isdigit() else 70 * (attempt + 1)
            print("  HTTP %d — waiting %ds (attempt %d)" % (e.code, wait, attempt + 1), flush=True)
            time.sleep(wait + 2)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print("  network error %s — waiting 60s" % e, flush=True)
            time.sleep(60)
    return None


def cm(amount, unit):
    if not amount:
        return None
    try:
        v = float(amount)
    except ValueError:
        return None
    qid = (unit or "").rsplit("/", 1)[-1]
    f = UNIT_TO_CM.get(qid)
    if f is None:
        return None
    v *= f
    return round(v, 1) if 2 < v < 1200 else None


def val(b, k):
    return b.get(k, {}).get("value")


def clean(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="catalog/paintings.json")
    ap.add_argument("--pages", type=int, default=8)
    ap.add_argument("--min-links", type=int, default=MIN_SITELINKS)
    args = ap.parse_args()

    items, seen = [], set()
    t0 = time.time()
    for page in range(args.pages):
        q = QUERY % {"min_links": args.min_links, "max_year": MAX_YEAR, "limit": PAGE, "offset": page * PAGE}
        print("page %d (offset %d)…" % (page + 1, page * PAGE), flush=True)
        rows = run_query(q)
        if rows is None:
            print("  giving up on this page", flush=True)
            break
        added = 0
        for b in rows:
            qid = val(b, "item").rsplit("/", 1)[-1]
            if qid in seen:
                continue
            img = val(b, "img") or ""
            fname = urllib.parse.unquote(img.rsplit("/", 1)[-1]).replace(" ", "_")
            if not re.search(r"\.(jpe?g|png)$", fname, re.I):
                continue
            title = clean(val(b, "itemLabel"))
            if not title or re.fullmatch(r"Q\d+", title):
                continue
            seen.add(qid)
            tags = [t for t in (val(b, "tags") or "").split("|") if t and not re.fullmatch(r"Q\d+", t)]
            e = {
                "i": qid,
                "t": title[:140],
                "a": clean(val(b, "creatorLabel")) or "Unknown artist",
                "y": int(val(b, "year")) if val(b, "year") else None,
                "f": fname,
                "k": "painting",
                "l": int(val(b, "sitelinks") or 0),
            }
            e["d"] = str(e["y"]) if e["y"] else ""
            w, h = cm(val(b, "w"), val(b, "wUnit")), cm(val(b, "h"), val(b, "hUnit"))
            if w and h:
                e["w"], e["h"] = w, h
            coll = clean(val(b, "collectionLabel"))
            if coll and not re.fullmatch(r"Q\d+", coll):
                e["c"] = coll[:80]
            if tags:
                e["g"] = sorted(set(tags))[:6]
            if e["l"] >= 20:
                e["hl"] = 1
            art = val(b, "article")
            if art:
                e["p"] = urllib.parse.unquote(art.rsplit("/", 1)[-1])
            items.append(e)
            added += 1
        print("  +%d (total %d), %.0fs" % (added, len(items), time.time() - t0), flush=True)
        if len(rows) < PAGE:
            break
        time.sleep(65)   # the query service asks for roughly one query a minute from us

    items.sort(key=lambda e: (-e["l"], e["a"].lower(), e["t"].lower()))
    out = {
        "source": "Wikidata + Wikimedia Commons (public domain)",
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
    with_dims = sum(1 for e in items if e.get("w"))
    print("done: %d paintings (%d with dimensions, %d highlights), %.1f MB, %.0fs" % (
        len(items), with_dims, sum(1 for e in items if e.get("hl")),
        len(json.dumps(out, ensure_ascii=False, separators=(",", ":"))) / 1e6, time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
