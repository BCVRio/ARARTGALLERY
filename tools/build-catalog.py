#!/usr/bin/env python3
"""
Builds catalog/met.json: a compact, searchable catalogue of public-domain
paintings (and a set of early photographs) from The Metropolitan Museum of
Art's Open Access API. Every entry carries the museum page, real dimensions
in centimetres (so art hangs at true size), subject tags and a CORS-enabled
image hosted by the museum.

Usage: python3 -I tools/build-catalog.py [--max-fetch N] [--out catalog/met.json]

The Met asks for <= 80 requests/second; this runs well under that.
"""
import json, sys, time, re, argparse, threading
import urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://collectionapi.metmuseum.org/public/collection/v1"
UA = {"User-Agent": "ARArtGallery-catalog-builder/1.0 (scott@bamsound.com)"}
IMG_PREFIX = "https://images.metmuseum.org/CRDImages/"

# Departments with public-domain pictures worth hanging on a wall. The number is
# the cap on candidates taken from each (the search already prefers relevance).
DEPARTMENTS = [
    (11, "European Paintings", "painting", 4000),
    (15, "Robert Lehman Collection", "painting", 3000),
    (1,  "American Wing", "painting", 4000),
    (6,  "Asian Art", "painting", 3000),
    (14, "Islamic Art", "painting", 1500),
    (17, "Medieval Art", "painting", 1200),
    (21, "Modern Art", "painting", 1500),
    (19, "Photographs", "photograph", 2500),
]

PAINTING_WORDS = re.compile(r"paint|panel|canvas|fresco|screen|scroll|album leaf|folio|miniature|icon|watercolor|gouache|pastel|tempera", re.I)
lock = threading.Lock()
stats = {"fetched": 0, "kept": 0, "errors": 0, "retries": 0}


def get(url, tries=5):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 403:
                with lock:
                    stats["forbidden"] = stats.get("forbidden", 0) + 1
                if attempt < tries - 1:
                    time.sleep(20 * (attempt + 1))
                    continue
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                with lock:
                    stats["retries"] += 1
                time.sleep(1.5 * (attempt + 1))
                continue
            if e.code == 404:
                return None
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise


def search_ids(query, department_id, cap):
    """v1.1 search pages with limit (<= 500) and offset."""
    ids, total, offset = [], 0, 0
    while len(ids) < cap:
        q = urllib.parse.urlencode({"q": query, "hasImages": "true", "isPublicDomain": "true",
                                    "departmentId": department_id, "limit": 500, "offset": offset})
        d = get(BASE + ".1/search?" + q) or {}
        page = d.get("objectIDs") or []
        total = d.get("total", total)
        if not page:
            break
        ids.extend(page)
        offset += len(page)
        if offset >= total:
            break
        time.sleep(0.2)
    return total, ids


def department_ids(department_id):
    d = get(BASE + "/objects?departmentIds=%d" % department_id) or {}
    return d.get("objectIDs") or []


def clean(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def dims_cm(measurements):
    for m in measurements or []:
        if (m.get("elementName") or "").lower() in ("overall", "image", "sheet", "painting", "frame"):
            em = m.get("elementMeasurements") or {}
            w, h = em.get("Width"), em.get("Height")
            if w and h and 2 < w < 1200 and 2 < h < 1200:
                return round(w, 1), round(h, 1)
    for m in measurements or []:
        em = m.get("elementMeasurements") or {}
        w, h = em.get("Width"), em.get("Height")
        if w and h and 2 < w < 1200 and 2 < h < 1200:
            return round(w, 1), round(h, 1)
    return None, None


def keep(o, kind):
    if not o or not o.get("isPublicDomain") or not o.get("primaryImageSmall"):
        return None
    cls = clean(o.get("classification"))
    name = clean(o.get("objectName"))
    if kind == "photograph":
        if not cls.lower().startswith("photograph"):
            return None
    else:
        if not (cls.lower().startswith("painting") or PAINTING_WORDS.search(cls) or PAINTING_WORDS.search(name)):
            return None
        if re.search(r"photograph|print|textile|ceramic|sculpture|furniture|glass|metal|jewel|coin|medal|book", cls, re.I):
            return None
    img = o["primaryImageSmall"]
    if not img.startswith(IMG_PREFIX):
        return None
    w, h = dims_cm(o.get("measurements"))
    tags = [t.get("term") for t in (o.get("tags") or []) if t.get("term")]
    year = o.get("objectBeginDate")
    entry = {
        "i": o["objectID"],
        "t": clean(o.get("title"))[:140] or "Untitled",
        "a": clean(o.get("artistDisplayName")) or clean(o.get("culture")) or "Unknown artist",
        "d": clean(o.get("objectDate"))[:40],
        "y": year if isinstance(year, int) else None,
        "m": clean(o.get("medium"))[:80],
        "k": "photo" if kind == "photograph" else "painting",
        "img": img[len(IMG_PREFIX):],
    }
    bio = clean(o.get("artistDisplayBio"))
    if bio:
        entry["b"] = bio[:80]
    culture = clean(o.get("culture")) or clean(o.get("period"))
    if culture and culture != entry["a"]:
        entry["c"] = culture[:60]
    if w and h:
        entry["w"], entry["h"] = w, h
    if tags:
        entry["g"] = tags[:6]
    if o.get("isHighlight"):
        entry["hl"] = 1
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="catalog/met.json")
    ap.add_argument("--max-fetch", type=int, default=16000)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--rate", type=float, default=12.0, help="max object requests per second")
    ap.add_argument("--resume", action="store_true", help="keep items already in --out and fetch only the rest")
    args = ap.parse_args()

    existing = []
    if args.resume:
        try:
            with open(args.out, encoding="utf-8") as f:
                existing = json.load(f).get("items", [])
            print("resuming: %d items already catalogued" % len(existing), flush=True)
        except (OSError, ValueError):
            existing = []
    have = {e["i"] for e in existing}

    candidates = []  # (id, kind)
    seen = set()
    for dep_id, dep_name, kind, cap in DEPARTMENTS:
        total, ids = search_ids("painting" if kind == "painting" else "photograph", dep_id, cap)
        source = "search"
        if not ids:
            ids = department_ids(dep_id)
            source = "department list"
        picked = 0
        for i in ids:
            if i in seen:
                continue
            seen.add(i)
            picked += 1
            if i not in have:
                candidates.append((i, kind))
            if picked >= cap:
                break
        print("%-26s %6d via %-15s -> %d candidates" % (dep_name, total or len(ids), source, picked), flush=True)
        time.sleep(0.3)
    candidates = candidates[: args.max_fetch]
    print("fetching", len(candidates), "objects", flush=True)

    items = list(existing)
    t0 = time.time()
    gate = {"next": time.time()}
    min_gap = 1.0 / max(0.5, args.rate)

    def throttle():
        # One shared pacing clock across threads keeps us under --rate
        with lock:
            now = time.time()
            wait = max(0.0, gate["next"] - now)
            gate["next"] = max(now, gate["next"]) + min_gap
        if wait > 0:
            time.sleep(wait)

    def work(c):
        oid, kind = c
        throttle()
        try:
            o = get(BASE + "/objects/%d" % oid)
        except Exception as e:  # noqa: BLE001
            with lock:
                stats["errors"] += 1
                key = getattr(e, "code", type(e).__name__)
                stats.setdefault("error_kinds", {})
                stats["error_kinds"][key] = stats["error_kinds"].get(key, 0) + 1
            return None
        with lock:
            stats["fetched"] += 1
            n = stats["fetched"]
        if n % 500 == 0:
            print("  %d fetched, %d kept, %.0fs" % (n, stats["kept"], time.time() - t0), flush=True)
        e = keep(o, kind)
        if e:
            with lock:
                stats["kept"] += 1
        return e

    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        futures = [ex.submit(work, c) for c in candidates]
        for fut in as_completed(futures):
            e = fut.result()
            if e:
                items.append(e)
            if stats.get("forbidden", 0) > 200 and stats["errors"] > stats["fetched"]:
                print("API is refusing requests; stopping early (re-run with --resume later)", flush=True)
                for f in futures:
                    f.cancel()
                break

    # Highlights and well-known names first, then by title, so a blank browse
    # opens on the strongest pieces
    items.sort(key=lambda e: (0 if e.get("hl") else 1, e["k"], e["a"].lower(), e["t"].lower()))
    out = {
        "source": "The Metropolitan Museum of Art — Open Access (CC0)",
        "built": time.strftime("%Y-%m-%d"),
        "imgPrefix": IMG_PREFIX,
        "pageUrl": "https://www.metmuseum.org/art/collection/search/{id}",
        "count": len(items),
        "items": items,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    kinds = {}
    for e in items:
        kinds[e["k"]] = kinds.get(e["k"], 0) + 1
    print("error kinds:", stats.get("error_kinds", {}), flush=True)
    print("done: %d items %s | fetched %d, errors %d, retries %d, %.0fs, %.1f MB" % (
        len(items), kinds, stats["fetched"], stats["errors"], stats["retries"], time.time() - t0,
        len(json.dumps(out, ensure_ascii=False, separators=(",", ":"))) / 1e6), flush=True)


if __name__ == "__main__":
    main()
