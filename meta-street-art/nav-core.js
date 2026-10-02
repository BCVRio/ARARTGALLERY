// Shared navigation helpers for the glasses view (index.html) and Web AR view (ar.html).
window.MSA = (() => {
  'use strict';

  // ---------- Geo ----------
  const R = 6371000, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
  function dist(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  // Distance from point p to segment a-b (local flat projection, fine for city scale).
  function distToSeg(p, a, b) {
    const k = Math.cos(rad(p.lat));
    const ax = (a.lng - p.lng) * k, ay = a.lat - p.lat, bx = (b.lng - p.lng) * k, by = b.lat - p.lat;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy) * 111320;
  }
  const ll = ([lng, lat]) => ({ lat, lng });
  const normAngle = (a) => ((a % 360) + 540) % 360 - 180;

  // ---------- Formatting ----------
  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const compassWord = (b) => COMPASS[Math.round(b / 45) % 8];
  const fmtDist = (m) => (m < 1000 ? `${Math.max(5, Math.round(m / 5) * 5)} m` : `${(m / 1000).toFixed(1)} km`);
  const sayDist = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} metres` : `${(m / 1000).toFixed(1)} kilometres`);
  const walkMins = (m) => Math.max(1, Math.round(m / 1.3 / 60));
  const fmtMins = (m) => `${walkMins(m)} min walk`;
  const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);

  // ---------- Walking routes (OSRM foot profile on OpenStreetMap data) ----------
  async function fetchRoute(from, to) {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      if (j.code !== 'Ok' || !j.routes.length) throw new Error(j.code);
      return j.routes[0];
    } finally { clearTimeout(t); }
  }
  function stepText(s) {
    // Skip unnamed or number-only ways (footpath refs read badly aloud).
    const name = s.name && !/^\d+$/.test(s.name.trim()) ? s.name : '';
    const m = s.maneuver, on = name ? ` onto ${name}` : '';
    switch (m.type) {
      case 'depart': return `Head ${compassWord(m.bearing_after)}${name ? ' on ' + name : ''}`;
      case 'arrive': return 'Your destination is ahead';
      case 'roundabout': case 'rotary': return `At the roundabout take exit ${m.exit || 1}${on}`;
      default: {
        const mod = m.modifier || 'straight';
        if (mod === 'straight') return `Continue straight${on}`;
        if (mod === 'uturn') return 'Turn around';
        return `Turn ${mod}${on}`;
      }
    }
  }
  const MOD_ANGLE = { 'sharp left': -135, left: -90, 'slight left': -45, straight: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180 };
  // Remaining walking distance from p, given the route steps and the index of the next maneuver.
  const remainingOnRoute = (p, steps, i) => dist(p, ll(steps[i].maneuver.location)) + steps.slice(i).reduce((a, x) => a + x.distance, 0);

  // ---------- Speech out (plays through Bluetooth glasses / earbuds when paired) ----------
  function createSpeaker({ enabled, onStart, onEnd } = {}) {
    let voice = null, last = '';
    const ok = 'speechSynthesis' in window;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      voice = vs.find((v) => v.lang === 'en-GB' && /natural|neural|google|daniel|serena/i.test(v.name))
           || vs.find((v) => v.lang === 'en-GB') || vs.find((v) => v.lang.startsWith('en')) || null;
    };
    if (ok) { pick(); speechSynthesis.addEventListener?.('voiceschanged', pick); }
    return {
      say(text, { interrupt = false } = {}) {
        last = text;
        if (!ok || (enabled && !enabled())) return;
        if (interrupt) speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        if (voice) u.voice = voice;
        u.lang = 'en-GB';
        u.rate = 1.02;
        if (onStart) u.onstart = onStart;
        if (onEnd) u.onend = onEnd;
        speechSynthesis.speak(u);
      },
      repeat() { if (last) this.say(last, { interrupt: true }); },
      cancel() { if (ok) speechSynthesis.cancel(); },
    };
  }
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

  // ---------- Compass heading ----------
  // enable() must be called from a user gesture on iOS.
  // camera: true reports where the back camera points (phone held upright, as in AR)
  // instead of where the top of the phone points (phone flat or in a pocket).
  function createCompass({ camera = false } = {}) {
    let heading = null;
    const smooth = (h) => {
      if (heading === null) return h;
      return (heading + normAngle(h - heading) * 0.2 + 360) % 360;
    };
    const onOrient = (e) => {
      if (typeof e.webkitCompassHeading === 'number') { heading = smooth(e.webkitCompassHeading); return; }
      if (!e.absolute || typeof e.alpha !== 'number') return;
      if (!camera || e.beta === null) { heading = smooth((360 - e.alpha) % 360); return; }
      // Direction of the device's -Z axis (out of the back camera) in east/north coordinates.
      const a = rad(e.alpha), b = rad(e.beta), g = rad(e.gamma);
      const east = -(Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g));
      const north = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g));
      heading = smooth((deg(Math.atan2(east, north)) + 360) % 360);
    };
    return {
      get: () => heading,
      async enable() {
        try {
          if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return false;
          }
        } catch { return false; }
        if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
        else window.addEventListener('deviceorientation', onOrient);
        return true;
      },
    };
  }

  return {
    dist, bearing, distToSeg, ll, normAngle, compassWord, fmtDist, sayDist, walkMins, fmtMins, lc,
    fetchRoute, stepText, MOD_ANGLE, remainingOnRoute, createSpeaker, buzz, createCompass,
  };
})();
