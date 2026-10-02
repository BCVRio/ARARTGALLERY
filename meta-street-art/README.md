# SprayPath — by BCVR Immersive

Hands-free walking directions to London street art, built for **Meta glasses**, plus
**live AR directions** in the phone browser using **Zappar Universal AR**.

| View | File | What it does |
| --- | --- | --- |
| Glasses mode | `index.html` | Spoken turn-by-turn directions through the glasses' speakers, voice commands, and a minimal black heads-up view for glasses with a display. |
| Live AR | `ar.html` | Camera view with animated 3D arrows on the pavement that follow the walking route, a light-beacon over the artwork, and a confetti burst when you arrive. |

Both views share `spots.js` (13 London spots, 3 walking tours) and `nav-core.js` (routing, geo maths, speech, compass).

## How it works with Meta glasses

Meta glasses don't run third-party web apps directly, so SprayPath runs on the phone they're paired with:

1. Pair the glasses with the phone as normal (Meta AI app).
2. Open SprayPath on the phone, pick a tour or spot, and put the phone away.
3. Directions and the story behind each piece play through the glasses' open-ear speakers.
4. Turn on **Voice commands** (Chrome/Safari) and say *"next"*, *"repeat"*, *"how far"*, *"which way"*, *"what is this"* or *"stop"*.
5. On glasses with a display, turn on **Glasses display view**. It's black-background (black is see-through on waveguide displays) with a big arrow, distance and the next turn.

A native integration (glasses camera, on-lens display) would use Meta's Wearables Device Access Toolkit in an iOS/Android app. This web version is the prototype for that.

## Live AR directions (Zappar)

`ar.html` uses [`@zappar/zappar-threejs`](https://www.npmjs.com/package/@zappar/zappar-threejs) 4.3.0 with three.js r159 from CDNs, so there's no build step.

- **Instant world tracking** keeps the guidance on the ground about 5 m ahead of you as you walk.
- Arrow direction = route bearing (looking 25 m ahead on the route) minus the phone's camera heading (compass), so it bends with the street.
- Rerouting kicks in automatically if you go more than 40 m off the route.

### Publishing with your ZapWorks account

Zappar's computer-vision library checks your licence by domain. Pick one:

- **Host on ZapWorks (easiest):** run `./scripts/package-zapworks.sh`, then in [zap.works](https://zap.works) create a *Universal AR* project and upload `spraypath-zapworks.zip` on the **Experience** tab (or use the ZapWorks CLI shown there). You get a `*.zappar.io` URL and need no domain registration.
- **Self-host (GitHub Pages etc.):** register the full domain (e.g. `bcvrio.github.io`) with ZapWorks via support@zappar.com, then serve over HTTPS.
- **Local testing:** works without registration on `localhost`/`127.*`/`192.*`/`10.*` or ngrok.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/?demo=1        (glasses mode, simulated walk)
# open http://localhost:8000/ar.html?demo=1 (AR mode, simulated walk)
```

Useful URL parameters: `?demo=1` (simulated GPS walk from the nearest station), `?hud=1` (glasses display view),
`?tour=shoreditch|southbank|camden`, `?spot=<id>`. Camera, GPS and compass need HTTPS on a real phone.

## Data & credits

- Walking routes: OSRM foot profile on OpenStreetMap data, via the FOSSGIS server `routing.openstreetmap.de` (fair-use; for production traffic, run your own OSRM or use a commercial routing API).
- Map tiles © OpenStreetMap contributors.
- Street art changes all the time. Coordinates point to the wall or street, and individual pieces may be painted over. Add or edit spots in `spots.js`.
