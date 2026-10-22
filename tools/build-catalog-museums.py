#!/usr/bin/env python3
"""
Builds catalog/paintings.json from museums that publish their collections
as open data AND serve their images with the cross-origin header that AR
textures require (checked for each image host below):

  nga   National Gallery of Art, Washington — open-data CSVs on GitHub,
        images from api.nga.gov (IIIF)
  smk   Statens Museum for Kunst, Copenhagen — public API, IIIF images
  saam  Smithsonian American Art Museum  }  Smithsonian Open Access bulk
  npg   National Portrait Gallery        }  metadata (S3), images from
  fsg   Freer and Sackler (Asian art)    }  ids.si.edu

Only works the museum marks public domain / CC0 with an open-access image
are included. Each entry carries title, artist, date, medium, real
dimensions where recorded (used to hang the piece at true size), subject
tags and the museum's own page. Image URLs are built on the device from
per-source templates in the file header.

Usage: python3 -I tools/build-catalog-museums.py --cache <dir> [--merge catalog/paintings-commons.json] [--out catalog/paintings.json]

--cache is a directory the raw downloads are kept in (re-used when present):
  <cache>/nga/*.csv, <cache>/smk/page-*.json, <cache>/si/<unit>/*.txt
--merge adds a Wikidata/Commons catalogue built by build-catalog-commons.py,
skipping works already present (matched on Wikidata id) but carrying over
their Wikipedia article and fame count.
"""
import argparse, csv, glob, json, os, re, sys, time
import urllib.request, urllib.parse, urllib.error

UA = {"User-Agent": "ARArtGallery-catalog-builder/1.0 (scott@bamsound.com)"}
NGA_RAW = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/"
NGA_FILES = ["objects.csv", "published_images.csv", "objects_dimensions.csv", "objects_terms.csv"]
SMK_SEARCH = "https://api.smk.dk/api/v1/art/search/?keys=*&filters=%5Bobject_names:painting%5D,%5Bpublic_domain:true%5D,%5Bhas_image:true%5D&rows=2000&lang=en&offset="
SI_BUCKET = "https://smithsonian-open-access.s3-us-west-2.amazonaws.com/metadata/edan/"
SI_UNITS = ["saam", "npg", "fsg"]

SOURCES = {
    "nga": {
        "name": "National Gallery of Art",
        "image": "https://api.nga.gov/iiif/{u}/full/!1200,1200/0/default.jpg",
        "thumb": "https://api.nga.gov/iiif/{u}/full/!320,320/0/default.jpg",
        "fallbacks": ["https://api.nga.gov/iiif/{u}/full/!800,800/0/default.jpg"],
        "page": "https://www.nga.gov/collection/art-object-page.{i}.html",
    },
    "smk": {
        "name": "SMK – National Gallery of Denmark",
        "image": "https://iip.smk.dk/iiif/jp2/{u}/full/!1200,1200/0/default.jpg",
        "thumb": "https://iip-thumb.smk.dk/iiif/jp2/{u}/full/!320,/0/default.jpg",
        "fallbacks": ["https://iip-thumb.smk.dk/iiif/jp2/{u}/full/!1024,/0/default.jpg"],
        "page": "https://open.smk.dk/artwork/image/{i}",
    },
    # SMK works whose image is only served as a fixed 1600px JPEG
    "smk2": {
        "name": "SMK – National Gallery of Denmark",
        "image": "https://api.smk.dk/api/v1/thumbnail/{u}.jpg",
        "thumb": "https://api.smk.dk/api/v1/thumbnail/{u}.jpg",
        "fallbacks": [],
        "page": "https://open.smk.dk/artwork/image/{i}",
    },
    "saam": {
        "name": "Smithsonian American Art Museum",
        "image": "https://ids.si.edu/ids/deliveryService?id={u}&max=1200",
        "thumb": "https://ids.si.edu/ids/deliveryService?id={u}&max=320",
        "fallbacks": ["https://ids.si.edu/ids/deliveryService?id={u}&max=800"],
        "page": "https://americanart.si.edu/collections/search/artwork/?id={i}",
    },
    "npg": {
        "name": "National Portrait Gallery (Smithsonian)",
        "image": "https://ids.si.edu/ids/deliveryService?id={u}&max=1200",
        "thumb": "https://ids.si.edu/ids/deliveryService?id={u}&max=320",
        "fallbacks": ["https://ids.si.edu/ids/deliveryService?id={u}&max=800"],
        "page": "https://npg.si.edu/object/{i}",
    },
    "fsg": {
        "name": "National Museum of Asian Art (Smithsonian)",
        "image": "https://ids.si.edu/ids/deliveryService?id={u}&max=1200",
        "thumb": "https://ids.si.edu/ids/deliveryService?id={u}&max=320",
        "fallbacks": ["https://ids.si.edu/ids/deliveryService?id={u}&max=800"],
        "page": "https://asia.si.edu/object/{i}/",
    },
}

# Artists whose works open the browse strip (no fame metric comes with
# museum data, unlike Wikipedia's sitelink counts)
FAMOUS = """
Leonardo da Vinci|Johannes Vermeer|Rembrandt van Rijn|Vincent van Gogh|Claude Monet|Edouard Manet|Édouard Manet
Edgar Degas|Pierre-Auguste Renoir|Paul Cézanne|Paul Gauguin|Georges Seurat|Henri de Toulouse-Lautrec|Mary Cassatt
Berthe Morisot|Camille Pissarro|Alfred Sisley|Gustave Courbet|Jean-François Millet|Eugène Delacroix|Jacques-Louis David
Jean-Auguste-Dominique Ingres|Francisco de Goya|El Greco|Diego Velázquez|Bartolomé Esteban Murillo|Titian|Giovanni Bellini
Sandro Botticelli|Raphael|Fra Angelico|Giotto|Duccio di Buoninsegna|Piero della Francesca|Filippo Lippi|Andrea del Verrocchio
Jan van Eyck|Rogier van der Weyden|Hieronymus Bosch|Pieter Bruegel the Elder|Hans Holbein the Younger|Albrecht Dürer
Lucas Cranach the Elder|Peter Paul Rubens|Anthony van Dyck|Frans Hals|Jan Steen|Pieter de Hooch|Jacob van Ruisdael
Aelbert Cuyp|Meindert Hobbema|Gerard ter Borch|Judith Leyster|Canaletto|Francesco Guardi|Giovanni Battista Tiepolo
Jean-Honoré Fragonard|François Boucher|Antoine Watteau|Jean Siméon Chardin|Élisabeth Louise Vigée Le Brun|Thomas Gainsborough
Joshua Reynolds|John Constable|Joseph Mallord William Turner|J. M. W. Turner|William Hogarth|George Stubbs|John Singer Sargent
James McNeill Whistler|Winslow Homer|Thomas Eakins|Edward Hopper|Albert Bierstadt|Frederic Edwin Church|Thomas Cole
George Inness|Albert Pinkham Ryder|Childe Hassam|Georgia O'Keeffe|Gilbert Stuart|John Singleton Copley|Benjamin West
Charles Willson Peale|Rembrandt Peale|George Catlin|Edward Hicks|Grandma Moses|Vilhelm Hammershøi|Christen Købke
Peder Severin Krøyer|Anna Ancher|Michael Ancher|Jens Juel|Nicolai Abildgaard|Wilhelm Marstrand|L.A. Ring|Laurits Andersen Ring
Carl Bloch|Johan Thomas Lundbye|Christoffer Wilhelm Eckersberg|Edvard Munch|Gustav Klimt|Amedeo Modigliani|Henri Rousseau
Odilon Redon|Pierre Bonnard|Édouard Vuillard|Paul Signac|Henri Matisse|Wassily Kandinsky|Katsushika Hokusai|Utagawa Hiroshige
""".replace("\n", "|")
FAMOUS = {re.sub(r"\s+", " ", n.strip()).lower() for n in FAMOUS.split("|") if n.strip()}


def fetch(url, dest, tries=4):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=300) as r, open(dest + ".tmp", "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            os.replace(dest + ".tmp", dest)
            return
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print("  %s: %s — retrying" % (url, e), flush=True)
            time.sleep(5 * (attempt + 1))
    raise SystemExit("could not fetch " + url)


def clean(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def first_year(s):
    m = re.search(r"\b(1[0-9]{3}|20[0-2][0-9])\b", s or "")
    return int(m.group(1)) if m else None


def size_ok(w, h):
    return 2 < w < 1200 and 2 < h < 1200 and 0.15 < w / h < 6.7


def cm_pair(text):
    """(width, height) in cm from a museum dimension string, which lists
    height × width [× depth]: '10 3/8 x 13 3/4 in. (26.3 x 34.8 cm)',
    '66 x 45.7cm (26 x 18")' or 'Overall: 124.5 x 97.8 x 3.8cm'."""
    m = re.search(r"((?:\d+(?:\.\d+)?\s*[x×]\s*){1,2}\d+(?:\.\d+)?)\s*cm", text or "")
    if not m:
        return None
    nums = [float(n) for n in re.split(r"\s*[x×]\s*", m.group(1))]
    h, w = nums[0], nums[1]
    if size_ok(w, h):
        return round(w, 1), round(h, 1)
    return None


def artist_name(s):
    """'James Wells Champney, 1843 - 1903' -> 'James Wells Champney';
    'E. F. Andrews, born Steubenville, OH 1835-died ...' -> 'E. F. Andrews';
    'Abbott Handerson Thayer (1849-1921)' -> 'Abbott Handerson Thayer'"""
    s = clean(s)
    s = re.split(r",\s*(?:born|active|died|c\.|ca\.|\d|\?|-|\()", s, 1)[0]
    s = re.sub(r"\s*\((?:born|active|died|c\.|ca\.|fl\.|\d|\?)[^)]*\)\s*$", "", s)
    return s.strip(" ,")


def is_famous(artist):
    return clean(artist).lower() in FAMOUS


def entry(src, i, title, artist, date, year, u, medium=None, dims=None, tags=None, q=None):
    e = {"s": src, "i": str(i), "t": clean(title)[:140], "a": clean(artist) or "Unknown artist", "d": clean(date)[:40], "u": u}
    if year:
        e["y"] = year
    if medium:
        e["m"] = clean(medium)[:80]
    if dims:
        e["w"], e["h"] = dims
    if tags:
        e["g"] = sorted({clean(t)[:40] for t in tags if clean(t)})[:6]
    if q:
        e["q"] = q
    if is_famous(e["a"]):
        e["hl"] = 1
    return e


def build_nga(cache):
    d = os.path.join(cache, "nga")
    for f in NGA_FILES:
        fetch(NGA_RAW + f, os.path.join(d, f))
    csv.field_size_limit(1 << 30)
    objs = {}
    with open(os.path.join(d, "objects.csv"), encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["classification"] == "Painting" and r["accessioned"] == "1" and r["isvirtual"] == "0":
                objs[r["objectid"]] = r
    imgs = {}
    with open(os.path.join(d, "published_images.csv"), encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["viewtype"] == "primary" and r["openaccess"] == "1" and r["depictstmsobjectid"] in objs:
                imgs[r["depictstmsobjectid"]] = r["uuid"]
    dims = {}
    with open(os.path.join(d, "objects_dimensions.csv"), encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            oid = r["objectid"]
            if oid not in imgs or r["unitname"] != "centimeters":
                continue
            # the painted surface is what hangs on the wall; 'overall' otherwise
            pref = 0 if r["element"] == "painted surface" else 1 if r["element"] == "overall" else 2
            cur = dims.setdefault(oid, {})
            if r["dimensiontype"] in ("height", "width") and (r["dimensiontype"] not in cur or pref < cur[r["dimensiontype"]][0]):
                cur[r["dimensiontype"]] = (pref, float(r["dimension"]))
    tags = {}
    with open(os.path.join(d, "objects_terms.csv"), encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["objectid"] in imgs and r["termtype"] in ("Style", "Keyword", "Theme") and r["term"] not in ("Keywords", "Themes"):
                tags.setdefault(r["objectid"], []).append(r["term"])
    out = []
    for oid, uuid in imgs.items():
        o = objs[oid]
        dm = dims.get(oid, {})
        size = None
        if "width" in dm and "height" in dm and size_ok(dm["width"][1], dm["height"][1]):
            size = (round(dm["width"][1], 1), round(dm["height"][1], 1))
        year = int(o["endyear"]) if o["endyear"].isdigit() else first_year(o["displaydate"])
        out.append(entry("nga", oid, o["title"], o["attribution"], o["displaydate"], year, uuid, o["medium"], size,
                         tags.get(oid), o["wikidataid"] or None))
    return out


def build_smk(cache):
    d = os.path.join(cache, "smk")
    out = []
    for off in range(0, 20000, 2000):
        path = os.path.join(d, "page-%d.json" % off)
        fetch(SMK_SEARCH + str(off), path)
        with open(path, encoding="utf-8") as f:
            page = json.load(f)
        for it in page.get("items", []):
            iiif = it.get("image_iiif_id") or ""
            thumb = it.get("image_thumbnail") or ""
            if "/jp2/" in iiif:
                src, u = "smk", iiif.rsplit("/jp2/", 1)[-1]
            elif "/api/v1/thumbnail/" in thumb and thumb.endswith(".jpg"):
                src, u = "smk2", thumb.rsplit("/", 1)[-1][:-4]
            else:
                continue
            if not it.get("public_domain"):
                continue
            titles = it.get("titles") or [{}]
            title = next((t.get("title") for t in titles if t.get("language") in ("engelsk", "en")), None) or titles[0].get("title")
            prod = (it.get("production") or [{}])[0]
            artist = prod.get("creator") or ""
            if prod.get("creator_forename") and prod.get("creator_surname"):
                artist = "%s %s" % (prod["creator_forename"], prod["creator_surname"])
            elif "," in artist:
                last, first = artist.split(",", 1)
                artist = "%s %s" % (first.strip(), last.strip())
            pd = (it.get("production_date") or [{}])[0]
            date = pd.get("period") or ""
            year = first_year(pd.get("end") or pd.get("start") or "")
            size = {}
            for dm in it.get("dimensions") or []:
                if dm.get("type") in ("height", "width") and dm.get("part", "Netto") in ("Netto", "netto", None) and dm.get("unit", "cm") == "cm":
                    try:
                        size.setdefault(dm["type"], float(dm["value"]))
                    except (TypeError, ValueError):
                        pass
            dims = None
            if "width" in size and "height" in size and size_ok(size["width"], size["height"]):
                dims = (round(size["width"], 1), round(size["height"], 1))
            tech = (it.get("techniques") or [None])[0]
            out.append(entry(src, it.get("object_number") or it["id"], title, artist, date, year, u, tech, dims, None))
        if len(page.get("items", [])) < 2000:
            break
    return out


def build_si(cache, unit):
    d = os.path.join(cache, "si", unit)
    index = os.path.join(d, "index.txt")
    fetch(SI_BUCKET + unit + "/index.txt", index)
    with open(index) as f:
        urls = [l.strip() for l in f if l.strip()]
    for n, url in enumerate(urls):
        fetch(url, os.path.join(d, url.rsplit("/", 1)[-1]))
        if (n + 1) % 64 == 0:
            print("  %s: %d/%d files" % (unit, n + 1, len(urls)), flush=True)
    out = []
    for path in sorted(glob.glob(os.path.join(d, "*.txt"))):
        if path == index:
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                c = rec.get("content", {})
                desc, ind, ft = c.get("descriptiveNonRepeating", {}), c.get("indexedStructured", {}), c.get("freetext", {})
                if not any(re.search(r"painting", t, re.I) for t in ind.get("object_type") or []):
                    continue
                if (desc.get("metadata_usage") or {}).get("access") != "CC0":
                    continue
                media = [m for m in (desc.get("online_media") or {}).get("media") or []
                         if m.get("type") == "Images" and (m.get("usage") or {}).get("access") == "CC0" and m.get("idsId")]
                if not media:
                    continue
                title = (desc.get("title") or {}).get("content")
                names = [n.get("content") for n in ft.get("name") or [] if n.get("label") in ("Artist", "Painter", "Maker", "Attributed to")]
                artist = artist_name(names[0]) if names else ""
                date = (ft.get("date") or [{}])[0].get("content", "")
                phys = ft.get("physicalDescription") or []
                medium = next((p["content"] for p in phys if p.get("label") == "Medium"), None)
                dim_text = next((p["content"] for p in phys if p.get("label") == "Dimensions" and not p["content"].lower().startswith("frame")), "")
                link = desc.get("record_link") or ""
                if unit == "saam":
                    m = re.search(r"[?&]id=(\d+)", link)
                    pid = m.group(1) if m else None
                elif unit == "npg":
                    pid = desc.get("record_ID")
                else:
                    m = re.search(r"/object/([^/?#]+)", link)
                    pid = m.group(1) if m else None
                if not pid or not title:
                    continue
                out.append(entry(unit, pid, title, artist, date, first_year(date), media[0]["idsId"], medium, cm_pair(dim_text),
                                 ind.get("topic")))
    return out


def merge_commons(items, path):
    """Add works from a Wikidata/Commons catalogue not already present."""
    with open(path, encoding="utf-8") as f:
        cat = json.load(f)
    by_q = {e["q"]: e for e in items if e.get("q")}
    added = 0
    for e in cat["items"]:
        have = by_q.get(e["i"])
        if have:
            if e.get("p"):
                have["p"] = e["p"]
            if e.get("l"):
                have["l"] = e["l"]
                if e["l"] >= 20:
                    have["hl"] = 1
            continue
        items.append(e)
        added += 1
    return added, cat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--merge")
    ap.add_argument("--out", default="catalog/paintings.json")
    args = ap.parse_args()
    t0 = time.time()

    items = []
    for name, fn in (("nga", build_nga), ("smk", build_smk)):
        print(name + "…", flush=True)
        got = fn(args.cache)
        print("  %d paintings, %.0fs" % (len(got), time.time() - t0), flush=True)
        items += got
    for unit in SI_UNITS:
        print(unit + "…", flush=True)
        got = build_si(args.cache, unit)
        print("  %d paintings, %.0fs" % (len(got), time.time() - t0), flush=True)
        items += got

    out = {
        "source": "National Gallery of Art, SMK, Smithsonian (public domain / CC0)",
        "built": time.strftime("%Y-%m-%d"),
        "sources": SOURCES,
        "count": 0,
        "items": items,
    }
    if args.merge and os.path.exists(args.merge):
        added, cat = merge_commons(items, args.merge)
        for k in ("imgBase", "filePage", "itemUrl", "wikiUrl"):
            if k in cat:
                out[k] = cat[k]
        out["source"] += " + " + cat.get("source", "Wikimedia Commons")
        print("merged %d works from %s" % (added, args.merge), flush=True)

    # browse order: highlights, then famous works by sitelinks, then by artist;
    # a prolific artist gets at most a dozen highlights so the opening strip
    # shows a spread of painters
    items.sort(key=lambda e: (-(e.get("hl", 0)), -(e.get("l", 0)), e["a"].lower(), e["t"].lower()))
    per_artist = {}
    for e in items:
        if e.get("hl") and not e.get("l"):
            per_artist[e["a"]] = per_artist.get(e["a"], 0) + 1
            if per_artist[e["a"]] > 12:
                del e["hl"]
    items.sort(key=lambda e: (-(e.get("hl", 0)), -(e.get("l", 0)), e["a"].lower(), e["t"].lower()))
    # ...and the highlights themselves are dealt out one painter at a time,
    # so the first screenful is a spread rather than one artist's run
    rest = [e for e in items if not e.get("hl")]
    runs = {}
    for e in items:
        if e.get("hl"):
            runs.setdefault(e["a"], []).append(e)
    dealt = []
    while runs:
        for a in list(runs):
            dealt.append(runs[a].pop(0))
            if not runs[a]:
                del runs[a]
    items[:] = dealt + rest
    out["count"] = len(items)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)
    print("done: %d paintings (%d with dimensions, %d highlights, %d artists), %.1f MB, %.0fs" % (
        len(items), sum(1 for e in items if e.get("w")), sum(1 for e in items if e.get("hl")),
        len({e["a"] for e in items}), os.path.getsize(args.out) / 1e6, time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
