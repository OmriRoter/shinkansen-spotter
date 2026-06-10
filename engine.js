/* =========================================================================
   engine.js — multi-line Shinkansen engine. Works in the browser
   (window.Spotter) and in Node (module.exports).

   Station/stop data comes from lines-data.js (SpotterLines). This file holds
   only the shared logic: geometry, nearest-station, deterministic simulation
   fallback, distance interpolation for pass-through times, and blocking
   detection. Every line is handled the same way via line "views".

   Event format (sim + live): { type, dir, timeMin, stops, dest?, platform? }.
   ========================================================================= */
(function (root, factory) {
  const api = factory(
    (typeof self !== "undefined" && self.SpotterLines) ? self.SpotterLines :
    (typeof require !== "undefined" ? require("./lines-data.js") : root.SpotterLines)
  );
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Spotter = api;
})(typeof self !== "undefined" ? self : this, function (DATA) {
  "use strict";

  const LINES = DATA.LINES, TYPE_META = DATA.TYPE_META;
  const LINE_KEYS = Object.keys(LINES);

  /* ---------- geometry ---------- */
  const R = 6371, toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
            - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  const COMPASS_EN = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = deg => COMPASS_EN[Math.round(deg / 45) % 8];

  function meta(type) {
    return TYPE_META[type] || { en: type, jp: type, cls: "rapid", cruise: 270, dwell: 1.5 };
  }

  /* cumulative along-line distance for a station list */
  function cumOf(stations) {
    const c = [0];
    for (let i = 1; i < stations.length; i++) c[i] = c[i - 1] + haversine(stations[i - 1], stations[i]);
    return c;
  }

  /* ---------- per-line "view": all the data + bound helpers for one line ---------- */
  const viewCache = {};
  function line(key) {
    if (viewCache[key]) return viewCache[key];
    const L = LINES[key];
    if (!L) return null;
    const stations = L.stations, N = stations.length, CUM = cumOf(stations);
    const STOPS = {}; for (const t of L.types) STOPS[t] = new Set(L.stops[t]);
    const express = L.express, HUBS = (L.hubs || []).slice().sort((a, b) => a - b);

    function indexOfId(id) { return stations.findIndex(s => s.id === id); }

    /* deterministic simulation (offline fallback) — one stream per train type */
    function buildSimEvents(idx) {
      const out = [], SERVICE_START = 360, SERVICE_END = 1380;
      let off = 0;
      for (const type of L.types) {
        const m = meta(type), stopSet = STOPS[type];
        const headway = m.cls === "ltd" ? 12 : m.cls === "rapid" ? 24 : 30;
        for (const dir of ["down", "up"]) {
          const o = off + (dir === "down" ? 0 : Math.round(headway / 2));
          for (let base = SERVICE_START + o; base <= SERVICE_END; base += headway) {
            // travel time from the relevant terminal to idx along the line
            let distKm, lo, hi;
            if (dir === "down") { distKm = CUM[idx] - CUM[0]; lo = 1; hi = idx; }
            else { distKm = CUM[N - 1] - CUM[idx]; lo = idx + 1; hi = N - 2; }
            let t = base + distKm / m.cruise * 60;
            for (let i = lo; i <= hi; i++) if (stopSet.has(i)) t += m.dwell;
            if (t < SERVICE_START || t > SERVICE_END + 30) continue;
            out.push({ type, dir, timeMin: t, stops: stopSet.has(idx) });
          }
        }
        off += 3;
      }
      out.sort((a, b) => a.timeMin - b.timeMin);
      return out;
    }

    /* interpolate a pass-through time at idx from two bracketing stop times */
    function interpolatePass(schedule, idx, dir) {
      const pts = schedule.slice().sort((a, b) => dir === "down" ? a.idx - b.idx : b.idx - a.idx);
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const lo = Math.min(a.idx, b.idx), hi = Math.max(a.idx, b.idx);
        if (idx > lo && idx < hi) {
          const frac = (CUM[idx] - CUM[lo]) / (CUM[hi] - CUM[lo]);
          const tLo = a.idx === lo ? a.timeMin : b.timeMin;
          const tHi = a.idx === hi ? a.timeMin : b.timeMin;
          return tLo + frac * (tHi - tLo);
        }
      }
      return null;
    }

    function approachBearing(idx, dir) {
      if (dir === "down") { const p = Math.max(0, idx - 1); return bearing(stations[idx], stations[p]); }
      const p = Math.min(N - 1, idx + 1); return bearing(stations[idx], stations[p]);
    }

    return (viewCache[key] = {
      key, name: L.name, jp: L.jp, lineId: L.lineId,
      STATIONS: stations, N, CUM, STOPS, types: L.types, express, HUBS,
      hubs: () => HUBS,
      isHub: idx => HUBS.indexOf(idx) >= 0,
      indexOfId, buildSimEvents, interpolatePass, approachBearing,
    });
  }

  /* nearest station across every line */
  function nearestStation(lat, lon) {
    let best = { lineKey: LINE_KEYS[0], idx: 0, dist: Infinity };
    for (const key of LINE_KEYS) {
      const sts = LINES[key].stations;
      for (let i = 0; i < sts.length; i++) {
        const d = haversine({ lat, lon }, sts[i]);
        if (d < best.dist) best = { lineKey: key, idx: i, dist: d };
      }
    }
    return best;
  }

  /* a stopping train (same direction) that may block the shot while it dwells */
  function blockingTrain(events, t, dir) {
    for (const e of events) {
      if (!e.stops || e.dir !== dir) continue;
      const dwell = (meta(e.type).dwell || 1.5) + (meta(e.type).cls === "local" ? 4 : 0);
      if (t >= e.timeMin - 0.3 && t <= e.timeMin + dwell + 0.3) return { type: e.type, until: e.timeMin + dwell, platform: e.platform };
    }
    return null;
  }

  return {
    LINES, TYPE_META, LINE_KEYS,
    line, nearestStation, blockingTrain,
    haversine, bearing, compass, meta,
  };
});
