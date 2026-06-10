// Vercel serverless function — live Shinkansen pass-through times (all lines).
// Reuses the shared engine + line data; the Bright Data token is read ONLY from
// process.env and never sent to the browser. Falls back to deterministic
// simulation if the token is missing or a scrape fails.
"use strict";
const Spotter = require("../engine.js");

const classify = (name) => {
  const w = (name || "").trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
  return Spotter.TYPE_META[w] ? w : null;
};

async function unlock(url) {
  const res = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone: process.env.BRIGHTDATA_ZONE || "web_unlocker1", url, format: "raw", country: "jp" }),
  });
  if (!res.ok) throw new Error(`Bright Data ${res.status}`);
  return res.text();
}

// NAVITIME serves timetables as a server-rendered "diagram": hour in data-hour,
// minutes in <dt class="time">, plus data-train-name / data-direction / dest / platform.
function parseBoard(html, dir) {
  const out = [], blocks = String(html).split("timetable-area__list--definition").slice(1);
  for (const blk of blocks) {
    const seg = blk.slice(0, 600);
    const name = (seg.match(/data-train-name="([^"]*)"/) || [])[1];
    const hour = (seg.match(/data-hour="(\d+)"/) || [])[1];
    const ddir = (seg.match(/data-direction="([^"]*)"/) || [])[1] || dir;
    const tm = seg.match(/<dt class="time">\s*(\d{1,2})\s*<\/dt>/);
    const dest = (seg.match(/data-destination="([^"]*)"/) || [])[1] || "";
    const plat = seg.match(/Platform:\s*(\d+)/i);
    const type = classify(name);
    if (name && hour != null && tm && type)
      out.push({ name, type, dir: ddir, depMin: +hour * 60 + +tm[1], dest, platform: plat ? +plat[1] : null });
  }
  return out;
}

// In-memory board cache per warm instance (lineId:node:dir, 15 min TTL). Boards are
// shared across stations/requests, so repeat or adjacent lookups cost no extra calls.
const BOARD_TTL_MS = 15 * 60 * 1000;
const boardCache = new Map();
async function fetchBoard(view, idx, dir) {
  const node = view.STATIONS[idx].node;
  const key = view.lineId + ":" + node + ":" + dir;
  const hit = boardCache.get(key);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.rows;
  const url = `https://japantravel.navitime.com/en/area/jp/timetable/${node}/${view.lineId}?direction=${dir}`;
  const rows = parseBoard(await unlock(url), dir);
  boardCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function buildLiveEvents(view, idx) {
  const events = [], hubs = view.hubs();
  for (const dir of ["down", "up"]) {
    const before = [...hubs].reverse().find((i) => i < idx);
    const after = hubs.find((i) => i > idx);
    const wrap = before != null && after != null;
    const [own, b1, b2] = await Promise.all([
      fetchBoard(view, idx, dir),
      wrap ? fetchBoard(view, before, dir) : Promise.resolve([]),
      wrap ? fetchBoard(view, after, dir) : Promise.resolve([]),
    ]);
    for (const r of own) events.push({ type: r.type, dir, timeMin: r.depMin, stops: true, dest: r.dest, platform: r.platform });
    if (wrap) {
      const ownNames = new Set(own.map((r) => r.name)), map = new Map();
      for (const r of b1) map.set(r.name, { before: r.depMin, type: r.type, dest: r.dest });
      for (const r of b2) { const e = map.get(r.name); if (e) e.after = r.depMin; }
      for (const [name, e] of map) {
        if (e.before == null || e.after == null || ownNames.has(name)) continue;
        // board times are departures; subtract the destination-side hub's dwell to
        // recover its arrival (Osaka/west side going down, Tokyo/east side going up).
        const dwell = Spotter.meta(e.type).dwell || 0;
        const bT = dir === "up" ? e.before - dwell : e.before;
        const aT = dir === "down" ? e.after - dwell : e.after;
        const t = view.interpolatePass([{ idx: before, timeMin: bT }, { idx: after, timeMin: aT }], idx, dir);
        if (t == null) continue;
        events.push({ type: e.type, dir, timeMin: t, stops: false, dest: e.dest });
      }
    }
  }
  events.sort((a, b) => a.timeMin - b.timeMin);
  return events;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const lineKey = (Array.isArray(q.line) ? q.line[0] : q.line || "tokaido").toString().toLowerCase();
  const view = Spotter.line(lineKey);
  if (!view) { res.status(400).json({ error: "unknown line" }); return; }
  const sid = (Array.isArray(q.station) ? q.station[0] : q.station || "").toString().toLowerCase();
  const idx = view.indexOfId(sid);
  if (idx < 0) { res.status(400).json({ error: "unknown station id" }); return; }
  // Timetables change daily — cache hard on Vercel's CDN so the same station is
  // served to every visitor for 30 min without re-invoking this function.
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  if (process.env.BRIGHTDATA_API_TOKEN) {
    try {
      const events = await buildLiveEvents(view, idx);
      if (events.length) { res.status(200).json({ source: "brightdata", line: lineKey, station: sid, events }); return; }
    } catch { /* fall back to simulation */ }
  }
  res.status(200).json({ source: "simulation", line: lineKey, station: sid, events: view.buildSimEvents(idx) });
};
module.exports.parseBoard = parseBoard;
module.exports.classify = classify;
