/*
 * Framed-artwork painter shared by the in-app AR view and the Quick Look
 * export, so a piece looks the same in both. Paints a gilded moulding with
 * a rounded profile, light from the top-left, mitred corners and a fine
 * brushed grain, then a clean off-white mat with a white-core bevel, then
 * the artwork — all at high resolution into one canvas.
 */
(function (global) {
    'use strict';

    // Gilt moulding profile from the outer edge (0) to the inner lip (1)
    const PROFILE = [
        [0.00, '#4e3a12'],
        [0.05, '#7e6121'],
        [0.16, '#e6cc7c'],
        [0.24, '#f6e6a8'],
        [0.34, '#c8a24a'],
        [0.56, '#957329'],
        [0.74, '#b8923d'],
        [0.84, '#f1dc97'],
        [0.90, '#c9a650'],
        [0.95, '#7a5c1f'],
        [1.00, '#4a3611']
    ];

    // Light from the top-left: each bar of the frame catches it differently
    const SIDE_LIGHT = { top: 0.14, left: 0.06, right: -0.10, bottom: -0.18 };

    let noiseCanvas = null;
    function noisePattern(ctx) {
        if (!noiseCanvas) {
            noiseCanvas = document.createElement('canvas');
            noiseCanvas.width = noiseCanvas.height = 256;
            const n = noiseCanvas.getContext('2d');
            const img = n.createImageData(256, 256);
            let seed = 1234567;
            const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
            for (let i = 0; i < img.data.length; i += 4) {
                const v = 128 + (rand() - 0.5) * 90;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
                img.data[i + 3] = 255;
            }
            n.putImageData(img, 0, 0);
        }
        return ctx.createPattern(noiseCanvas, 'repeat');
    }

    // One bar of the frame: a trapezoid from the outer edge to the inner lip,
    // shaded across its width by the profile and along it by brushed grain
    function paintBar(ctx, side, W, H, f) {
        const quads = {
            top: [[0, 0], [W, 0], [W - f, f], [f, f]],
            bottom: [[0, H], [W, H], [W - f, H - f], [f, H - f]],
            left: [[0, 0], [f, f], [f, H - f], [0, H]],
            right: [[W, 0], [W - f, f], [W - f, H - f], [W, H]]
        };
        const across = {
            top: [0, 0, 0, f],
            bottom: [0, H, 0, H - f],
            left: [0, 0, f, 0],
            right: [W, 0, W - f, 0]
        };
        const q = quads[side];
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]);
        ctx.closePath();
        ctx.clip();

        const a = across[side];
        const g = ctx.createLinearGradient(a[0], a[1], a[2], a[3]);
        PROFILE.forEach(([t, c]) => g.addColorStop(t, c));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        // Brushed grain running along the bar
        const horizontal = side === 'top' || side === 'bottom';
        let seed = { top: 11, bottom: 23, left: 37, right: 51 }[side];
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const strokes = Math.round(f * 1.6);
        ctx.lineWidth = Math.max(0.6, f / 90);
        for (let i = 0; i < strokes; i++) {
            const o = rand() * f;
            const light = rand() > 0.5;
            ctx.strokeStyle = light ? `rgba(255, 244, 205, ${0.05 + rand() * 0.07})` : `rgba(40, 26, 6, ${0.04 + rand() * 0.06})`;
            ctx.beginPath();
            if (horizontal) {
                const y = side === 'top' ? o : H - o;
                ctx.moveTo(0, y); ctx.lineTo(W, y + (rand() - 0.5) * 2);
            } else {
                const x = side === 'left' ? o : W - o;
                ctx.moveTo(x, 0); ctx.lineTo(x + (rand() - 0.5) * 2, H);
            }
            ctx.stroke();
        }

        // Fine gilt texture
        ctx.globalAlpha = 0.10;
        ctx.globalCompositeOperation = 'overlay';
        ctx.fillStyle = noisePattern(ctx);
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;

        // Directional light
        const l = SIDE_LIGHT[side];
        ctx.fillStyle = l > 0 ? `rgba(255, 246, 215, ${l})` : `rgba(18, 10, 0, ${-l})`;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
    }

    function paintMitres(ctx, W, H, f) {
        ctx.save();
        ctx.lineWidth = Math.max(1, f / 60);
        ctx.strokeStyle = 'rgba(48, 32, 8, 0.45)';
        [[0, 0, f, f], [W, 0, W - f, f], [0, H, f, H - f], [W, H, W - f, H - f]].forEach(([x0, y0, x1, y1]) => {
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        });
        ctx.restore();
    }

    /*
     * img: loaded <img>/<canvas> — artW/artH: artwork size in metres.
     * opts.maxPx caps the longest canvas side (default 2048).
     * Returns { canvas, totalW, totalH, frameM, matM, edgeColor }.
     */
    function paint(img, artW, artH, opts) {
        opts = opts || {};
        const frameM = Math.max(0.03, artW * 0.042);
        const matM = Math.max(0.04, artW * 0.055);
        const totalW = artW + 2 * (frameM + matM);
        const totalH = artH + 2 * (frameM + matM);
        const maxPx = opts.maxPx || 2048;
        const pxPerM = maxPx / Math.max(totalW, totalH);
        const W = Math.round(totalW * pxPerM);
        const H = Math.round(totalH * pxPerM);
        const f = frameM * pxPerM;
        const m = matM * pxPerM;

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ['top', 'bottom', 'left', 'right'].forEach((side) => paintBar(ctx, side, W, H, f));
        paintMitres(ctx, W, H, f);

        // Mat: warm off-white with a faint paper tooth
        ctx.fillStyle = '#f3eee4';
        ctx.fillRect(f, f, W - 2 * f, H - 2 * f);
        ctx.save();
        ctx.globalAlpha = 0.05;
        ctx.fillStyle = noisePattern(ctx);
        ctx.fillRect(f, f, W - 2 * f, H - 2 * f);
        ctx.restore();

        // Bevel-cut window: a thin white core, no drop shadow
        const ax = f + m, ay = f + m, aw = W - 2 * (f + m), ah = H - 2 * (f + m);
        const bevel = Math.max(1.5, m * 0.07);
        ctx.fillStyle = '#fbf8f2';
        ctx.fillRect(ax - bevel, ay - bevel, aw + 2 * bevel, ah + 2 * bevel);
        ctx.strokeStyle = 'rgba(205, 195, 175, 0.6)';
        ctx.lineWidth = Math.max(0.75, bevel * 0.25);
        ctx.strokeRect(ax - bevel, ay - bevel, aw + 2 * bevel, ah + 2 * bevel);

        ctx.drawImage(img, ax, ay, aw, ah);

        return { canvas, totalW, totalH, frameM, matM, edgeColor: '#6b5120' };
    }

    // Wikimedia serves scaled copies by URL; ask for twice the default
    // width so the artwork matches the frame's sharpness (callers fall back
    // to the original URL when the larger copy can't be served)
    function hiResUrl(url) {
        return typeof url === 'string' && url.includes('/1000px-') ? url.replace('/1000px-', '/2000px-') : url;
    }

    const api = { paint, hiResUrl };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.FrameArt = api;
})(typeof window !== 'undefined' ? window : globalThis);
