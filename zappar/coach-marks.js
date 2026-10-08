/*
 * First-run coach marks: a gold spotlight steps through the AR interface,
 * one icon at a time, with a short note on what each does. Tap anywhere to
 * advance, skip any time; shown once (remembered in localStorage) and
 * replayable from the menu via CoachMarks.replay().
 */
(function (global) {
    'use strict';

    const KEY = 'arTourDone';
    let lastSteps = null;
    let overlay = null;

    const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return true; } };
    const markSeen = () => { try { localStorage.setItem(KEY, '1'); } catch (e) {} };

    const CSS = `
        #coach-overlay { position: fixed; inset: 0; z-index: 4000; overflow: hidden; }
        #coach-ring {
            position: absolute; border: 2px solid rgba(212, 175, 55, 0.95);
            border-radius: 18px; box-shadow: 0 0 0 200vmax rgba(8, 7, 5, 0.62),
                0 0 18px 2px rgba(212, 175, 55, 0.5);
            transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1); pointer-events: none;
        }
        #coach-bubble {
            position: absolute; max-width: min(78vw, 300px); padding: 14px 16px;
            background: rgba(20, 17, 12, 0.96); border: 1px solid rgba(212, 175, 55, 0.45);
            border-radius: 14px; color: #f4efe5; font-size: 14px; line-height: 1.45;
            box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
            transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #coach-bubble .coach-title {
            color: #d4af37; font-size: 12px; letter-spacing: 0.14em;
            text-transform: uppercase; margin-bottom: 5px;
        }
        #coach-bubble .coach-foot {
            margin-top: 10px; display: flex; align-items: center; justify-content: space-between;
            font-size: 11px; color: rgba(244, 239, 229, 0.55);
        }
        #coach-dots span {
            display: inline-block; width: 5px; height: 5px; border-radius: 50%;
            background: rgba(212, 175, 55, 0.3); margin-right: 4px;
        }
        #coach-dots span.on { background: #d4af37; }
        #coach-skip {
            background: none; border: none; color: rgba(212, 175, 55, 0.85);
            font-size: 11px; letter-spacing: 0.08em; padding: 4px 0 4px 14px;
        }
    `;

    function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
            && getComputedStyle(el).visibility !== 'hidden';
    }

    function start(steps, opts) {
        opts = opts || {};
        lastSteps = steps;
        if (overlay || (!opts.force && seen())) return;
        const list = steps
            .map(s => ({ el: document.getElementById(s.id), title: s.title, text: s.text }))
            .filter(s => visible(s.el));
        if (!list.length) return;

        if (!document.getElementById('coach-style')) {
            const style = document.createElement('style');
            style.id = 'coach-style';
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        overlay = document.createElement('div');
        overlay.id = 'coach-overlay';
        overlay.innerHTML = '<div id="coach-ring"></div><div id="coach-bubble"></div>';
        document.body.appendChild(overlay);
        const ring = overlay.querySelector('#coach-ring');
        const bubble = overlay.querySelector('#coach-bubble');
        let i = 0;

        const render = () => {
            const step = list[i];
            if (!visible(step.el)) { advance(); return; }
            const r = step.el.getBoundingClientRect();
            const pad = 7;
            ring.style.left = (r.left - pad) + 'px';
            ring.style.top = (r.top - pad) + 'px';
            ring.style.width = (r.width + pad * 2) + 'px';
            ring.style.height = (r.height + pad * 2) + 'px';
            ring.style.borderRadius = (r.width > 120 ? 18 : (r.height + pad * 2) / 2) + 'px';

            const dots = list.map((_, d) =>
                `<span class="${d === i ? 'on' : ''}"></span>`).join('');
            bubble.innerHTML =
                (step.title ? `<div class="coach-title">${step.title}</div>` : '') +
                step.text +
                `<div class="coach-foot"><span id="coach-dots">${dots}</span>` +
                `<span>Tap to continue<button id="coach-skip">Skip</button></span></div>`;
            bubble.querySelector('#coach-skip').addEventListener('click', (e) => {
                e.stopPropagation();
                finish();
            });

            // Place the bubble clear of the target: below it when the target
            // sits in the top half of the screen, above it otherwise
            const bh = 120; // rough; corrected after layout below
            const below = r.top + r.height / 2 < window.innerHeight / 2;
            bubble.style.left = Math.max(12, Math.min(
                r.left + r.width / 2 - 150, window.innerWidth - 312)) + 'px';
            bubble.style.top = below
                ? Math.min(r.bottom + 18, window.innerHeight - bh - 12) + 'px'
                : Math.max(12, r.top - 18 - bh) + 'px';
            requestAnimationFrame(() => {
                const bb = bubble.getBoundingClientRect();
                if (!below) bubble.style.top = Math.max(12, r.top - 18 - bb.height) + 'px';
            });
        };

        const advance = () => {
            i++;
            if (i >= list.length) { finish(); return; }
            render();
        };

        const finish = () => {
            markSeen();
            window.removeEventListener('resize', render);
            if (overlay) { overlay.remove(); overlay = null; }
        };

        overlay.addEventListener('click', advance);
        window.addEventListener('resize', render);
        render();
    }

    function replay() {
        try { localStorage.removeItem(KEY); } catch (e) {}
        if (lastSteps) start(lastSteps, { force: true });
    }

    const api = { start, replay, _seen: seen };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.CoachMarks = api;
})(typeof window !== 'undefined' ? window : globalThis);
