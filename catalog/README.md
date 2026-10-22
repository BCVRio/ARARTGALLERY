# Art catalogue

## `paintings.json` — the museum catalogue

About 13,600 public-domain paintings from museums that publish their
collections as open data *and* serve their images with the cross-origin
header that AR textures require (many museum image servers, The Met's and
Cleveland's among them, do not, so their pictures cannot be used as WebGL
textures and are left out):

| Source | Works | Images |
| --- | --- | --- |
| National Gallery of Art, Washington | ~2,900 | api.nga.gov (IIIF) |
| SMK – National Gallery of Denmark | ~4,600 | iip.smk.dk / api.smk.dk |
| Smithsonian American Art Museum | ~4,100 | ids.si.edu |
| National Portrait Gallery (Smithsonian) | ~600 | ids.si.edu |
| National Museum of Asian Art (Smithsonian) | ~1,400 | ids.si.edu |

Each entry has the title, artist, date, medium, real dimensions where
recorded (used to hang the piece at true size), subject tags and the
museum's own collection page. Only ids are stored; the image URLs are built
on the device from the per-source templates in the file header
(`sources`). Works are flagged as highlights (`hl`) when the artist is
well known, and the file is ordered so the opening strip shows a spread of
painters.

Rebuild it with:

    python3 -I tools/build-catalog-museums.py --cache /path/to/cache --out catalog/paintings.json

The cache directory keeps the raw museum downloads (NGA CSVs, SMK API
pages, Smithsonian bulk metadata — a few hundred MB) so later runs are
quick. Then copy the file into `zappar/catalog/` as well.

`tools/build-catalog-commons.py` builds a catalogue of famous paintings
from Wikidata with Wikimedia Commons images in the same format; pass its
output to the museum builder with `--merge` to add those works. The
Wikidata query service rate-limits heavily, so that build can take hours.
`tools/build-catalog.py` (The Met) is kept only for reference.

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
