// AR Art Gallery Pro — Zappar Universal AR edition (A-Frame + zappar-instant)
//
// Tracking model: a single zappar-instant anchor starts in placement mode
// (content follows the camera); the first tap anchors it to the world via
// Zappar's instant world tracking. All artwork lives in #gallery-group
// inside the anchor, so drag/pinch/template layouts are plain local-space
// transforms and everything stays anchored together.

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
let anchored = false;
let currentArtwork = null;      // primary mesh (single placement)
let templateMeshes = [];        // meshes placed by a room template
let pendingTemplate = null;     // template waiting for a wall tap
let artworks = [];
let selectedArt = null;
let currentScale = 1;
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

document.getElementById('size-up').addEventListener('click', () => {
    if (galleryGroup) {
        currentScale *= 1.2;
        galleryGroup.scale.set(currentScale, currentScale, currentScale);
        updateMeasurement();
    }
});

document.getElementById('size-down').addEventListener('click', () => {
    if (galleryGroup) {
        currentScale *= 0.8;
        galleryGroup.scale.set(currentScale, currentScale, currentScale);
        updateMeasurement();
    }
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

document.getElementById('replace-btn').addEventListener('click', () => {
    if (!anchorEl) return;
    anchorEl.setAttribute('zappar-instant', 'placementMode', true);
    anchored = false;
    showStatus('Point at your wall, then tap to re-place the gallery');
});

document.getElementById('more-btn').addEventListener('click', () => {
    shareSheet.classList.add('active');
});

document.getElementById('search-toggle').addEventListener('click', () => {
    searchPanel.classList.toggle('open');
});

const galleryToggle = document.getElementById('gallery-toggle');
galleryToggle.addEventListener('click', () => {
    artGallery.classList.toggle('open');
    galleryToggle.classList.toggle('active', artGallery.classList.contains('open'));
});

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
anchorEl = document.getElementById('instant-anchor');
galleryGroup = new THREE.Group();
anchorEl.object3D.add(galleryGroup);

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

    if (!gesturesWired) {
        gesturesWired = true;
        const wireUp = () => {
            setupGestures(sceneEl.canvas);
            showHint();
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

    await searchArt('impressionism');
}

// Tap anchors the gallery to the world (and places the selected artwork);
// drag moves the artwork across the wall; pinch resizes it
const touchState = {
    mode: null,
    lastX: 0,
    lastY: 0,
    moved: false,
    startDist: 0,
    startScale: 1
};

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
        } else if (e.touches.length === 2) {
            touchState.mode = 'pinch';
            touchState.startDist = touchDistance(e.touches);
            touchState.startScale = currentScale;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();

        if (touchState.mode === 'drag' && e.touches.length === 1 && hasArt()) {
            const dx = e.touches[0].clientX - touchState.lastX;
            const dy = e.touches[0].clientY - touchState.lastY;
            touchState.lastX = e.touches[0].clientX;
            touchState.lastY = e.touches[0].clientY;

            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) touchState.moved = true;
            dragGallery(dx, dy);
        } else if (touchState.mode === 'pinch' && e.touches.length === 2 && hasArt()) {
            touchState.moved = true;
            const ratio = touchDistance(e.touches) / touchState.startDist;
            currentScale = Math.min(10, Math.max(0.1, touchState.startScale * ratio));
            galleryGroup.scale.set(currentScale, currentScale, currentScale);
            updateMeasurement();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) {
            if (touchState.mode === 'drag' && !touchState.moved) {
                onTap();
            }
            touchState.mode = null;
        }
    });

    // Desktop browsers (Zappar supports webcam preview for quick testing)
    if (!('ontouchstart' in window)) {
        canvas.addEventListener('click', onTap);
    }
}

function hasArt() {
    return currentArtwork || templateMeshes.length > 0;
}

function dragGallery(dx, dy) {
    // Convert screen pixels to world units at the gallery's depth, moving in
    // the camera's view plane, then express that delta in anchor-local space
    const cam = sceneEl.camera;
    const camWorld = new THREE.Vector3();
    cam.getWorldPosition(camWorld);
    const groupWorld = new THREE.Vector3();
    galleryGroup.getWorldPosition(groupWorld);

    const depth = groupWorld.distanceTo(camWorld) || 3;
    const worldPerPixel = (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / window.innerHeight;

    const delta = new THREE.Vector3()
        .setFromMatrixColumn(cam.matrixWorld, 0)
        .multiplyScalar(dx * worldPerPixel)
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1), -dy * worldPerPixel);

    const anchorQuat = new THREE.Quaternion();
    anchorEl.object3D.getWorldQuaternion(anchorQuat);
    delta.applyQuaternion(anchorQuat.invert());

    galleryGroup.position.add(delta);
}

function onTap() {
    if (!anchored) {
        anchorEl.setAttribute('zappar-instant', 'placementMode', false);
        anchored = true;
        hideHint();
        showStatus('Anchored — the art is pinned to your wall');
    }

    if (pendingTemplate) {
        buildTemplate(pendingTemplate);
        pendingTemplate = null;
        return;
    }

    placeArtwork();
}

function clearGallery() {
    const disposeMesh = (mesh) => {
        galleryGroup.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
    };
    if (currentArtwork) {
        disposeMesh(currentArtwork);
        currentArtwork = null;
    }
    templateMeshes.forEach(disposeMesh);
    templateMeshes = [];
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
    mesh.userData = { originalWidth: width, originalHeight: height, art };
    return mesh;
}

function placeArtwork() {
    if (!selectedArt) {
        showStatus('Select an artwork from the strip first');
        return;
    }

    const placingArt = selectedArt;
    loadArtTexture(placingArt, (texture) => {
        clearGallery();
        currentArtwork = makeArtMesh(texture, 1, placingArt);
        galleryGroup.add(currentArtwork);

        currentScale = 1;
        galleryGroup.scale.set(1, 1, 1);
        galleryGroup.position.set(0, 0, 0);

        hideHint();
        showStatus(`Placed: ${placingArt.title}`);
        if (measurementMode) updateMeasurement();
    });
}

function buildTemplate(template) {
    const pieces = artworks.slice(0, template.artworks);
    if (pieces.length === 0) {
        showStatus('Search for artworks first, then apply a template');
        return;
    }

    clearGallery();
    currentScale = 1;
    galleryGroup.scale.set(1, 1, 1);
    galleryGroup.position.set(0, 0, 0);

    const w = template.layout === 'center' ? 1.2 : 0.7;
    const spacing = template.spacing;
    let placedCount = 0;

    pieces.forEach((art, i) => {
        loadArtTexture(art, (texture) => {
            const mesh = makeArtMesh(texture, w, art);

            if (template.layout === 'horizontal' || template.layout === 'triptych') {
                mesh.position.x = (i - (pieces.length - 1) / 2) * (w + spacing);
            } else if (template.layout === 'grid') {
                const cols = Math.ceil(pieces.length / 2);
                const col = i % cols;
                const row = Math.floor(i / cols);
                mesh.position.x = (col - (cols - 1) / 2) * (w + spacing);
                mesh.position.y = row === 0 ? (0.45 + spacing) : -(0.45 + spacing) / 2;
            }
            // 'center' stays at the origin

            galleryGroup.add(mesh);
            templateMeshes.push(mesh);
            placedCount++;
            if (placedCount === pieces.length) {
                showStatus(`${template.name} placed!`);
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
            artworksData = generatePlaceholderArt('Modern Art', searchQuery);
        } else if (currentSource === 'photography') {
            artworksData = generatePlaceholderArt('Photography', searchQuery);
        } else if (currentSource === 'nft') {
            artworksData = generatePlaceholderArt('NFT Collection', searchQuery);
        }

        artworks = artworksData;
        displayArtGallery();
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
            <img src="${art.thumbnailUrl}" alt="${art.title}" onerror="this.src='https://placehold.co/200x250?text=Art'">
            <div class="art-item-title">${art.title}</div>
        `;

        artItem.addEventListener('click', (e) => {
            if (e.target.classList.contains('favorite-btn')) return;

            document.querySelectorAll('.art-item').forEach(item => {
                item.classList.remove('selected');
            });
            artItem.classList.add('selected');
            selectedArt = art;
            showStatus(`Selected: ${art.title}`);
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
    const primary = currentArtwork || templateMeshes[0];
    if (!primary) return;

    const width = primary.userData.originalWidth * currentScale;
    const height = primary.userData.originalHeight * currentScale;

    const widthInches = (width * 39.37).toFixed(1);
    const heightInches = (height * 39.37).toFixed(1);
    const widthCm = (width * 100).toFixed(1);
    const heightCm = (height * 100).toFixed(1);

    document.getElementById('measurement-text').innerHTML = `
        <strong>Artwork Dimensions:</strong><br>
        ${widthInches}" × ${heightInches}" (inches)<br>
        ${widthCm} × ${heightCm} cm
        <br><small>Note: instant tracking scale is approximate</small>
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

        showStatus('Screenshot saved!');
    } catch (error) {
        console.error('Screenshot error:', error);
        showStatus('Error taking screenshot');
    }
}

function shareToSocial(platform) {
    const art = selectedArt || (currentArtwork && currentArtwork.userData.art);

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
    const art = selectedArt || (currentArtwork && currentArtwork.userData.art);

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
            <img src="${art.thumbnailUrl}" alt="${art.title}">
            <div class="favorite-card-info">
                <div class="favorite-card-title">${art.title}</div>
                <div class="favorite-card-artist">${art.artist}</div>
            </div>
        `;

        card.addEventListener('click', () => {
            selectedArt = art;
            closeModal('favorites-modal');
            showStatus(`Selected: ${art.title}`);
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
            <div class="template-artworks">
                ${Array.from({ length: Math.min(template.artworks, 4) }).map((_, i) =>
                    `<img src="https://picsum.photos/60/60?random=${template.id}-${i}" alt="Preview">`
                ).join('')}
            </div>
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
    // Reloading is the reliable way to fully stop Zappar's camera pipeline
    window.location.reload();
}

document.getElementById('exit-ar-btn').addEventListener('click', exitAR);
