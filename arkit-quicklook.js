/*
 * ARKit wall view via AR Quick Look — no app, no Mac, fully web-delivered.
 *
 * Safari on iOS opens a native ARKit viewer for any <a rel="ar"> link that
 * points at a USDZ model. ARKit's own SLAM does the plane detection and
 * anchoring, so the lock to the wall is rock solid — far beyond what any
 * in-browser tracker can do. This module builds that USDZ on the fly for
 * whichever artwork is selected: the frame, mat and canvas are composited
 * into a single texture on a single thin-box mesh (Quick Look offsets
 * multi-prim scenes away from vertical planes, so one prim it is), and the
 * scene carries preliminary:planeAnchoring:alignment = "vertical" so Quick
 * Look anchors it to walls only. Quick Look's banner shows the title and
 * artist, with one button back to the gallery.
 *
 * No dependencies: the USDA text, the PNG texture and the stored
 * 64-byte-aligned zip container are produced right here.
 */
(function (global) {
    'use strict';

    // ---------------------------------------------------------------- crc32
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // ------------------------------------------------- stored, aligned zip
    // USDZ is a plain zip with two extra rules: entries are stored (no
    // compression) and each entry's data begins on a 64-byte boundary,
    // achieved with a padding extra field in the local header.
    function buildZip(entries) {
        const chunks = [];
        const central = [];
        let offset = 0;

        const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
        const u32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);

        for (const { name, data } of entries) {
            const nameBytes = new TextEncoder().encode(name);
            const crc = crc32(data);

            // Pad the extra field so the payload starts 64-byte aligned
            const headerEnd = offset + 30 + nameBytes.length;
            let pad = (64 - ((headerEnd + 4) % 64)) % 64;
            const extra = new Uint8Array(4 + pad);
            extra.set(u16(0x1986), 0);        // private extra-field id
            extra.set(u16(pad), 2);

            const local = [
                u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
                u32(crc), u32(data.length), u32(data.length),
                u16(nameBytes.length), u16(extra.length),
                nameBytes, extra, data
            ];
            central.push({ nameBytes, crc, size: data.length, offset, extraLen: extra.length });
            for (const c of local) { chunks.push(c); offset += c.length; }
        }

        const cdStart = offset;
        for (const e of central) {
            const rec = [
                u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
                u32(e.crc), u32(e.size), u32(e.size),
                u16(e.nameBytes.length), u16(0), u16(0), u16(0), u16(0),
                u32(0), u32(e.offset), e.nameBytes
            ];
            for (const c of rec) { chunks.push(c); offset += c.length; }
        }
        chunks.push(
            u32(0x06054b50), u16(0), u16(0),
            u16(central.length), u16(central.length),
            u32(offset - cdStart), u32(cdStart), u16(0)
        );

        let total = 0;
        for (const c of chunks) total += c.length;
        const out = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) { out.set(c, p); p += c.length; }
        return out;
    }

    // ----------------------------------------------------------- usda text
    // One thin box, front face carrying the composited texture, every other
    // face pinned to a frame-coloured pixel.
    //
    // Quick Look treats a wall anchor like a floor anchor: the model's +Y
    // axis points out of the surface, and -Z points up the wall. A picture
    // modelled upright (facing +Z, top at +Y) therefore lands face-down,
    // sticking out of the wall. So the box is built upright and then turned
    // -90 deg about X: its face ends up along +Y (out of the wall) and its
    // top along -Z (up the wall).
    const toWall = (v) => [v[0], v[2], -v[1]];

    function buildUsda(w, h, d) {
        const x = w / 2, y = h / 2, z = d / 2;
        const P = [
            [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],      // front
            [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z]   // back
        ].map(toWall);
        // faces: front, back, left, right, top, bottom (outward winding)
        const F = [
            [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
            [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]
        ];
        const N = [
            [0, 0, 1], [0, 0, -1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]
        ].map(toWall);
        const EDGE = '(0.01, 0.5)'; // frame-border pixel of the texture
        const uv = [];
        F.forEach((face, fi) => {
            if (fi === 0) uv.push('(0, 0)', '(1, 0)', '(1, 1)', '(0, 1)');
            else face.forEach(() => uv.push(EDGE));
        });
        const fmtV = (v) => `(${v[0]}, ${v[1]}, ${v[2]})`;
        const normals = [];
        F.forEach((face, fi) => face.forEach(() => normals.push(fmtV(N[fi]))));

        return `#usda 1.0
(
    customLayerData = {
        string creator = "AR Art Gallery"
    }
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Xform "Scene" (
        prepend apiSchemas = ["Preliminary_AnchoringAPI"]
        customData = {
            bool preliminary_collidesWithEnvironment = 0
            string sceneName = "Scene"
        }
    )
    {
        token preliminary:anchoring:type = "plane"
        token preliminary:planeAnchoring:alignment = "vertical"

        def Mesh "Artwork" (
            prepend apiSchemas = ["MaterialBindingAPI"]
        )
        {
            uniform bool doubleSided = 0
            int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
            int[] faceVertexIndices = [${F.flat().join(', ')}]
            point3f[] points = [${P.map(fmtV).join(', ')}]
            normal3f[] primvars:normals = [${normals.join(', ')}] (
                interpolation = "faceVarying"
            )
            texCoord2f[] primvars:st = [${uv.join(', ')}] (
                interpolation = "faceVarying"
            )
            uniform token subdivisionScheme = "none"
            rel material:binding = </Root/Scene/ArtMaterial>
        }

        def Material "ArtMaterial"
        {
            token outputs:surface.connect = </Root/Scene/ArtMaterial/PreviewSurface.outputs:surface>

            def Shader "PreviewSurface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </Root/Scene/ArtMaterial/Texture.outputs:rgb>
                float inputs:metallic = 0
                float inputs:roughness = 0.55
                token outputs:surface
            }

            def Shader "uvReader"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                string inputs:varname = "st"
                float2 outputs:result
            }

            def Shader "Texture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/art.png@
                float2 inputs:st.connect = </Root/Scene/ArtMaterial/uvReader.outputs:result>
                token inputs:sourceColorSpace = "sRGB"
                token inputs:wrapS = "clamp"
                token inputs:wrapT = "clamp"
                float3 outputs:rgb
            }
        }
    }
}
`;
    }

    // ---------------------------------------------------- framed composite
    // Frame, mat and artwork painted by the shared FrameArt painter (the
    // same look as the in-app view) at high resolution, baked into a single
    // texture so the whole piece stays one prim.
    function compositeFramedArt(img, artW, artH) {
        return global.FrameArt.paint(img, artW, artH, { maxPx: 3072 });
    }

    function canvasToPngBytes(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) return reject(new Error('PNG encode failed'));
                blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
            }, 'image/png');
        });
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Image load failed'));
            img.src = url;
        });
    }

    // -------------------------------------------------------------- public
    function supported() {
        try {
            const a = document.createElement('a');
            return !!(a.relList && a.relList.supports && a.relList.supports('ar'));
        } catch (e) {
            return false;
        }
    }

    // Quick Look's own banner is the only UI a page may add inside the
    // viewer: a title, a subtitle and one button. The button tap comes back
    // to the page as a message event on the rel="ar" link.
    function bannerFragment(art, actionLabel) {
        const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const params = [
            ['checkoutTitle', clean(art.title) || 'Artwork'],
            ['checkoutSubtitle', clean([art.artist, art.date].filter(Boolean).join(' · ')) || 'AR Art Gallery'],
            ['callToAction', actionLabel || 'Choose another']
        ];
        return params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    }

    let lastLink = null;

    /*
     * Build the USDZ for one artwork and hand it to AR Quick Look.
     * art: { imageUrl, title, artist?, date? } — artWidthM: real-world canvas
     * width in meters — opts.onAction: called when the banner button is tapped.
     */
    async function view(art, artWidthM, opts) {
        opts = opts || {};
        const hi = global.FrameArt ? global.FrameArt.hiResUrl(art.imageUrl) : art.imageUrl;
        const candidates = [...new Set([hi, art.imageUrl].concat(art.imageFallbacks || []).filter(Boolean))];
        let img = null;
        for (const url of candidates) {
            try { img = await loadImage(url); break; } catch (e) { /* try the next source */ }
        }
        if (!img) throw new Error('No image source available');
        const artW = artWidthM || 0.8;
        const artH = artW * (img.naturalHeight / img.naturalWidth);

        const { canvas, totalW, totalH } = compositeFramedArt(img, artW, artH);
        const png = await canvasToPngBytes(canvas);
        const usda = new TextEncoder().encode(buildUsda(totalW, totalH, 0.025));

        const usdz = buildZip([
            { name: 'model.usda', data: usda },
            { name: 'textures/art.png', data: png }
        ]);

        const blob = new Blob([usdz], { type: 'model/vnd.usdz+zip' });
        const url = URL.createObjectURL(blob);

        // The link stays in the page while Quick Look is open, because the
        // banner's tap is delivered to it; the previous one goes now
        if (lastLink) {
            if (lastLink.parentNode) lastLink.parentNode.removeChild(lastLink);
            URL.revokeObjectURL(lastLink._blobUrl);
        }
        const a = document.createElement('a');
        a.rel = 'ar';
        a.href = url + '#' + bannerFragment(art, opts.actionLabel);
        a._blobUrl = url;
        a.style.display = 'none';
        a.addEventListener('message', (event) => {
            if (event.data === '_apple_ar_quicklook_button_tapped' && opts.onAction) opts.onAction();
        }, false);
        // Quick Look requires a child element inside the rel="ar" anchor
        a.appendChild(document.createElement('img'));
        document.body.appendChild(a);
        lastLink = a;
        a.click();
        return usdz.length;
    }

    const api = { supported, view, _buildZip: buildZip, _buildUsda: buildUsda, _crc32: crc32, _bannerFragment: bannerFragment };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.ARKitQuickLook = api;
})(typeof window !== 'undefined' ? window : globalThis);
