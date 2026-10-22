// AR Art Gallery Pro — Zappar Universal AR edition (three.js)
//
// Tracking model: Zappar's world tracker finds the floor; the user sets a
// wall by aiming at the line where it meets the floor (or, inside the App
// Clip, at a natively detected wall). The wall is stored relative to a
// tracked anchor and the artwork hangs on its surface. Zappar's instant
// tracker is the fallback where no floor can be found.

// On-device diagnostics: the log is always buffered; the overlay shows
// with ?debug=1 or from ⋯ → Diagnostics (the App Clip has no address bar)
const diagLines = [];
let diagPanel = null;
const diagLog = (tag, args) => {
    const line = tag + ' ' + Array.from(args).map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    diagLines.push(line);
    if (diagLines.length > 400) diagLines.shift();
    if (diagPanel) {
        diagPanel.textContent += line + '\n';
        diagPanel.scrollTop = diagPanel.scrollHeight;
    }
};
function showDiagnostics() {
    if (diagPanel) { diagPanel.remove(); diagPanel = null; return; }
    diagPanel = document.createElement('pre');
    diagPanel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;' +
        'background:rgba(0,0,0,0.85);color:#7CFC00;font:10px/1.4 monospace;padding:8px;margin:0;' +
        'z-index:99999;white-space:pre-wrap;pointer-events:auto;';
    diagPanel.textContent = diagLines.join('\n') + '\n';
    diagPanel.addEventListener('dblclick', showDiagnostics);
    document.body.appendChild(diagPanel);
    diagPanel.scrollTop = diagPanel.scrollHeight;
}
['log', 'warn', 'error'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args) => { diagLog('[' + level[0] + ']', args); orig(...args); };
});
window.addEventListener('error', e => diagLog('[E]', [e.message, e.filename + ':' + e.lineno]));
window.addEventListener('unhandledrejection', e => diagLog('[P]', [String(e.reason)]));
document.addEventListener('DOMContentLoaded', () => {
    diagLog('[i]', ['ZapparThree ' + (window.ZapparThree ? 'loaded' : 'MISSING'),
                    'THREE r' + (window.THREE ? THREE.REVISION : '?'),
                    'UA ' + navigator.userAgent.slice(0, 80)]);
    if (location.search.indexOf('debug=1') !== -1) showDiagnostics();
});

// App State
let renderer = null;            // THREE.WebGLRenderer we own (no A-Frame)
let scene = null;               // root THREE.Scene
let zCamera = null;             // ZapparThree.Camera (renders + tracks)
let anchorNode = null;          // THREE.Object3D the gallery hangs from
let instantTracker = null;      // ZapparThree.InstantWorldTracker
let instantGroup = null;        // its anchor group in the scene
let instantPlacement = true;    // while true the instant anchor follows the aim
let arStarted = false;          // camera running and render loop live
const frameCallbacks = new Set();
let galleryGroup = null;        // THREE.Group that holds artwork meshes
let gesturesWired = false;
let trackingMode = 'instant';   // 'world' (plane detection) or 'instant' fallback
let cameraPaused = false;
let anchored = false;
let placedArts = [];            // every hung artwork mesh, each its own fixture
let selectedPlaced = null;      // picture the size/drag/remove controls act on
let pendingTemplate = null;     // template waiting for a wall tap
let artworks = [];
let selectedArt = null;
let favorites = JSON.parse(localStorage.getItem('artFavorites') || '[]');
let measurementMode = false;
let currentSource = 'museum';
let selectedTemplate = null;

// ARKit mode: on iPhone/iPad Safari, hanging goes through Apple AR Quick
// Look — native ARKit wall tracking straight from the web. Tapping a
// painting opens it in Apple's viewer; its shutter button saves the photo.
// Devices without Quick Look keep the in-browser Zappar flow.
const arkitMode = !!(window.ARKitQuickLook && window.ARKitQuickLook.supported());
let qlOpenedAt = 0;

// Inside Zappar's App Clip shell the in-scene tracker is fed by native
// ARKit/ARCore, so the browser-side Quick Look handoff must stand down
// and let the (now native-quality) in-scene flow do the hanging
function isInAppClip() {
    try {
        return !!(window.ZapparThree && ZapparThree.isAppClip && ZapparThree.isAppClip());
    } catch (e) {
        return false;
    }
}

// The standalone Zappar bundle ships three.js and exposes it globally
const THREE = window.THREE;

// Parallax effect (start screen)
function initParallax() {
    const startScreen = document.getElementById('start-screen');

    startScreen.addEventListener('mousemove', (e) => {
        const rect = startScreen.getBoundingClientRect();
        const mouseX = ((e.clientX - rect.left) / rect.width) * 100;
        const mouseY = ((e.clientY - rect.top) / rect.height) * 100;

        document.documentElement.style.setProperty('--mouse-x', `${mouseX}%`);
        document.documentElement.style.setProperty('--mouse-y', `${mouseY}%`);

        const heroContent = document.querySelector('.hero-content');
        if (heroContent) {
            const moveX = (mouseX - 50) * 0.02;
            const moveY = (mouseY - 50) * 0.02;
            heroContent.style.transform = `translate(${moveX}px, ${moveY}px)`;
        }
    });

    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (e) => {
            const tiltX = e.gamma || 0;
            const tiltY = e.beta || 0;
            const normalizedX = 50 + (tiltX / 90) * 25;
            const normalizedY = 50 + (tiltY / 180) * 25;
            document.documentElement.style.setProperty('--mouse-x', `${normalizedX}%`);
            document.documentElement.style.setProperty('--mouse-y', `${normalizedY}%`);
        });
    }
}

// Room Templates
const roomTemplates = [
    {
        id: 'minimalist',
        name: 'Minimalist Gallery',
        description: '3 centered pieces with balanced spacing',
        artworks: 3,
        layout: 'horizontal',
        spacing: 0.35
    },
    {
        id: 'salon',
        name: 'Salon Wall',
        description: 'Classic gallery wall with 6-8 pieces',
        artworks: 6,
        layout: 'grid',
        spacing: 0.15
    },
    {
        id: 'focal',
        name: 'Statement Piece',
        description: 'Single large artwork as focal point',
        artworks: 1,
        layout: 'center',
        spacing: 0
    },
    {
        id: 'triptych',
        name: 'Triptych',
        description: 'Three-panel artistic arrangement',
        artworks: 3,
        layout: 'triptych',
        spacing: 0.08
    }
];

// DOM Elements
const startScreen = document.getElementById('start-screen');
const canvasContainer = document.getElementById('canvas-container');
const searchPanel = document.getElementById('search-panel');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const artGallery = document.getElementById('art-gallery');
const status = document.getElementById('status');
const favoritesBtn = document.getElementById('favorites-btn');
const favoritesCount = document.getElementById('favorites-count');
const measurementDisplay = document.getElementById('measurement-display');
const shareSheet = document.getElementById('share-sheet');


function fadeAudio(a, target, ms, done) {
    if (!a) { if (done) done(); return; }
    const from = a.volume;
    const t0 = performance.now();
    cancelAnimationFrame(a._fade);
    const step = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        a.volume = Math.max(0, Math.min(1, from + (target - from) * k));
        if (k < 1) a._fade = requestAnimationFrame(step);
        else if (done) done();
    };
    a._fade = requestAnimationFrame(step);
}

// — Sound: title ambience + synthesized UI effects (persisted toggle) —
const sfx = (() => {
    let ctx = null;
    let on = localStorage.getItem('gallerySound') === 'on';

    function ac() {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function tone(freq, dur, opts) {
        if (!on) return;
        opts = opts || {};
        try {
            const c = ac();
            const t0 = c.currentTime + (opts.delay || 0);
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = opts.type || 'sine';
            osc.frequency.setValueAtTime(freq, t0);
            if (opts.glide) osc.frequency.exponentialRampToValueAtTime(opts.glide, t0 + dur);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(opts.vol || 0.08, t0 + 0.012);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            osc.connect(g).connect(c.destination);
            osc.start(t0);
            osc.stop(t0 + dur + 0.05);
        } catch (e) {}
    }

    function noiseBurst(dur, vol) {
        if (!on) return;
        try {
            const c = ac();
            const frames = Math.floor(c.sampleRate * dur);
            const buf = c.createBuffer(1, frames, c.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
            const src = c.createBufferSource();
            src.buffer = buf;
            const filter = c.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 2400;
            const g = c.createGain();
            g.gain.value = vol;
            src.connect(filter);
            filter.connect(g);
            g.connect(c.destination);
            src.start();
        } catch (e) {}
    }

    function sync() {
        const b = document.getElementById('sound-toggle');
        if (b) b.textContent = on ? '🔊' : '🔇';
        const a = document.getElementById('ambience');
        if (a) {
            if (on) {
                if (a.paused) { a.volume = 0; a.play().catch(() => {}); }
                fadeAudio(a, 0.35, 2000);
            } else {
                fadeAudio(a, 0, 1500, () => a.pause());
            }
        }
    }

    return {
        get on() { return on; },
        toggle() {
            on = !on;
            localStorage.setItem('gallerySound', on ? 'on' : 'off');
            if (on) ac();
            sync();
            this.tap();
        },
        sync,
        tap()     { tone(740, 0.07, { glide: 540, vol: 0.05 }); },
        select()  { tone(620, 0.07, { vol: 0.05 }); tone(930, 0.09, { vol: 0.05, delay: 0.06 }); },
        hang()    { tone(660, 0.35, { type: 'triangle', vol: 0.09 }); tone(990, 0.45, { type: 'triangle', vol: 0.05, delay: 0.05 }); },
        anchor()  { tone(196, 0.5, { vol: 0.1 }); tone(294, 0.55, { vol: 0.06, delay: 0.08 }); },
        shutter() { noiseBurst(0.09, 0.12); }
    };
})();

document.getElementById('sound-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    sfx.toggle();
});
sfx.sync();

// Our own curtain after ZapWorks' splash: the film and entrance only start
// on the begin tap, so the opening is always seen
document.getElementById('begin-gate').addEventListener('click', () => {
    document.getElementById('begin-gate').classList.add('gone');
    startScreen.classList.add('revealed');
    const v = document.getElementById('hero-video');
    if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
    }
    const amb = document.getElementById('ambience');
    if (sfx.on && amb) {
        amb.currentTime = 0;
        amb.volume = 0;
        amb.play().catch(() => {});
        fadeAudio(amb, 0.35, 2000);
    }
}, { once: true });

// One delegated, subtle tap sound for every tactile control
document.addEventListener('click', (e) => {
    if (e.target.closest('.dock-btn, .top-btn, .hero-cta, #search-btn, .btn-primary, .filter-chip, .share-option, .art-item, .template-card, .favorite-card')) {
        sfx.tap();
    }
});

const CURATED_COLLECTIONS = {
    modern: [
        ['Fractured Gilt', 'Atelier Noir', '1,450.00'],
        ['Two Gestures', 'M. Hara', '820.00'],
        ['Bronze Planes', 'V. Keller', '990.00'],
        ['Terrain in Gold', 'E. Marchetti', '1,200.00'],
        ['Molten Vein', 'Atelier Noir', '1,680.00'],
        ['Quiet Horizon', 'R. Ostrowski', '760.00']
    ],
    photography: [
        ['Concrete Light', 'D. Veld', '540.00'],
        ['First Fog', 'A. Lindqvist', '620.00'],
        ['Silk Tide', 'N. Okabe', '580.00'],
        ['Golden Ridge', 'S. Amari', '640.00'],
        ['Ascent', 'L. Fontaine', '520.00'],
        ['City Rain', 'J. Mercer', '560.00']
    ]
};

function curatedCollection(kind, label) {
    const prefix = kind === 'modern' ? 'modern' : 'photo';
    return CURATED_COLLECTIONS[kind].map(([title, artist, price], i) => ({
        id: `${kind}-${i + 1}`,
        title,
        artist,
        imageUrl: `assets/collections/${prefix}-${i + 1}.jpg`,
        thumbnailUrl: `assets/collections/${prefix}-${i + 1}-thumb.jpg`,
        source: label,
        purchaseUrl: '#',
        price
    }));
}

// Initialize
updateFavoritesCount();
initParallax();

// Event Listeners
document.getElementById('start-ar-btn').addEventListener('click', initAR);

document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentSource = chip.dataset.source;
    });
});

function activePicture() {
    return selectedPlaced || placedArts[placedArts.length - 1] || null;
}

function scalePicture(mesh, factor) {
    const next = Math.min(10, Math.max(0.1, mesh.userData.scale * factor));
    mesh.userData.scale = next;
    mesh.scale.set(next, next, 1);
    updateMeasurement();
}

document.getElementById('size-up').addEventListener('click', () => {
    const m = activePicture();
    if (m) scalePicture(m, 1.2);
});

document.getElementById('size-down').addEventListener('click', () => {
    const m = activePicture();
    if (m) scalePicture(m, 0.8);
});

document.getElementById('measure-btn').addEventListener('click', () => {
    shareSheet.classList.remove('active');
    measurementMode = !measurementMode;
    if (measurementMode) {
        measurementDisplay.classList.add('active');
        updateMeasurement();
    } else {
        measurementDisplay.classList.remove('active');
    }
});

document.getElementById('screenshot-btn').addEventListener('click', takeScreenshot);

// Apple-grade wall lock: hands the selected piece to AR Quick Look, where
// ARKit itself detects the wall and anchors the artwork — native tracking
// quality from a plain web link (iPhone/iPad Safari only)
const wallLockBtn = document.getElementById('wall-lock-btn');
if (wallLockBtn && arkitMode) {
    wallLockBtn.style.display = '';
    wallLockBtn.addEventListener('click', () => {
        const sel = activePicture();
        const art = (sel && sel.userData.art) || selectedArt;
        if (!art) {
            showStatus('Select an artwork from the strip first');
            return;
        }
        openInARKit(art);
    });
}

// In Quick Look mode the piece lives in Apple's viewer, not our scene, so
// the in-scene size / remove / screenshot controls have nothing to act on.
// Inside the App Clip the scene is native-tracked and they come back.
function setArkitControls(quickLook) {
    ['size-up', 'size-down', 'replace-btn', 'screenshot-btn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = quickLook ? 'none' : '';
    });
    // The 🧲 shortcut only belongs to the Quick Look flow — inside the App
    // Clip shell (and on other devices) rel=ar links are unreliable
    const magnet = document.getElementById('wall-lock-btn');
    if (magnet) magnet.style.display = quickLook ? '' : 'none';
}

function updateDockButtons() { /* dock is static now: 🗑 removes the selected picture */ }

document.getElementById('replace-btn').addEventListener('click', () => {
    if (!selectedPlaced) {
        showStatus(placedArts.length
            ? 'Tap a picture to select it, then 🗑 removes it'
            : 'Hang artwork from the strip first');
        return;
    }
    removePicture(selectedPlaced);
    showStatus('Removed');
});

document.getElementById('clear-btn').addEventListener('click', () => {
    shareSheet.classList.remove('active');
    clearGallery();
    updateDockButtons();
    showStatus('Wall cleared');
});

document.getElementById('more-btn').addEventListener('click', () => {
    shareSheet.classList.add('active');
});

document.getElementById('tips-btn').addEventListener('click', () => {
    shareSheet.classList.remove('active');
    if (trackingMode === 'world') {
        showIntro(true, () => startCoachTour(true));
    } else {
        startCoachTour(true);
    }
});

// ------------------------------------------------------- walkthrough
// The scan -> set wall -> hang flow is new, so everyone (returning users
// included) sees the three-step card once; the version suffix lets a
// future flow change show it again.
const INTRO_KEY = 'arIntroV2';
let introDone = null;

function showIntro(force, done) {
    const el = document.getElementById('intro');
    if (!el) return;
    let seen = false;
    try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch (e) {}
    if (seen && !force) return;
    introDone = done || null;
    el.classList.remove('hidden');
}

function closeIntro() {
    const el = document.getElementById('intro');
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    try { localStorage.setItem(INTRO_KEY, '1'); } catch (e) {}
    const next = introDone;
    introDone = null;
    if (next) next();
}

document.getElementById('intro-go').addEventListener('click', () => {
    sfx.select();
    closeIntro();
});

document.getElementById('rescan-btn').addEventListener('click', () => {
    shareSheet.classList.remove('active');
    if (trackingMode === 'world') {
        resetWall();
    } else {
        showStatus('Re-scanning is available in world tracking mode');
    }
});

document.getElementById('diag-btn').addEventListener('click', () => {
    shareSheet.classList.remove('active');
    showDiagnostics();
});

document.getElementById('search-toggle').addEventListener('click', () => {
    searchPanel.classList.toggle('open');
});

const galleryToggle = document.getElementById('gallery-toggle');
galleryToggle.addEventListener('click', () => {
    artGallery.classList.remove('peek');
    artGallery.classList.toggle('open');
    galleryToggle.classList.toggle('active', artGallery.classList.contains('open'));
});

// After hanging, the strip drops to a sliver so the wall stays visible;
// swipe up on it (or tap it) to bring it back, swipe down to tuck it away
const stripSwipe = { y: 0 };
artGallery.addEventListener('touchstart', (e) => {
    stripSwipe.y = e.touches[0].clientY;
}, { passive: true });
artGallery.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - stripSwipe.y;
    if (dy > 26) artGallery.classList.add('peek');
    else if (dy < -26) artGallery.classList.remove('peek');
}, { passive: true });
artGallery.addEventListener('click', (e) => {
    if (artGallery.classList.contains('peek')) {
        e.stopPropagation();
        artGallery.classList.remove('peek');
    }
}, true);

document.getElementById('buy-btn').addEventListener('click', () => {
    shareSheet.classList.remove('active');
    openPurchaseLink();
});
document.getElementById('favorites-btn').addEventListener('click', () => openModal('favorites-modal'));
document.getElementById('templates-btn').addEventListener('click', () => {
    openModal('templates-modal');
    loadTemplates();
});

searchBtn.addEventListener('click', () => searchArt());
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchArt();
});

document.getElementById('apply-template-btn').addEventListener('click', applyTemplate);

document.addEventListener('click', (e) => {
    const linksSheet = document.getElementById('links-sheet');
    if (linksSheet && !linksSheet.contains(e.target) && e.target.id !== 'buy-btn') {
        linksSheet.classList.remove('active');
    }
    if (!shareSheet.contains(e.target) && e.target.id !== 'more-btn') {
        shareSheet.classList.remove('active');
    }
});

// Pure three.js Universal AR bootstrap (the flavor with official App Clip
// support): our own renderer, Zappar's camera, no A-Frame in between. The
// scene lives in the page from load; the camera starts on user action.
galleryGroup = new THREE.Group();

function initThreeScene() {
    if (renderer || !window.ZapparThree) return;
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.id = 'ar-canvas';
    document.body.insertBefore(renderer.domElement, document.body.firstChild);
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    ZapparThree.glContextSet(renderer.getContext());
    zCamera = new ZapparThree.Camera();
    zCamera.rearCameraMirrorMode = ZapparThree.CameraMirrorMode.None;
    scene = new THREE.Scene();
    scene.background = zCamera.backgroundTexture;

    const loop = () => {
        requestAnimationFrame(loop);
        if (!arStarted) return;
        zCamera.updateFrame(renderer);
        if (instantTracker && instantPlacement) {
            instantTracker.setAnchorPoseFromCameraOffset(0, 0, -INSTANT_DEPTH);
        }
        frameCallbacks.forEach((cb) => { try { cb(); } catch (e) {} });
        if (placedArts.length) sampleRoomLight();
        renderer.render(scene, zCamera);
    };
    requestAnimationFrame(loop);
}
initThreeScene();

function ensureInstantTracking() {
    if (instantGroup) return;
    instantTracker = new ZapparThree.InstantWorldTracker();
    instantGroup = new ZapparThree.InstantWorldAnchorGroup(zCamera, instantTracker);
    scene.add(instantGroup);
}

function getZapparCamera() {
    return zCamera;
}

function setPlacing(active) {
    document.getElementById('ui-overlay').classList.toggle('placing', active);
}

// ------------------------------------------------------------ walls
// Zappar's browser tracker only detects horizontal planes (vertical plane
// detection exists solely behind the native App Clip bridge), so in the
// browser a wall is defined from the floor: the user aims where the wall
// meets the floor and taps, and a wall rises from that line, upright and
// facing them. Where native wall planes exist they are used directly.
// The wall is stored relative to a tracked anchor (the ground anchor or
// the wall plane) and the art lives on the wall surface, so it rides the
// tracker's map corrections instead of floating at a guessed depth.
const wall = {
    tracker: null,
    ui: null,
    group: null,          // posed each frame: X along the wall, Y up, Z out of the wall
    ghost: null,
    baseLine: null,
    reticle: null,
    phase: 'scan',        // 'scan' -> 'wall' -> 'hang'
    ref: null,            // { kind: 'ground' } | { kind: 'plane', id }
    local: new THREE.Matrix4(),
    preview: null,        // { world, ref, fromFloor } while choosing a wall
    fromFloor: false,
    hintKey: ''
};
const INSTANT_DEPTH = 2.5;

function isTracking(status) {
    return status === ZapparThree.AnchorStatus.ANCHOR_STATUS_TRACKING;
}

function refPose(ref, out) {
    const t = wall.tracker;
    if (!t || !ref) return false;
    if (ref.kind === 'ground') {
        if (!isTracking(t.groundAnchor.status)) return false;
        out.fromArray(t.groundAnchor.pose(zCamera.rawPose, false));
        return true;
    }
    const p = t.planes.get(ref.id);
    if (!p || !isTracking(p.status)) return false;
    out.fromArray(p.pose(zCamera.rawPose, false));
    return true;
}

function worldUp() {
    const t = wall.tracker;
    const m = new THREE.Matrix4();
    if (t && isTracking(t.groundAnchor.status)) {
        m.fromArray(t.groundAnchor.pose(zCamera.rawPose, false));
        return new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
    }
    if (t && isTracking(t.worldAnchor.status)) {
        m.fromArray(t.worldAnchor.pose(zCamera.rawPose, false));
        return new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
    }
    return new THREE.Vector3(0, 1, 0);
}

function aimRay() {
    zCamera.updateMatrixWorld();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), zCamera);
    return raycaster.ray;
}

// Floor = the ground anchor when tracked, else the lowest horizontal plane
function floorEstimate(up) {
    const t = wall.tracker;
    const m = new THREE.Matrix4();
    if (isTracking(t.groundAnchor.status)) {
        m.fromArray(t.groundAnchor.pose(zCamera.rawPose, false));
        return { point: new THREE.Vector3().setFromMatrixPosition(m), ref: { kind: 'ground' } };
    }
    let best = null;
    for (const p of t.planes.values()) {
        if (!isTracking(p.status)) continue;
        m.fromArray(p.pose(zCamera.rawPose, false));
        const n = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
        if (Math.abs(n.dot(up)) < 0.85) continue;
        const point = new THREE.Vector3().setFromMatrixPosition(m);
        const h = point.dot(up);
        if (!best || h < best.h) best = { h, point, ref: { kind: 'plane', id: p.id } };
    }
    return best;
}

function wallMatrix(origin, normal, up) {
    const n = normal.clone().normalize();
    const y = up.clone().addScaledVector(n, -up.dot(n)).normalize();
    const x = new THREE.Vector3().crossVectors(y, n).normalize();
    return new THREE.Matrix4().makeBasis(x, y, n).setPosition(origin);
}

// Where would the wall be if the user tapped now?
function previewWall() {
    const t = wall.tracker;
    const ray = aimRay();
    const up = worldUp();
    const toCam = ray.origin;
    const m = new THREE.Matrix4();
    const inv = new THREE.Matrix4();

    // Native wall planes (App Clip): hang straight on the detected wall
    let best = null;
    for (const p of t.planes.values()) {
        if (!isTracking(p.status)) continue;
        m.fromArray(p.pose(zCamera.rawPose, false));
        const n = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
        if (Math.abs(n.dot(up)) > 0.3) continue;
        const p0 = new THREE.Vector3().setFromMatrixPosition(m);
        const denom = ray.direction.dot(n);
        if (Math.abs(denom) < 0.15) continue;
        const dist = p0.clone().sub(ray.origin).dot(n) / denom;
        if (dist < 0.3 || dist > 8) continue;
        const hit = ray.origin.clone().addScaledVector(ray.direction, dist);
        // Accept hits within the detected patch, generously extended
        const local = hit.clone().applyMatrix4(inv.copy(m).invert());
        const poly = p.polygon;
        if (poly && poly.length >= 6) {
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (let i = 0; i < poly.length; i += 2) {
                minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i]);
                minZ = Math.min(minZ, poly[i + 1]); maxZ = Math.max(maxZ, poly[i + 1]);
            }
            const pad = 0.75;
            if (local.x < minX - pad || local.x > maxX + pad || local.z < minZ - pad || local.z > maxZ + pad) continue;
        }
        if (!best || dist < best.dist) best = { dist, hit, n, id: p.id };
    }
    if (best) {
        const n = best.n.clone();
        if (n.dot(toCam.clone().sub(best.hit)) < 0) n.negate();
        return { world: wallMatrix(best.hit, n, up), ref: { kind: 'plane', id: best.id }, fromFloor: false };
    }

    // Browser: raise the wall from where the aim ray meets the floor
    const floor = floorEstimate(up);
    if (!floor) return null;
    const denom = ray.direction.dot(up);
    if (denom > -0.08) return null;
    const dist = floor.point.clone().sub(ray.origin).dot(up) / denom;
    if (dist < 0.3 || dist > 10) return null;
    const hit = ray.origin.clone().addScaledVector(ray.direction, dist);
    const n = toCam.clone().sub(hit);
    n.addScaledVector(up, -n.dot(up));
    if (n.length() < 0.15) return null;
    return { world: wallMatrix(hit, n, up), ref: floor.ref, fromFloor: true };
}

function poseWallGroup(world) {
    world.decompose(wall.group.position, wall.group.quaternion, wall.group.scale);
    wall.group.updateMatrixWorld(true);
}

// Aim point on the committed wall, in wall-local coordinates
function wallAimLocal() {
    const ray = aimRay();
    const n = new THREE.Vector3().setFromMatrixColumn(wall.group.matrixWorld, 2).normalize();
    const p0 = new THREE.Vector3().setFromMatrixPosition(wall.group.matrixWorld);
    const denom = ray.direction.dot(n);
    if (denom > -0.05) return null;
    const dist = p0.clone().sub(ray.origin).dot(n) / denom;
    if (dist < 0.2 || dist > 10) return null;
    return wall.group.worldToLocal(ray.origin.clone().addScaledVector(ray.direction, dist));
}

// Point on the wall straight in front of the user, at their eye height
function wallFrontLocal() {
    zCamera.updateMatrixWorld();
    const cam = new THREE.Vector3().setFromMatrixPosition(zCamera.matrixWorld);
    const local = wall.group.worldToLocal(cam);
    return new THREE.Vector3(local.x, wall.fromFloor ? Math.max(local.y, 1.2) : local.y, 0);
}

function buildWallVisuals() {
    const gold = 0xd4af37;
    wall.group = new THREE.Group();
    wall.ghost = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 2.6),
        new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide })
    );
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(wall.ghost.geometry),
        new THREE.LineBasicMaterial({ color: gold, transparent: true, opacity: 0.55 })
    );
    wall.ghost.add(edges);
    wall.baseLine = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 0.025),
        new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide })
    );
    wall.baseLine.position.set(0, 0.0125, 0.002);
    wall.reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.06, 0.078, 48),
        new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
    );
    wall.reticle.position.z = 0.004;
    wall.group.add(wall.ghost, wall.baseLine, wall.reticle);
    wall.group.visible = false;
    scene.add(wall.group);
}

function wallHint(key, text) {
    if (wall.hintKey === key) return;
    wall.hintKey = key;
    setHint(text);
}

function enterWallPhase() {
    wall.phase = 'wall';
    wall.hintKey = '';
    try { wall.ui.hide(); } catch (e) {}
    document.getElementById('skip-scan').classList.add('hidden');
    setPlacing(true);
    sfx.select();
    console.log('floor found; choosing wall. planes:', wall.tracker.planes.size);
}

function commitWall() {
    const pv = wall.preview;
    if (!pv) {
        showStatus('Aim at where the wall meets the floor, then tap');
        return;
    }
    const ref = new THREE.Matrix4();
    if (!refPose(pv.ref, ref)) {
        showStatus('Hold steady a moment, then tap again');
        return;
    }
    wall.ref = pv.ref;
    wall.fromFloor = pv.fromFloor;
    wall.local.copy(ref.invert().multiply(pv.world));
    wall.phase = 'hang';
    wall.ghost.visible = true;
    wall.baseLine.visible = false;
    setTimeout(() => { if (wall.phase === 'hang') wall.ghost.visible = false; }, 900);
    // Pointing at a plain wall drops tracking quality; Zappar's default
    // response is to wipe the map after 5s, which throws hung art around.
    // Keep the map — the user can re-scan from the menu if needed.
    wall.tracker.resetIfLimitedForMS = 0;
    anchored = true;
    setPlacing(false);
    sfx.anchor();
    setHint('Wall set — aim where you want it and tap a painting', 6000);
    console.log('wall committed', wall.ref, 'fromFloor:', wall.fromFloor);
}

function resetWall() {
    if (trackingMode !== 'world') return;
    clearGallery();
    wall.ref = null;
    wall.preview = null;
    anchored = false;
    try {
        if (wall.tracker.quality === ZapparThree.WorldTrackerQuality.WORLD_TRACKER_QUALITY_LIMITED) {
            wall.tracker.reset();
        }
    } catch (e) {}
    wall.tracker.resetIfLimitedForMS = 5000;
    wall.phase = 'scan';
    wall.hintKey = '';
    setPlacing(true);
    setHint('Re-scanning — pan slowly across the floor');
}

function worldFrame() {
    const t = wall.tracker;
    if (!t || trackingMode !== 'world') return;
    const quality = t.quality;
    const Q = ZapparThree.WorldTrackerQuality;

    if (wall.phase === 'scan') {
        wall.group.visible = false;
        try { wall.ui.show(); wall.ui.update(); } catch (e) {}
        if (quality !== Q.WORLD_TRACKER_QUALITY_INITIALIZING && floorEstimate(worldUp())) {
            enterWallPhase();
        }
        return;
    }

    if (wall.phase === 'wall') {
        wall.preview = previewWall();
        if (!wall.preview) {
            wall.group.visible = false;
            wallHint('down', 'Tilt down to where your wall meets the floor');
            return;
        }
        poseWallGroup(wall.preview.world);
        wall.group.visible = true;
        wall.ghost.visible = true;
        wall.ghost.position.set(0, wall.preview.fromFloor ? 1.3 : 0, 0);
        wall.baseLine.visible = wall.preview.fromFloor;
        wall.reticle.position.set(0, wall.preview.fromFloor ? 0.12 : 0, 0.004);
        wallHint(wall.preview.fromFloor ? 'base' : 'native',
            wall.preview.fromFloor
                ? 'Line up the gold edge with the bottom of your wall, then tap'
                : 'Wall found — tap to lock it');
        return;
    }

    // Hanging: the wall follows its anchor; the reticle marks the aim point
    const ref = new THREE.Matrix4();
    if (refPose(wall.ref, ref)) poseWallGroup(ref.multiply(wall.local));
    wall.group.visible = true;
    const aim = wallAimLocal();
    wall.reticle.visible = !!aim;
    if (aim) wall.reticle.position.set(aim.x, aim.y, 0.004);
}

function chooseTracking() {
    if (anchorNode) return;
    if (arkitMode && !isInAppClip()) {
        // Hanging happens in Apple's ARKit viewer, so the in-browser scene
        // is only the live camera backdrop: no tracker ladder, no anchoring
        trackingMode = 'arkit';
        ensureInstantTracking();
        anchorNode = instantGroup;
        anchorNode.add(galleryGroup);
        anchored = true;
        setArkitControls(true);
        setHint('Tap a painting — it hangs on your wall in Apple AR');
        clearTimeout(showHint._t);
        showHint._t = setTimeout(hideHint, 8000);
        console.log('tracking mode: arkit (Quick Look)');
        return;
    }
    setArkitControls(false);
    if (isInAppClip()) console.log('App Clip shell detected: native tracking feeds the scene');
    try { localStorage.removeItem('arWorldFailed'); } catch (e) {}

    try {
        wall.tracker = new ZapparThree.WorldTracker();
        wall.ui = new ZapparThree.WorldTrackerUI(renderer.domElement);
    } catch (e) {
        console.log('world tracker unavailable:', e && e.message);
        wall.tracker = null;
    }

    if (!wall.tracker) {
        startInstantMode('World tracking is unavailable here — using simple mode');
        return;
    }

    trackingMode = 'world';
    let verticalSupported = false;
    try { verticalSupported = wall.tracker.verticalPlaneDetectionSupported !== false; }
    catch (e) { verticalSupported = true; }
    try { wall.tracker.verticalPlaneDetectionEnabled = true; } catch (e) {}
    console.log('world tracking; native wall detection:', verticalSupported);

    buildWallVisuals();
    anchorNode = wall.group;
    anchorNode.add(galleryGroup);
    frameCallbacks.add(worldFrame);
    wall.tracker.onQualityLimited.bind(() => {
        if (wall.phase === 'hang') {
            setHint('Tracking is catching up — include some furniture or edges in view', 4000);
        }
    });

    setPlacing(true);
    setHint('Point at the floor near your wall and pan slowly');
    setTimeout(() => showIntro(false), 500);

    const skipBtn = document.getElementById('skip-scan');
    skipBtn.addEventListener('click', () => {
        if (wall.phase !== 'hang') startInstantMode('Simple mode — aim at your wall, then tap a painting');
    });
    const t0 = Date.now();
    const poll = setInterval(() => {
        if (trackingMode !== 'world' || wall.phase !== 'scan') {
            skipBtn.classList.add('hidden');
            if (trackingMode !== 'world' || wall.phase === 'hang') clearInterval(poll);
            return;
        }
        const elapsed = Date.now() - t0;
        if (elapsed > 10000) skipBtn.classList.remove('hidden');
        if (elapsed > 15000 && !poll._coached) {
            poll._coached = true;
            setHint('Still mapping — step back, include the floor and some furniture; more light helps');
        }
        if (elapsed > 45000) {
            clearInterval(poll);
            startInstantMode('Simple mode — aim at your wall, then tap a painting');
        }
    }, 500);
    console.log('tracking mode:', trackingMode);
}

// Fallback without a floor: Zappar's instant tracker. Hanging re-anchors at
// the aim point and the art sits exactly on that anchor (not in front of
// it), so what it tracks and what you see coincide.
function startInstantMode(message) {
    if (wall.tracker) {
        try { wall.tracker.enabled = false; } catch (e) {}
        try { wall.ui.hide(); } catch (e) {}
    }
    frameCallbacks.delete(worldFrame);
    closeIntro();
    if (wall.group) wall.group.visible = false;
    if (galleryGroup.parent) galleryGroup.parent.remove(galleryGroup);
    trackingMode = 'instant';
    ensureInstantTracking();
    instantTracker.enabled = true;
    instantPlacement = true;
    anchorNode = instantGroup;
    anchorNode.add(galleryGroup);
    anchored = true;
    setPlacing(false);
    document.getElementById('skip-scan').classList.add('hidden');
    setHint(message, 8000);
    console.log('tracking mode: instant');
}

async function initAR() {
    if (!window.ZapparThree || !renderer) {
        showStatus('AR engine failed to load. Check your connection and reload the page.');
        return;
    }
    if (!window.isSecureContext) {
        showStatus('AR needs a secure connection. Open this page over https://');
        return;
    }
    if (ZapparThree.browserIncompatible()) {
        ZapparThree.browserIncompatibleUI();
        return;
    }

    startScreen.classList.add('hidden');
    canvasContainer.classList.remove('hidden');
    setTimeout(startCoachTour, 1800);

    const heroVideo = document.getElementById('hero-video');
    if (heroVideo) heroVideo.pause();
    const amb = document.getElementById('ambience');
    if (amb) fadeAudio(amb, 0, 2500, () => amb.pause());

    if (cameraPaused) {
        try { zCamera.start(false); } catch (e) { try { zCamera.start(); } catch (e2) {} }
        cameraPaused = false;
    }

    if (!gesturesWired) {
        gesturesWired = true;

        // Camera permission, then camera, then trackers — all ours now
        let granted = true;
        try {
            granted = await ZapparThree.permissionRequestUI();
        } catch (e) { console.log('permission UI error:', e && e.message); }
        if (!granted) {
            try { ZapparThree.permissionDeniedUI(); } catch (e) {}
            showStatus('Camera access is needed to hang art on your wall');
            return;
        }
        try { zCamera.start(false); } catch (e) { try { zCamera.start(); } catch (e2) {} }
        arStarted = true;

        chooseTracking();
        setupGestures(renderer.domElement);
        if (trackingMode !== 'world') showHint();
        let checks = 0;
        const watchdog = setInterval(() => {
            checks++;
            let frames = 0;
            try { frames = zCamera.pipeline.frameNumber(); } catch (e) {}
            if (frames > 0) {
                clearInterval(watchdog);
                console.log('camera feed rendering after', checks, 's');
            } else if (checks >= 8) {
                clearInterval(watchdog);
                console.error('camera frames never arrived');
                showStatus('Camera feed is not rendering. Reload the page — if it persists, add ?debug=1 to the address and send a screenshot.');
            }
        }, 1000);
    }

    if (artworks.length === 0) {
        await searchArt('');
    }
}

// Tap empty space hangs the selected artwork where you aim; tap a hung
// picture to select it; drag moves that picture, pinch resizes it
const touchState = {
    mode: null,
    lastX: 0,
    lastY: 0,
    moved: false,
    startDist: 0,
    startScale: 1,
    target: null
};

const raycaster = new THREE.Raycaster();

function pictureAt(clientX, clientY) {
    if (placedArts.length === 0) return null;
    const ndc = new THREE.Vector2(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1
    );
    galleryGroup.updateMatrixWorld(true);
    raycaster.setFromCamera(ndc, zCamera);
    const hits = raycaster.intersectObjects(placedArts, true);
    if (hits.length === 0) return null;
    let o = hits[0].object;
    while (o && !o.userData.art) o = o.parent;
    return o;
}

function setupGestures(canvas) {
    const touchDistance = (touches) => Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
    );

    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            touchState.mode = 'drag';
            touchState.lastX = e.touches[0].clientX;
            touchState.lastY = e.touches[0].clientY;
            touchState.moved = false;
            touchState.target = pictureAt(e.touches[0].clientX, e.touches[0].clientY);
        } else if (e.touches.length === 2) {
            touchState.mode = 'pinch';
            touchState.startDist = touchDistance(e.touches);
            touchState.target = touchState.target || selectedPlaced;
            touchState.startScale = touchState.target ? touchState.target.userData.scale : 1;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();

        const dragTarget = touchState.target || selectedPlaced;
        if (touchState.mode === 'drag' && e.touches.length === 1 && dragTarget) {
            const dx = e.touches[0].clientX - touchState.lastX;
            const dy = e.touches[0].clientY - touchState.lastY;
            touchState.lastX = e.touches[0].clientX;
            touchState.lastY = e.touches[0].clientY;

            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) touchState.moved = true;
            dragPicture(dragTarget, dx, dy);
        } else if (touchState.mode === 'pinch' && e.touches.length === 2 && dragTarget) {
            touchState.moved = true;
            const ratio = touchDistance(e.touches) / touchState.startDist;
            const next = Math.min(10, Math.max(0.1, touchState.startScale * ratio));
            dragTarget.userData.scale = next;
            dragTarget.scale.set(next, next, 1);
            updateMeasurement();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) {
            if (touchState.mode === 'drag' && !touchState.moved) {
                onTap(touchState.target);
            }
            touchState.mode = null;
            touchState.target = null;
        }
    });

    // Desktop browsers (Zappar supports webcam preview for quick testing)
    if (!('ontouchstart' in window)) {
        canvas.addEventListener('click', (e) => onTap(pictureAt(e.clientX, e.clientY)));
    }
}

function hasArt() {
    return placedArts.length > 0;
}

// Pose at the point the camera is aiming at, expressed in anchor-local space
// and kept upright relative to the tracked world (anchor Y ~ gravity up)
function aimPoseInAnchor(distance) {
    const cam = zCamera;
    cam.updateMatrixWorld();
    anchorNode.updateMatrixWorld();

    const inv = new THREE.Matrix4().copy(anchorNode.matrixWorld).invert();
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).applyMatrix4(inv);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld)
        .transformDirection(inv).normalize();

    const pos = camPos.clone().addScaledVector(dir, distance || 2);
    const yaw = Math.atan2(camPos.x - pos.x, camPos.z - pos.z);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    return { pos, quat };
}

function dragPicture(mesh, dx, dy) {
    // Convert screen pixels to world units at the picture's depth, moving in
    // the camera's view plane, then express that delta in anchor-local space
    const cam = zCamera;
    const camWorld = new THREE.Vector3();
    cam.getWorldPosition(camWorld);
    const meshWorld = new THREE.Vector3();
    mesh.getWorldPosition(meshWorld);

    const depth = meshWorld.distanceTo(camWorld) || 3;
    // Zappar's camera carries no fov property; read the vertical half-angle
    // straight from its projection matrix (m[5] = cot(fovY / 2))
    const halfFov = Math.atan(1 / (cam.projectionMatrix.elements[5] || 1));
    const worldPerPixel = (2 * depth * Math.tan(halfFov)) / window.innerHeight;

    const delta = new THREE.Vector3()
        .setFromMatrixColumn(cam.matrixWorld, 0)
        .multiplyScalar(dx * worldPerPixel)
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1), -dy * worldPerPixel);

    const anchorQuat = new THREE.Quaternion();
    anchorNode.getWorldQuaternion(anchorQuat);
    delta.applyQuaternion(anchorQuat.invert());
    if (trackingMode === 'world') delta.z = 0;

    mesh.position.add(delta);
}

function setSelectedPicture(mesh) {
    if (selectedPlaced && selectedPlaced.userData.frame) {
        selectedPlaced.userData.selected = false;
        applyRoomLight(selectedPlaced);
    }
    selectedPlaced = mesh;
    if (mesh && mesh.userData.frame) {
        mesh.userData.selected = true;
        applyRoomLight(mesh);
    }
    if (measurementMode) updateMeasurement();
}

function removePicture(mesh) {
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.userData.frame) {
        mesh.userData.frame.geometry.dispose();
        [].concat(mesh.userData.frame.material).forEach((m) => m.dispose());
    }
    mesh.geometry.dispose();
    if (mesh.material.map) mesh.material.map.dispose();
    mesh.material.dispose();
    placedArts = placedArts.filter(m => m !== mesh);
    if (selectedPlaced === mesh) selectedPlaced = null;
    if (placedArts.length === 0) endPhotoFlow();
    updateDockButtons();
}

function onTap(target) {
    if (trackingMode === 'world' && wall.phase !== 'hang') {
        if (wall.phase === 'wall') commitWall();
        return;
    }

    if (target) {
        setSelectedPicture(target);
        sfx.select();
        showStatus(`Selected: ${target.userData.art.title}`);
        return;
    }

    // Empty space never hangs art any more (hanging happens from the strip);
    // it just clears the selection
    if (selectedPlaced) {
        setSelectedPicture(null);
    }
}

function clearGallery() {
    placedArts.slice().forEach(removePicture);
}

// Tries the sharper 2000px copy first, falling back to the strip's image
function loadArtTexture(art, onLoad) {
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    const hi = window.FrameArt ? FrameArt.hiResUrl(art.imageUrl) : art.imageUrl;
    const fail = (error) => {
        console.error('Error loading texture:', error);
        showStatus('Error loading artwork image');
    };
    loader.load(hi, onLoad, undefined, () => {
        if (hi === art.imageUrl) return fail('image unavailable');
        loader.load(art.imageUrl, onLoad, undefined, fail);
    });
}

// The frame's physical thickness: the painted face sits on a box this deep,
// so the moulding's outer edge shows when the piece is seen from an angle
const FRAME_DEPTH = 0.03;
// Outer edge shades per box face: +X, -X, +Y, -Y, +Z (hidden), -Z (wall side)
const FRAME_EDGES = [0x5c451a, 0x7d6127, 0x8f702e, 0x4a3814, 0x6b5120, 0x3a2b0f];

function makeArtMesh(texture, width, art) {
    const img = texture.image;
    const height = width * (img.height / img.width);
    const maxTex = (renderer && renderer.capabilities.maxTextureSize) || 2048;
    const painted = FrameArt.paint(img, width, height, { maxPx: Math.min(2048, maxTex) });
    texture.dispose();

    const map = new THREE.CanvasTexture(painted.canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    if (renderer) map.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(painted.totalW, painted.totalH),
        new THREE.MeshBasicMaterial({ map })
    );

    const frame = new THREE.Mesh(
        new THREE.BoxGeometry(painted.totalW, painted.totalH, FRAME_DEPTH),
        FRAME_EDGES.map((c) => new THREE.MeshBasicMaterial({
            color: c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
        }))
    );
    frame.position.z = -FRAME_DEPTH / 2 - 0.001;
    mesh.add(frame);

    mesh.userData = {
        originalWidth: width, originalHeight: height,
        totalWidth: painted.totalW, totalHeight: painted.totalH,
        art, scale: 1, frame, selected: false
    };
    applyRoomLight(mesh);
    return mesh;
}

// ------------------------------------------------------- room lighting
// Every ~0.4s the camera feed is drawn into a 16x16 target and averaged:
// its brightness dims the art in darker rooms and its colour cast (warm
// lamps, cool daylight) tints it, so the piece sits in the room's light.
const roomLight = {
    color: new THREE.Color(1, 1, 1),
    level: 1,
    target: null, scene: null, cam: null, buf: null, last: 0, logged: 0
};

function sampleRoomLight() {
    const now = performance.now();
    if (now - roomLight.last < 400) return;
    roomLight.last = now;
    try {
        if (!roomLight.target) {
            roomLight.target = new THREE.WebGLRenderTarget(16, 16);
            roomLight.scene = new THREE.Scene();
            roomLight.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            roomLight.scene.add(new THREE.Mesh(
                new THREE.PlaneGeometry(2, 2),
                new THREE.MeshBasicMaterial({ map: zCamera.backgroundTexture })
            ));
            roomLight.buf = new Uint8Array(16 * 16 * 4);
        }
        renderer.setRenderTarget(roomLight.target);
        renderer.render(roomLight.scene, roomLight.cam);
        renderer.setRenderTarget(null);
        renderer.readRenderTargetPixels(roomLight.target, 0, 0, 16, 16, roomLight.buf);
    } catch (e) {
        renderer.setRenderTarget(null);
        return;
    }
    let r = 0, g = 0, b = 0;
    const px = roomLight.buf.length / 4;
    for (let i = 0; i < roomLight.buf.length; i += 4) {
        r += roomLight.buf[i]; g += roomLight.buf[i + 1]; b += roomLight.buf[i + 2];
    }
    r /= px * 255; g /= px * 255; b /= px * 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 0.003) return; // no camera frame yet
    const avg = (r + g + b) / 3;
    // Grey-world colour cast, blended 40% and capped at ±12% per channel:
    // enough to pick up warm lamps or cool daylight, but a strongly
    // coloured wall must never repaint the artwork
    const cast = (c) => Math.min(1.12, Math.max(0.88, 1 + 0.4 * (c / avg - 1)));
    const tint = new THREE.Color(cast(r), cast(g), cast(b));
    const tLum = 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b;
    tint.multiplyScalar(1 / tLum);
    const level = Math.min(1, Math.max(0.55, 0.55 + 0.5 * Math.sqrt(lum / 0.2)));
    roomLight.color.lerp(tint, 0.25);
    roomLight.level += (level - roomLight.level) * 0.25;
    placedArts.forEach(applyRoomLight);
    if (now - roomLight.logged > 5000) {
        roomLight.logged = now;
        console.log('room light: lum', lum.toFixed(3), 'level', roomLight.level.toFixed(2),
            'tint', roomLight.color.r.toFixed(2), roomLight.color.g.toFixed(2), roomLight.color.b.toFixed(2));
    }
}

function applyRoomLight(mesh) {
    const k = roomLight.level;
    const c = roomLight.color;
    const clamp = (v) => Math.min(1, v);
    mesh.material.color.setRGB(clamp(c.r * k), clamp(c.g * k), clamp(c.b * k));
    const f = mesh.userData.frame;
    if (f) {
        // A selected piece's frame edge catches a little more light
        const lift = mesh.userData.selected ? 1.25 : 1;
        f.material.forEach((m, i) => {
            const base = new THREE.Color(FRAME_EDGES[i]);
            m.color.setRGB(clamp(base.r * c.r * k * lift), clamp(base.g * c.g * k * lift), clamp(base.b * c.b * k * lift));
        });
    }
}

function placeArtwork() {
    if (!selectedArt) {
        showStatus('Select an artwork from the strip first');
        return;
    }
    if (trackingMode === 'arkit') {
        openInARKit(selectedArt);
        return;
    }

    const placingArt = selectedArt;
    let pose;
    if (trackingMode === 'world') {
        if (wall.phase !== 'hang') {
            showStatus('Set your wall first — aim where it meets the floor and tap');
            return;
        }
        // On the wall surface at the aim point, upright (wall-local XY)
        const spot = wallAimLocal() || wallFrontLocal();
        // The frame's back rests on the wall
        pose = { pos: new THREE.Vector3(spot.x, spot.y, FRAME_DEPTH + 0.002), quat: new THREE.Quaternion() };
    } else if (trackingMode === 'instant') {
        instantTracker.setAnchorPoseFromCameraOffset(0, 0, -INSTANT_DEPTH);
        instantPlacement = false;
        anchored = true;
        pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    } else {
        pose = aimPoseInAnchor(2);
    }
    loadArtTexture(placingArt, (texture) => {
        // One piece at a time: web AR holds a single fixture well, a crowd
        // poorly — the flow is hang, photograph, then try the next one
        clearGallery();
        const mesh = makeArtMesh(texture, ArtCatalog.hangWidthM(placingArt, 1), placingArt);
        mesh.position.copy(pose.pos);
        mesh.quaternion.copy(pose.quat);
        // Never let a floor-based wall hang the piece into the floor
        if (trackingMode === 'world' && wall.fromFloor) {
            mesh.position.y = Math.max(mesh.position.y, mesh.userData.totalHeight / 2 + 0.15);
        }
        galleryGroup.add(mesh);
        placedArts.push(mesh);
        setSelectedPicture(mesh);
        updateDockButtons();

        sfx.hang();
        hideHint();
        artGallery.classList.add('peek');
        showStatus(`Hung: ${placingArt.title} — drag to fine-tune`);
        promptForPhoto();
        if (measurementMode) updateMeasurement();
    });
}

// Guided flow: once a piece has hung for a moment, nudge toward a photo;
// after the photo, invite the next painting or a fresh wall
function promptForPhoto() {
    clearTimeout(promptForPhoto._t);
    promptForPhoto._t = setTimeout(() => {
        if (!placedArts.length) return;
        setHint('Happy with it? Tap 📸 to keep a photo', 6000);
        document.getElementById('screenshot-btn').classList.add('pulse');
    }, 3500);
}

function promptForNextPiece() {
    document.getElementById('screenshot-btn').classList.remove('pulse');
    if (!placedArts.length) return;
    setTimeout(() => {
        if (!placedArts.length) return;
        setHint('Beautiful. Try another painting — or point at a new wall', 7000);
        artGallery.classList.remove('peek');
        artGallery.classList.add('open');
        document.getElementById('gallery-toggle').classList.add('active');
    }, 1200);
}

function endPhotoFlow() {
    clearTimeout(promptForPhoto._t);
    document.getElementById('screenshot-btn').classList.remove('pulse');
    setHint(null);
}

// First-run tour of the interface — every icon in one tap-through pass,
// dismissible at any step and replayable from the ⋯ menu
function startCoachTour(force) {
    if (!window.CoachMarks) return;
    if (force !== true && CoachMarks._seen()) return;
    // Wait for the interface to actually be on screen — the dock and strip
    // can be hidden while the tracker is still scanning
    const ready = () => {
        const dock = document.getElementById('bottom-dock');
        const strip = document.getElementById('art-gallery');
        return dock && dock.getBoundingClientRect().width > 0 &&
            strip && strip.getBoundingClientRect().height > 0;
    };
    let tries = 0;
    clearInterval(startCoachTour._p);
    const tick = () => {
        // While the user is still scanning or setting the wall the dock is
        // meant to be hidden, so wait it out rather than timing out into a
        // half-empty tour; the walkthrough card must be closed too
        const settingUp = trackingMode === 'world' && wall.phase !== 'hang';
        const introOpen = !document.getElementById('intro').classList.contains('hidden');
        if (settingUp || introOpen) return false;
        if (!ready() && ++tries < 60) return false;
        clearInterval(startCoachTour._p);
        runCoachTour(force);
        return true;
    };
    if (tick()) return;
    startCoachTour._p = setInterval(tick, 500);
}

function runCoachTour(force) {
    const steps = [
        { id: 'art-gallery', title: 'The collection', text: 'Tap any painting to hang it on your wall.' + (trackingMode === 'arkit' ? ' It opens in Apple AR with true wall tracking.' : '') },
        { id: 'gallery-toggle', title: 'Artworks', text: 'Show or hide the collection strip.' },
        { id: 'search-toggle', title: 'Search', text: 'Find paintings across museums, modern art and photography.' },
        { id: 'favorites-btn', title: 'Favorites', text: 'Pieces you ♡ are saved here.' },
        { id: 'size-up', title: 'Size', text: '➖ and ➕ resize the hung piece.' },
        { id: 'replace-btn', title: 'Remove', text: 'Takes the selected piece off the wall.' },
        { id: 'screenshot-btn', title: 'Photo', text: 'Saves a picture of your wall with the art in place.' },
        { id: 'wall-lock-btn', title: 'Apple AR', text: 'Re-opens the current piece with ARKit wall tracking.' },
        { id: 'more-btn', title: 'More', text: 'Sharing, measurements, and Re-set wall if you move rooms.' },
        { id: 'exit-ar-btn', title: 'Exit', text: 'Back to the menu.' }
    ];
    CoachMarks.start(steps, { force: force === true });
}

// ------------------------------------------------------------ ARKit flow
async function openInARKit(art) {
    const sel = activePicture();
    const widthM = sel ? sel.userData.originalWidth * sel.userData.scale : ArtCatalog.hangWidthM(art, 0.8);
    showStatus('Opening on your wall…');
    qlOpenedAt = Date.now();
    try {
        await ARKitQuickLook.view(art, widthM, {
            onAction: () => { qlOpenedAt = Date.now() - 5000; onQuickLookReturn(); }
        });
        setHint('Point at your wall to place it — the shutter saves a photo');
    } catch (err) {
        qlOpenedAt = 0;
        console.error('Quick Look error:', err);
        showStatus('Could not open Apple AR for this artwork');
    }
}

// Quick Look fully covers the page; when it closes we land back here and
// invite the next piece — the photo was taken with Apple's own shutter
function onQuickLookReturn() {
    if (!qlOpenedAt) return;
    if (Date.now() - qlOpenedAt < 3000) return; // ignore the opening transition
    qlOpenedAt = 0;
    setHint('Beautiful. Try another painting — or a different wall', 7000);
    artGallery.classList.remove('peek');
    artGallery.classList.add('open');
    document.getElementById('gallery-toggle').classList.add('active');
}
if (arkitMode) {
    const backFromQuickLook = () => { if (!document.hidden) onQuickLookReturn(); };
    document.addEventListener('visibilitychange', backFromQuickLook);
    window.addEventListener('focus', backFromQuickLook);
}

function buildTemplate(template) {
    const pieces = artworks.slice(0, template.artworks);
    if (pieces.length === 0) {
        showStatus('Search for artworks first, then apply a template');
        return;
    }

    const w = template.layout === 'center' ? 1.2 : 0.7;
    const spacing = template.spacing;
    const pose = aimPoseInAnchor(2.2);
    let placedCount = 0;

    pieces.forEach((art, i) => {
        loadArtTexture(art, (texture) => {
            const mesh = makeArtMesh(texture, w, art);

            const offset = new THREE.Vector3();
            if (template.layout === 'horizontal' || template.layout === 'triptych') {
                offset.x = (i - (pieces.length - 1) / 2) * (w + spacing);
            } else if (template.layout === 'grid') {
                const cols = Math.ceil(pieces.length / 2);
                const col = i % cols;
                const row = Math.floor(i / cols);
                offset.x = (col - (cols - 1) / 2) * (w + spacing);
                offset.y = row === 0 ? (0.45 + spacing) : -(0.45 + spacing) / 2;
            }
            // 'center' stays at the aim point

            mesh.position.copy(pose.pos).add(offset.applyQuaternion(pose.quat));
            mesh.quaternion.copy(pose.quat);
            galleryGroup.add(mesh);
            placedArts.push(mesh);
            placedCount++;
            if (placedCount === pieces.length) {
                updateDockButtons();
                showStatus(`${template.name} hung on this wall!`);
            }
        });
    });
}

// Results come from the shipped catalogue (thousands of works, searched on
// the device), topped up with a live Wikimedia search when a query finds
// little, and shown in the strip a page at a time
const PAGE_SIZE = 24;
let resultSet = [];
let resultTotal = 0;

function matchesQuery(q) {
    const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return (art) => {
        const hay = `${art.title} ${art.artist} ${art.medium || ''}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
    };
}

async function searchCommons(searchQuery) {
    // Wikimedia Commons: reliable hotlinking with CORS headers, which WebGL
    // textures require
    const api = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
        `&gsrsearch=${encodeURIComponent(searchQuery + ' painting')}&gsrnamespace=6&gsrlimit=18` +
        '&prop=imageinfo&iiprop=url%7Cmime%7Cextmetadata&iiurlwidth=1000&format=json&origin=*';
    const response = await fetch(api);
    const data = await response.json();
    const strip = (f) => f && f.value ? f.value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    // Some Commons titles carry raw Wikidata qualifiers
    // ('… title QS:P1476,en:"…" label QS:Len,…'); keep the English
    // title when one is quoted, otherwise fall back to the filename
    const cleanTitle = (t) => {
        if (!t || !/QS:/.test(t)) return t || '';
        const m = t.match(/en:"([^"]+)"/);
        return m ? m[1] : '';
    };
    return Object.values((data.query && data.query.pages) || {})
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map(p => ({ page: p, info: (p.imageinfo || [])[0] }))
        .filter(x => x.info && x.info.thumburl && /^image\/(jpeg|png)/.test(x.info.mime || ''))
        .map(({ page, info }) => {
            const meta = info.extmetadata || {};
            const fallbackTitle = page.title.replace(/^File:/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
            const art = {
                id: 'commons-' + page.pageid,
                title: cleanTitle(strip(meta.ObjectName)) || fallbackTitle,
                artist: strip(meta.Artist) || 'Unknown artist',
                date: strip(meta.DateTimeOriginal),
                imageUrl: info.thumburl,
                thumbnailUrl: info.thumburl.includes('/1000px-')
                    ? info.thumburl.replace('/1000px-', '/320px-')
                    : info.thumburl,
                source: 'Wikimedia Commons',
                museumUrl: info.descriptionurl,
                tags: []
            };
            art.printUrl = ArtCatalog.printUrl(art);
            return art;
        });
}

async function searchArt(query = null) {
    const searchQuery = (query !== null ? String(query) : searchInput.value).trim();
    showStatus('Searching artworks...');

    try {
        let items = [];
        let total = 0;
        let note = '';

        if (currentSource === 'museum') {
            try {
                const r = await ArtCatalog.search(searchQuery, { kind: 'painting' });
                items = r.items;
                total = r.total;
            } catch (e) {
                console.log('catalogue unavailable:', e && e.message);
            }
            if (searchQuery && items.length < 12) {
                try {
                    const live = (await searchCommons(searchQuery)).filter(l => !items.some(i => i.id === l.id));
                    items = items.concat(live);
                    total += live.length;
                } catch (e) {
                    console.log('live search unavailable:', e && e.message);
                }
            }
        } else if (currentSource === 'photography') {
            const curated = curatedCollection('photography', 'Photography Collection').filter(matchesQuery(searchQuery));
            let cat = { items: [], total: 0 };
            try { cat = await ArtCatalog.search(searchQuery, { kind: 'photo' }); } catch (e) {}
            items = curated.concat(cat.items);
            total = curated.length + cat.total;
        } else if (currentSource === 'modern') {
            items = curatedCollection('modern', 'Modern Collection').filter(matchesQuery(searchQuery));
            total = items.length;
        } else if (currentSource === 'forsale') {
            const r = await ArtCatalog.forSale(searchQuery);
            items = r.items;
            total = r.total;
            if (!r.galleryCount) note = 'No galleries listed yet — see catalog/galleries.json to add one';
        }

        resultSet = items;
        resultTotal = total;
        artworks = [];
        showMoreResults();
        artGallery.scrollLeft = 0;
        artGallery.classList.remove('peek');
        artGallery.classList.add('open');
        document.getElementById('gallery-toggle').classList.add('active');
        searchPanel.classList.remove('open');

        if (artworks.length === 0) {
            showStatus(note || 'No artworks found. Try a different search.');
        } else {
            const what = currentSource === 'forsale' ? 'for sale' : 'works';
            showStatus(`${total.toLocaleString()} ${what}${searchQuery ? ` for “${searchQuery}”` : ''}`);
        }
    } catch (error) {
        console.error('Search error:', error);
        showStatus('Error searching artworks. Please try again.');
    }
}

function showMoreResults() {
    const next = resultSet.slice(artworks.length, artworks.length + PAGE_SIZE);
    artworks = artworks.concat(next);
    displayArtGallery();
}

function priceLabel(art) {
    if (!art.price) return '';
    return /^[\d.,]+$/.test(String(art.price)) ? `$${art.price}` : art.price;
}

function displayArtGallery() {
    artGallery.innerHTML = '';

    const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    artworks.forEach((art, index) => {
        const isFavorite = favorites.some(f => f.id === art.id);

        const artItem = document.createElement('div');
        artItem.className = 'art-item';
        if (index === 0 && !selectedArt) {
            artItem.classList.add('selected');
            selectedArt = art;
        }

        artItem.innerHTML = `
            <div class="favorite-btn ${isFavorite ? 'active' : ''}" onclick="toggleFavorite(event, ${index})">
                ${isFavorite ? '❤️' : '🤍'}
            </div>
            ${art.price ? `<div class="buy-badge">${esc(priceLabel(art))}</div>` : ''}
            <img crossorigin="anonymous" loading="lazy" src="${esc(art.thumbnailUrl)}" alt="${esc(art.title)}" onerror="this.src='assets/brand/art-placeholder.jpg'">
            <div class="art-item-title" title="${esc(art.title)} — ${esc(art.artist)}">${esc(art.title)}<span class="art-item-artist">${esc(art.artist)}</span></div>
        `;

        artItem.addEventListener('click', (e) => {
            if (e.target.classList.contains('favorite-btn')) return;

            document.querySelectorAll('.art-item').forEach(item => {
                item.classList.remove('selected');
            });
            artItem.classList.add('selected');
            selectedArt = art;
            if (anchored) {
                placeArtwork();
            } else {
                showStatus(`Selected: ${art.title}`);
            }
        });

        artGallery.appendChild(artItem);
    });

    if (resultSet.length > artworks.length) {
        const more = document.createElement('div');
        more.className = 'art-item art-more';
        more.innerHTML = `<div class="art-more-label">More<br><small>${(resultSet.length - artworks.length).toLocaleString()} left</small></div>`;
        more.addEventListener('click', (e) => { e.stopPropagation(); showMoreResults(); });
        artGallery.appendChild(more);
    }
}

function toggleFavorite(event, index) {
    event.stopPropagation();
    const art = artworks[index];
    const existingIndex = favorites.findIndex(f => f.id === art.id);

    if (existingIndex > -1) {
        favorites.splice(existingIndex, 1);
        showStatus('Removed from favorites');
    } else {
        favorites.push(art);
        showStatus('Added to favorites');
    }

    localStorage.setItem('artFavorites', JSON.stringify(favorites));
    updateFavoritesCount();
    displayArtGallery();
}

function updateFavoritesCount() {
    favoritesCount.textContent = favorites.length;
    favoritesCount.style.display = favorites.length > 0 ? 'block' : 'none';
}

function updateMeasurement() {
    if (!measurementMode) return;
    const primary = activePicture();
    if (!primary) return;

    const width = primary.userData.originalWidth * primary.userData.scale;
    const height = primary.userData.originalHeight * primary.userData.scale;

    const widthInches = (width * 39.37).toFixed(1);
    const heightInches = (height * 39.37).toFixed(1);
    const widthCm = (width * 100).toFixed(1);
    const heightCm = (height * 100).toFixed(1);

    document.getElementById('measurement-text').innerHTML = `
        <strong>Artwork Dimensions:</strong><br>
        ${widthInches}" × ${heightInches}" (inches)<br>
        ${widthCm} × ${heightCm} cm
        <br><small>AR scale is approximate</small>
    `;
}

function takeScreenshot() {
    try {
        // Re-render right before reading the canvas so the buffer is fresh
        // (the camera feed is the scene background, so it's included)
        renderer.render(scene, zCamera);
        const dataUrl = renderer.domElement.toDataURL('image/png');

        const link = document.createElement('a');
        link.download = `ar-gallery-${Date.now()}.png`;
        link.href = dataUrl;
        link.click();

        sfx.shutter();
        showStatus('Photo saved!');
        promptForNextPiece();
    } catch (error) {
        console.error('Screenshot error:', error);
        showStatus('Error taking screenshot');
    }
}

function shareToSocial(platform) {
    const sel = activePicture();
    const art = (sel && sel.userData.art) || selectedArt;

    if (!art) {
        showStatus('Please select an artwork first');
        return;
    }

    const text = `Check out "${art.title}" in AR! 🎨`;
    const url = window.location.href;

    switch (platform) {
        case 'twitter':
            window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`);
            break;
        case 'instagram':
            showStatus('Take a screenshot to share on Instagram');
            takeScreenshot();
            break;
        case 'link':
            navigator.clipboard.writeText(url);
            showStatus('Link copied to clipboard!');
            break;
        case 'download':
            takeScreenshot();
            break;
    }

    shareSheet.classList.remove('active');
}

// Where this piece can be seen or bought: the museum page, a print, or —
// for gallery-listed work — the gallery's own sale page
function openPurchaseLink() {
    const sel = activePicture();
    const art = (sel && sel.userData.art) || selectedArt;
    if (!art) {
        showStatus('Please select an artwork first');
        return;
    }
    const options = [];
    if (art.buyUrl) options.push({ icon: '🛒', label: art.price ? `Buy · ${art.price}` : 'Buy', sub: art.gallery || '', url: art.buyUrl });
    if (art.galleryUrl && art.galleryUrl !== art.buyUrl) options.push({ icon: '🏛', label: art.gallery || 'Gallery', sub: 'Visit the gallery', url: art.galleryUrl });
    if (art.museumUrl) options.push({ icon: '🖼', label: `View at ${art.source || 'the museum'}`, sub: 'Collection page', url: art.museumUrl });
    if (art.printUrl && !art.buyUrl) options.push({ icon: '🖨', label: 'Buy a print', sub: 'Shop for prints of this work', url: art.printUrl });
    if (!options.length) {
        showStatus(art.price ? 'This piece is not listed for sale online yet' : 'No links available for this piece');
        return;
    }
    const sheet = document.getElementById('links-sheet');
    const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    sheet.querySelector('h3').textContent = art.title;
    sheet.querySelector('p').textContent = [art.artist, art.date].filter(Boolean).join(' · ');
    const list = sheet.querySelector('.share-options');
    list.innerHTML = options.map((o) =>
        `<a class="share-option" href="${esc(o.url)}" target="_blank" rel="noopener">
            <div class="share-option-icon">${o.icon}</div>
            <div class="share-option-label">${esc(o.label)}</div>
            ${o.sub ? `<div class="share-option-sub">${esc(o.sub)}</div>` : ''}
        </a>`).join('');
    sheet.classList.add('active');
}

function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');

    if (modalId === 'favorites-modal') {
        loadFavorites();
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function loadFavorites() {
    const favoritesList = document.getElementById('favorites-list');

    if (favorites.length === 0) {
        favoritesList.innerHTML = `
            <div class="empty-state" style="grid-column: span 2;">
                <div class="empty-state-icon">💔</div>
                <h3>No Favorites Yet</h3>
                <p>Tap the heart icon on artworks to save them here</p>
            </div>
        `;
        return;
    }

    favoritesList.innerHTML = '';
    favorites.forEach(art => {
        const card = document.createElement('div');
        card.className = 'favorite-card';
        card.innerHTML = `
            <img crossorigin="anonymous" src="${art.thumbnailUrl}" alt="${art.title}">
            <div class="favorite-card-info">
                <div class="favorite-card-title">${art.title}</div>
                <div class="favorite-card-artist">${art.artist}</div>
            </div>
        `;

        card.addEventListener('click', () => {
            selectedArt = art;
            closeModal('favorites-modal');
            if (anchored) {
                placeArtwork();
            } else {
                showStatus(`Selected: ${art.title}`);
            }
        });

        favoritesList.appendChild(card);
    });
}

function loadTemplates() {
    const templatesList = document.getElementById('templates-list');
    templatesList.innerHTML = '';

    roomTemplates.forEach(template => {
        const card = document.createElement('div');
        card.className = 'template-card';
        card.innerHTML = `
            <h3>${template.name}</h3>
            <p>${template.description}</p>
            <img class="template-preview" src="assets/templates/${template.id}.jpg" alt="${template.name}">
        `;

        card.addEventListener('click', () => {
            document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedTemplate = template;
        });

        templatesList.appendChild(card);
    });
}

function applyTemplate() {
    if (!selectedTemplate) {
        showStatus('Please select a template first');
        return;
    }

    closeModal('templates-modal');

    if (anchored) {
        buildTemplate(selectedTemplate);
    } else {
        pendingTemplate = selectedTemplate;
        showStatus(`${selectedTemplate.name} ready! Tap the wall to place your gallery.`);
    }
}

function showHint() {
    const hint = document.getElementById('hint');
    hint.classList.remove('fade');
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => hint.classList.add('fade'), 4500);
}

// ttl (ms) fades the hint away on its own — flow prompts shouldn't sit on
// the art; the glowing 📸 button carries the cue after the words go
function setHint(text, ttl) {
    const hint = document.getElementById('hint');
    clearTimeout(showHint._t);
    if (text === null) {
        hint.classList.add('fade');
        return;
    }
    hint.textContent = text;
    hint.classList.remove('fade');
    if (ttl) showHint._t = setTimeout(() => hint.classList.add('fade'), ttl);
}

function hideHint() {
    document.getElementById('hint').classList.add('fade');
}

// Toasts share the top of the screen with the guidance hint, so the hint
// steps aside while a toast is up and returns when it clears
function showStatus(message) {
    status.textContent = message;
    status.classList.remove('hidden');
    document.getElementById('hint').classList.add('yield');
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
        status.classList.add('hidden');
        document.getElementById('hint').classList.remove('yield');
    }, 3000);
}

function exitAR() {
    const cam = getZapparCamera();
    if (cam && typeof cam.pause === 'function') {
        try { cam.pause(); } catch (e) {}
        cameraPaused = true;
        canvasContainer.classList.add('hidden');
        startScreen.classList.remove('hidden');
        const heroVideo = document.getElementById('hero-video');
        if (heroVideo) {
            heroVideo.currentTime = 0;
            heroVideo.play().catch(() => {});
        }
        const amb = document.getElementById('ambience');
        if (sfx.on && amb) {
            amb.currentTime = 0;
            amb.volume = 0;
            amb.play().catch(() => {});
            fadeAudio(amb, 0.35, 2000);
        }
        return;
    }
    // No pause API available — reloading is the only way to stop the camera
    window.location.reload();
}

document.getElementById('exit-ar-btn').addEventListener('click', exitAR);
