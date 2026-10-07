// AR Art Gallery Pro — Zappar Universal AR edition (A-Frame)
//
// Tracking model: one world-tracked room anchor (zappar-user-placement,
// instant tracking as fallback). Every hung picture is an independent
// fixture expressed in anchor-local space, so multiple artworks can sit
// on different walls at once and all stay locked to the room together.

// On-device diagnostics: open the page with ?debug=1 to see a live log
// overlay (errors, warnings, AR pipeline state) without remote debugging
if (location.search.indexOf('debug=1') !== -1) {
    const panel = document.createElement('pre');
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;' +
        'background:rgba(0,0,0,0.85);color:#7CFC00;font:10px/1.4 monospace;padding:8px;margin:0;' +
        'z-index:99999;white-space:pre-wrap;pointer-events:auto;';
    const log = (tag, args) => {
        panel.textContent += tag + ' ' + Array.from(args).map(a => {
            try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ') + '\n';
        panel.scrollTop = panel.scrollHeight;
    };
    document.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(panel);
        log('[i]', ['AFRAME ' + (window.AFRAME ? AFRAME.version : 'MISSING'),
                    'THREE r' + (window.AFRAME ? AFRAME.THREE.REVISION : '?'),
                    'UA ' + navigator.userAgent.slice(0, 80)]);
    });
    ['log', 'warn', 'error'].forEach(level => {
        const orig = console[level].bind(console);
        console[level] = (...args) => { log('[' + level[0] + ']', args); orig(...args); };
    });
    window.addEventListener('error', e => log('[E]', [e.message, e.filename + ':' + e.lineno]));
    window.addEventListener('unhandledrejection', e => log('[P]', [String(e.reason)]));
}

// App State
let sceneEl = null;
let anchorEl = null;
let galleryGroup = null;        // THREE.Group that holds artwork meshes
let gesturesWired = false;
let trackingMode = 'instant';   // 'world' (plane detection) or 'instant' fallback
let worldGroup = null;          // Zappar UserPlacementAnchorGroup in world mode
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

// A-Frame bundles its own THREE build
const THREE = window.AFRAME.THREE;

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
    showStatus('All pictures removed');
});

document.getElementById('more-btn').addEventListener('click', () => {
    shareSheet.classList.add('active');
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
    if (!shareSheet.contains(e.target) && e.target.id !== 'more-btn') {
        shareSheet.classList.remove('active');
    }
});

// The scene lives in the page from load (Zappar's reference pattern), so
// bind to it immediately; this script runs at the end of <body>
sceneEl = document.querySelector('a-scene');
galleryGroup = new THREE.Group();

// Prefer Zappar world tracking (real plane detection, ~absolute scale); fall
// back to instant tracking on devices where the world tracker fails to start
function getZapparCamera() {
    try { return sceneEl.systems['zappar-camera'].camera; } catch (e) { return null; }
}

function setPlacing(active) {
    document.getElementById('ui-overlay').classList.toggle('placing', active);
}

function chooseTracking() {
    if (anchorEl) return;
    const worldEl = document.getElementById('world-anchor');
    const wp = worldEl && worldEl.components['zappar-user-placement'];
    if (wp && wp.placementGroup) {
        trackingMode = 'world';
        worldGroup = wp.placementGroup;
        worldGroup.longPressToMove = false;
        worldGroup.showPlaceButton = false;
        anchorEl = worldEl;
        setPlacing(true);
        setHint('Aim at your wall and pan slowly so the room gets mapped…');

        // Walls matter most: vertical plane detection is off by default
        try {
            if (wp.tracker && wp.tracker.verticalPlaneDetectionSupported) {
                wp.tracker.verticalPlaneDetectionEnabled = true;
                console.log('wall (vertical plane) detection enabled');
            } else {
                console.log('vertical plane detection not supported on this device');
            }
        } catch (e) { console.log('vertical plane detection unavailable'); }

        // Once the tracker is genuinely ready we confirm the anchor
        // ourselves at the point the user is aiming — no button. We never
        // lock in before readiness: doing so hangs art into an un-anchored
        // frame that floats with the camera.
        const t0 = Date.now();
        const lockIn = () => {
            try { worldGroup.placementMode = false; } catch (e) { worldGroup._placementMode = false; }
            anchored = true;
            setPlacing(false);
            hideHint();
            sfx.anchor();
            showStatus('Room mapped — tap artwork in the strip to hang it');
            if (pendingTemplate) {
                buildTemplate(pendingTemplate);
                pendingTemplate = null;
            }
            setInterval(() => {
                worldGroup.showPlaceButton = false;
                if (worldGroup.ready === true && worldGroup._placementMode !== false) {
                    try { worldGroup.placementMode = false; } catch (e) { worldGroup._placementMode = false; }
                }
            }, 500);
        };
        const fallbackToInstant = () => {
            // This room will not world-track right now (light / texture).
            // Switch to the instant anchor so the session still works.
            try { worldGroup.enabled = false; } catch (e) {}
            try {
                if (wp.initializationUI) {
                    wp.data.showInitializationUI = false;
                    wp.initializationUI.hide();
                }
            } catch (e) {}
            if (galleryGroup.parent === anchorEl.object3D) {
                anchorEl.object3D.remove(galleryGroup);
            }
            trackingMode = 'instant';
            worldGroup = null;
            anchorEl = document.getElementById('instant-anchor');
            anchorEl.setAttribute('zappar-instant', 'enabled', true);
            anchorEl.object3D.add(galleryGroup);
            anchored = false;
            setPlacing(false);
            setHint('Low-light mode — aim at your wall and tap once to set it');
        };
        const warm = setInterval(() => {
            let ready = false;
            try { ready = worldGroup.ready === true; } catch (e) {}
            const elapsed = Date.now() - t0;
            if (ready && elapsed >= 4000) {
                clearInterval(warm);
                lockIn();
            } else if (elapsed > 25000) {
                clearInterval(warm);
                fallbackToInstant();
            } else if (elapsed > 12000 && !warm._coached) {
                warm._coached = true;
                setHint('Still mapping — step back a little, aim at wall detail; more light helps…');
            }
        }, 300);
    } else {
        trackingMode = 'instant';
        anchorEl = document.getElementById('instant-anchor');
        anchorEl.setAttribute('zappar-instant', 'enabled', true);
    }
    anchorEl.object3D.add(galleryGroup);
    console.log('tracking mode:', trackingMode);
}

async function initAR() {
    if (!window.AFRAME || !window.AFRAME.components['zappar-camera']) {
        showStatus('AR engine failed to load. Check your connection and reload the page.');
        return;
    }
    if (!window.isSecureContext) {
        showStatus('AR needs a secure connection. Open this page over https://');
        return;
    }

    startScreen.classList.add('hidden');
    canvasContainer.classList.remove('hidden');

    const heroVideo = document.getElementById('hero-video');
    if (heroVideo) heroVideo.pause();
    const amb = document.getElementById('ambience');
    if (amb) fadeAudio(amb, 0, 2500, () => amb.pause());

    if (cameraPaused) {
        const cam = getZapparCamera();
        try { cam.start(false); } catch (e) { try { cam.start(); } catch (e2) {} }
        cameraPaused = false;
    }

    if (!gesturesWired) {
        gesturesWired = true;
        const wireUp = () => {
            chooseTracking();
            setupGestures(sceneEl.canvas);
            if (trackingMode !== 'world') showHint();
            let checks = 0;
            const watchdog = setInterval(() => {
                checks++;
                if (sceneEl.object3D && sceneEl.object3D.background) {
                    clearInterval(watchdog);
                    console.log('camera feed rendering after', checks, 's');
                } else if (checks >= 8) {
                    clearInterval(watchdog);
                    console.error('camera background texture never arrived');
                    showStatus('Camera feed is not rendering. Reload the page — if it persists, add ?debug=1 to the address and send a screenshot.');
                }
            }, 1000);
        };
        if (sceneEl.hasLoaded) {
            wireUp();
        } else {
            sceneEl.addEventListener('loaded', wireUp, { once: true });
        }
    }

    if (artworks.length === 0) {
        await searchArt('impressionism');
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
    raycaster.setFromCamera(ndc, sceneEl.camera);
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
    const cam = sceneEl.camera;
    cam.updateMatrixWorld();
    anchorEl.object3D.updateMatrixWorld();

    const inv = new THREE.Matrix4().copy(anchorEl.object3D.matrixWorld).invert();
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
    const cam = sceneEl.camera;
    const camWorld = new THREE.Vector3();
    cam.getWorldPosition(camWorld);
    const meshWorld = new THREE.Vector3();
    mesh.getWorldPosition(meshWorld);

    const depth = meshWorld.distanceTo(camWorld) || 3;
    const worldPerPixel = (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / window.innerHeight;

    const delta = new THREE.Vector3()
        .setFromMatrixColumn(cam.matrixWorld, 0)
        .multiplyScalar(dx * worldPerPixel)
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1), -dy * worldPerPixel);

    const anchorQuat = new THREE.Quaternion();
    anchorEl.object3D.getWorldQuaternion(anchorQuat);
    delta.applyQuaternion(anchorQuat.invert());

    mesh.position.add(delta);
}

function setSelectedPicture(mesh) {
    if (selectedPlaced && selectedPlaced.userData.frame) {
        selectedPlaced.userData.frame.material.color.setHex(0x8c6a1f);
    }
    selectedPlaced = mesh;
    if (mesh && mesh.userData.frame) {
        mesh.userData.frame.material.color.setHex(0xf5d87a);
    }
    if (measurementMode) updateMeasurement();
}

function removePicture(mesh) {
    galleryGroup.remove(mesh);
    if (mesh.userData.frame) {
        mesh.userData.frame.geometry.dispose();
        mesh.userData.frame.material.dispose();
    }
    mesh.geometry.dispose();
    if (mesh.material.map) mesh.material.map.dispose();
    mesh.material.dispose();
    placedArts = placedArts.filter(m => m !== mesh);
    if (selectedPlaced === mesh) selectedPlaced = null;
    updateDockButtons();
}

function onTap(target) {
    if (trackingMode === 'world') {
        // Until the user confirms a wall, taps belong to Zappar's placement UI
        if (!anchored) return;
    } else if (!anchored) {
        anchorEl.setAttribute('zappar-instant', 'placementMode', false);
        anchored = true;
        hideHint();
        showStatus('Anchored — tap artwork in the strip to hang it');
        updateDockButtons();
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

function loadArtTexture(art, onLoad) {
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    loader.load(
        art.imageUrl,
        onLoad,
        undefined,
        (error) => {
            console.error('Error loading texture:', error);
            showStatus('Error loading artwork image');
        }
    );
}

function makeArtMesh(texture, width, art) {
    if ('colorSpace' in texture && THREE.SRGBColorSpace) {
        texture.colorSpace = THREE.SRGBColorSpace;
    }
    const aspect = texture.image.width / texture.image.height;
    const height = width / aspect;
    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);

    // Slim gold frame behind the canvas; brightens when the picture is selected
    const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(width * 1.06, height * 1.06),
        new THREE.MeshBasicMaterial({ color: 0x8c6a1f, side: THREE.DoubleSide })
    );
    frame.position.z = -0.004;
    mesh.add(frame);

    mesh.userData = { originalWidth: width, originalHeight: height, art, scale: 1, frame };
    return mesh;
}

function placeArtwork() {
    if (!selectedArt) {
        showStatus('Select an artwork from the strip first');
        return;
    }

    const placingArt = selectedArt;
    const pose = aimPoseInAnchor(2);
    // Nudge sideways rather than stacking onto an already-hung picture
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quat);
    let guard = 0;
    while (guard++ < 6 && placedArts.some(m => m.position.distanceTo(pose.pos) < 0.45)) {
        pose.pos.addScaledVector(right, 0.5);
    }
    loadArtTexture(placingArt, (texture) => {
        const mesh = makeArtMesh(texture, 1, placingArt);
        mesh.position.copy(pose.pos);
        mesh.quaternion.copy(pose.quat);
        galleryGroup.add(mesh);
        placedArts.push(mesh);
        setSelectedPicture(mesh);
        updateDockButtons();

        sfx.hang();
        hideHint();
        artGallery.classList.add('peek');
        showStatus(`Hung: ${placingArt.title} — drag to fine-tune`);
        if (measurementMode) updateMeasurement();
    });
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

async function searchArt(query = null) {
    const searchQuery = query || searchInput.value || 'monet';
    showStatus('Searching artworks...');

    try {
        let artworksData = [];

        if (currentSource === 'museum') {
            // Wikimedia Commons: reliable hotlinking with CORS headers, which WebGL
            // textures require (the Art Institute's image CDN now sits behind a bot
            // challenge and 403s embedded images)
            const api = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
                `&gsrsearch=${encodeURIComponent(searchQuery + ' painting')}&gsrnamespace=6&gsrlimit=18` +
                '&prop=imageinfo&iiprop=url%7Cmime%7Cextmetadata&iiurlwidth=1000&format=json&origin=*';
            const response = await fetch(api);
            const data = await response.json();
            const strip = (f) => f && f.value ? f.value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';

            artworksData = Object.values((data.query && data.query.pages) || {})
                .sort((a, b) => (a.index || 0) - (b.index || 0))
                .map(p => ({ page: p, info: (p.imageinfo || [])[0] }))
                .filter(x => x.info && x.info.thumburl && /^image\/(jpeg|png)/.test(x.info.mime || ''))
                .map(({ page, info }) => {
                    const meta = info.extmetadata || {};
                    const fallbackTitle = page.title.replace(/^File:/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
                    return {
                        id: page.pageid,
                        title: strip(meta.ObjectName) || fallbackTitle,
                        artist: strip(meta.Artist) || 'Unknown artist',
                        date: strip(meta.DateTimeOriginal),
                        imageUrl: info.thumburl,
                        thumbnailUrl: info.thumburl.includes('/1000px-')
                            ? info.thumburl.replace('/1000px-', '/320px-')
                            : info.thumburl,
                        source: 'Wikimedia Commons',
                        purchaseUrl: info.descriptionurl
                    };
                });
        } else if (currentSource === 'modern') {
            artworksData = curatedCollection('modern', 'Modern Collection');
        } else if (currentSource === 'photography') {
            artworksData = curatedCollection('photography', 'Photography Collection');
        } else if (currentSource === 'nft') {
            artworksData = generatePlaceholderArt('NFT Collection', searchQuery);
        }

        artworks = artworksData;
        displayArtGallery();
        artGallery.classList.remove('peek');
        artGallery.classList.add('open');
        document.getElementById('gallery-toggle').classList.add('active');
        searchPanel.classList.remove('open');
        status.classList.add('hidden');

        if (artworks.length === 0) {
            showStatus('No artworks found. Try a different search.');
        }
    } catch (error) {
        console.error('Search error:', error);
        showStatus('Error searching artworks. Please try again.');
    }
}

function generatePlaceholderArt(category, query) {
    // Placeholder for other art sources (you'd integrate real APIs here)
    return Array.from({ length: 10 }, (_, i) => ({
        id: `${category}-${i}`,
        title: `${query} ${category} #${i + 1}`,
        artist: `Artist ${i + 1}`,
        imageUrl: `https://picsum.photos/800/1000?random=${Date.now()}-${i}`,
        thumbnailUrl: `https://picsum.photos/200/250?random=${Date.now()}-${i}`,
        source: category,
        purchaseUrl: '#',
        price: `$${(Math.random() * 1000 + 100).toFixed(2)}`
    }));
}

function displayArtGallery() {
    artGallery.innerHTML = '';

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
            ${art.price ? `<div class="buy-badge">$${art.price}</div>` : ''}
            <img crossorigin="anonymous" src="${art.thumbnailUrl}" alt="${art.title}" onerror="this.src='assets/brand/art-placeholder.jpg'">
            <div class="art-item-title">${art.title}</div>
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
        const renderer = sceneEl.renderer;
        renderer.render(sceneEl.object3D, sceneEl.camera);
        const dataUrl = sceneEl.canvas.toDataURL('image/png');

        const link = document.createElement('a');
        link.download = `ar-gallery-${Date.now()}.png`;
        link.href = dataUrl;
        link.click();

        sfx.shutter();
        showStatus('Screenshot saved!');
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

function openPurchaseLink() {
    const sel = activePicture();
    const art = (sel && sel.userData.art) || selectedArt;

    if (!art) {
        showStatus('Please select an artwork first');
        return;
    }

    if (art.purchaseUrl && art.purchaseUrl !== '#') {
        window.open(art.purchaseUrl, '_blank');
    } else {
        showStatus('Purchase link coming soon! This would link to art marketplace.');
    }
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

function setHint(text) {
    const hint = document.getElementById('hint');
    clearTimeout(showHint._t);
    if (text === null) {
        hint.classList.add('fade');
        return;
    }
    hint.textContent = text;
    hint.classList.remove('fade');
}

function hideHint() {
    document.getElementById('hint').classList.add('fade');
}

function showStatus(message) {
    status.textContent = message;
    status.classList.remove('hidden');
    setTimeout(() => {
        status.classList.add('hidden');
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
