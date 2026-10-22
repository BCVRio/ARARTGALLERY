# Art catalogue

## `paintings.json` — the museum catalogue

Thousands of notable public-domain paintings from Wikipedia's painting
articles and their Wikidata records, built by `tools/build-catalog-wiki.py`
(`tools/build-catalog-commons.py` builds the same file from the Wikidata query
service when it is not throttled). Each entry has the title, artist, year,
the collection that holds it, genre/movement tags, real dimensions where
recorded (used to hang the piece at true size), the Wikipedia article, and
the Wikimedia Commons image file. Image URLs are derived on the device from
the file name; Commons is used because it is the one image host that
reliably allows cross-origin use, which AR textures require (The Met's and
Cleveland's image servers do not, so `tools/build-catalog.py` for the Met is
kept only for reference).

Rebuild or extend it with:

    python3 -I tools/build-catalog-wiki.py --out catalog/paintings.json

then copy the file into `zappar/catalog/` as well.

## `galleries.json` — pieces for sale

Galleries and artists can list work that is actually for sale. Listed pieces
appear under the **For sale** filter with the price and a **Buy** button that
opens the gallery's own page.

```json
{
  "format": "ar-art-gallery-feed/1",
  "galleries": [
    {
      "name": "Example Gallery",
      "url": "https://example-gallery.com",
      "currency": "GBP",
      "items": [
        {
          "id": "eg-0001",
          "title": "Morning Tide",
          "artist": "A. Painter",
          "year": 2024,
          "medium": "Oil on canvas",
          "widthCm": 90,
          "heightCm": 70,
          "price": 1800,
          "imageUrl": "https://example-gallery.com/images/morning-tide-1600.jpg",
          "thumbnailUrl": "https://example-gallery.com/images/morning-tide-400.jpg",
          "buyUrl": "https://example-gallery.com/works/morning-tide",
          "tags": ["Seascapes", "Contemporary"]
        }
      ]
    }
  ]
}
```

Requirements for listed images:

- Served over HTTPS with `Access-Control-Allow-Origin: *` (or the app's
  origin). Without it the browser refuses to use the image as an AR texture.
- `imageUrl` at least 1200px on the long side for a sharp result; a smaller
  `thumbnailUrl` keeps the strip quick to scroll.
- `widthCm`/`heightCm` let the piece hang at its real size.

`price` is a number in the gallery's `currency` (ISO code). Multiple galleries
can be listed; each piece's Buy button goes to its own `buyUrl` (or the
gallery `url` if a piece has none).
