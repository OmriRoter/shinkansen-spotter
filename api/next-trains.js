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
  const st = view.STATIONS[idx];
  const node = st.node, nl = st.nl || view.lineId;   // some lines span >1 NAVITIME line id (e.g. Hokuriku)
  const key = nl + ":" + node + ":" + dir;
  const hit = boardCache.get(key);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.rows;
  const url = `https://japantravel.navitime.com/en/area/jp/timetable/${node}/${nl}?direction=${dir}`;
  const rows = parseBoard(await unlock(url), dir);
  boardCache.set(key, { at: Date.now(), rows });
  return rows;
}

// run async tasks with bounded concurrency (protects against Bright Data rate limits
// on a cold cache; warm hub boards are cache hits and return instantly)
async function pool(tasks, limit) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

async function buildLiveEvents(view, idx) {
  const hubs = view.hubs();
  // Fetch the station's own board + every hub board, both directions.
  // Hub boards are cached and shared across all stations on the line, so after the
  // first lookup each extra station costs only its own board.
  const plan = [];
  for (const dir of ["down", "up"]) {
    plan.push({ dir, at: idx, own: true });
    for (const h of hubs) if (h !== idx) plan.push({ dir, at: h, own: false });
  }
  const boards = await pool(plan.map((p) => () => fetchBoard(view, p.at, p.dir)), 8);
  const byDir = { down: { own: [], hubs: [] }, up: { own: [], hubs: [] } };
  plan.forEach((p, i) => { if (p.own) byDir[p.dir].own = boards[i]; else byDir[p.dir].hubs.push({ h: p.at, rows: boards[i] }); });

  const events = [];
  for (const dir of ["down", "up"]) {
    const own = byDir[dir].own, ownNames = new Set(own.map((r) => r.name));
    for (const r of own) events.push({ type: r.type, dir, timeMin: r.depMin, stops: true, dest: r.dest, platform: r.platform });
    // where each non-stopping train appears across the hubs
    const appear = new Map();
    for (const { h, rows } of byDir[dir].hubs) for (const r of rows) {
      if (!appear.has(r.name)) appear.set(r.name, []);
      appear.get(r.name).push({ h, depMin: r.depMin, type: r.type, dest: r.dest });
    }
    for (const [name, arr] of appear) {
      if (ownNames.has(name)) continue;                 // it stops here → not a pass-through
      let before = null, after = null;                  // nearest hub it stops at on each side
      for (const a of arr) {
        if (a.h < idx && (!before || a.h > before.h)) before = a;
        if (a.h > idx && (!after || a.h < after.h)) after = a;
      }
      if (!before || !after) continue;
      // board times are departures; subtract the destination-side hub's dwell to
      // recover its arrival (Osaka/west going down, Tokyo/east going up).
      const dwell = Spotter.meta(before.type).dwell || 0;
      const bT = dir === "up" ? before.depMin - dwell : before.depMin;
      const aT = dir === "down" ? after.depMin - dwell : after.depMin;
      const t = view.interpolatePass([{ idx: before.h, timeMin: bT }, { idx: after.h, timeMin: aT }], idx, dir);
      if (t == null) continue;
      events.push({ type: before.type, dir, timeMin: t, stops: false, dest: before.dest });
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
