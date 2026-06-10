// Vercel serverless function — live Shinkansen pass-through times.
// Self-contained so it bundles cleanly. Live data via Bright Data Web Unlocker
// when BRIGHTDATA_API_TOKEN is set in the project env; deterministic simulation
// fallback otherwise. The token is read ONLY from process.env, never exposed
// to the browser.

const STATIONS = [
  { id: "tokyo", lat: 35.6812, lon: 139.7671, jp: "東京" },
  { id: "shinagawa", lat: 35.6285, lon: 139.7387, jp: "品川" },
  { id: "shinyokohama", lat: 35.5079, lon: 139.6173, jp: "新横浜" },
  { id: "odawara", lat: 35.2563, lon: 139.1556, jp: "小田原" },
  { id: "atami", lat: 35.1031, lon: 139.0781, jp: "熱海" },
  { id: "mishima", lat: 35.1267, lon: 138.9111, jp: "三島" },
  { id: "shinfuji", lat: 35.1417, lon: 138.6633, jp: "新富士" },
  { id: "shizuoka", lat: 34.9719, lon: 138.3886, jp: "静岡" },
  { id: "kakegawa", lat: 34.7692, lon: 137.9986, jp: "掛川" },
  { id: "hamamatsu", lat: 34.7036, lon: 137.7347, jp: "浜松" },
  { id: "toyohashi", lat: 34.7628, lon: 137.3819, jp: "豊橋" },
  { id: "mikawaanjo", lat: 34.9367, lon: 137.0594, jp: "三河安城" },
  { id: "nagoya", lat: 35.1706, lon: 136.8816, jp: "名古屋" },
  { id: "gifuhashima", lat: 35.3156, lon: 136.6861, jp: "岐阜羽島" },
  { id: "maibara", lat: 35.3147, lon: 136.2894, jp: "米原" },
  { id: "kyoto", lat: 34.9858, lon: 135.7589, jp: "京都" },
  { id: "shinosaka", lat: 34.7333, lon: 135.5003, jp: "新大阪" },
];
const N = STATIONS.length;
const STOPS = {
  nozomi: new Set([0, 1, 2, 12, 15, 16]),
  hikari: new Set([0, 1, 2, 3, 7, 12, 14, 15, 16]),
  kodama: new Set(Array.from({ length: N }, (_, i) => i)),
};
const META = { nozomi: { cruise: 285, dwell: 1.5 }, hikari: { cruise: 255, dwell: 2.0 }, kodama: { cruise: 220, dwell: 1.0 } };
const SCHEDULE = [
  { type: "nozomi", headway: 10, downOffset: 0, upOffset: 5 },
  { type: "hikari", headway: 30, downOffset: 8, upOffset: 23 },
  { type: "kodama", headway: 20, downOffset: 3, upOffset: 13 },
];
const SERVICE_START = 360, SERVICE_END = 1380;
const R = 6371, toRad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const CUM = (() => { const c = [0]; for (let i = 1; i < N; i++) c[i] = c[i - 1] + haversine(STATIONS[i - 1], STATIONS[i]); return c; })();
const idOf = (id) => STATIONS.findIndex((s) => s.id === id);

function eventTime(type, dir, base, idx) {
  const m = META[type], st = STOPS[type];
  let dist, lo, hi;
  if (dir === "down") { dist = CUM[idx] - CUM[0]; lo = 1; hi = idx; }
  else { dist = CUM[N - 1] - CUM[idx]; lo = idx + 1; hi = N - 2; }
  let tv = (dist / m.cruise) * 60;
  for (let i = lo; i <= hi; i++) if (st.has(i)) tv += m.dwell;
  return base + tv;
}
function buildSimEvents(idx) {
  const out = [];
  for (const s of SCHEDULE) for (const dir of ["down", "up"]) {
    const off = dir === "down" ? s.downOffset : s.upOffset;
    for (let b = SERVICE_START + off; b <= SERVICE_END; b += s.headway) {
      const t = eventTime(s.type, dir, b, idx);
      if (t < SERVICE_START || t > SERVICE_END + 30) continue;
      out.push({ type: s.type, dir, timeMin: t, stops: STOPS[s.type].has(idx) });
    }
  }
  out.sort((a, b) => a.timeMin - b.timeMin);
  return out;
}
function interpolate(loIdx, loT, hiIdx, hiT, idx) {
  return loT + ((CUM[idx] - CUM[loIdx]) / (CUM[hiIdx] - CUM[loIdx])) * (hiT - loT);
}
async function unlock(url) {
  const res = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone: process.env.BRIGHTDATA_ZONE || "web_unlocker1", url, format: "raw", country: "jp" }),
  });
  if (!res.ok) throw new Error(`Bright Data ${res.status}`);
  return res.text();
}
function parseBoard(html) {
  const out = [], re = /(\d{1,2}:\d{2})[\s\S]{0,120}?(Nozomi|Hikari|Kodama)\s*(\d+)?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const mm = /(\d{1,2}):(\d{2})/.exec(m[1]);
    out.push({ name: `${m[2]} ${m[3] || ""}`.trim(), type: m[2].toLowerCase(), depMin: +mm[1] * 60 + +mm[2] });
  }
  return out;
}
async function fetchBoard(idx, dir) {
  const url = `https://japantravel.navitime.com/en/area/jp/timetable/search?word=${encodeURIComponent(STATIONS[idx].jp)}&direction=${dir}&type=Nozomi`;
  return parseBoard(await unlock(url));
}
async function buildLiveEvents(idx) {
  const events = [], stopIdxs = [...STOPS.nozomi].sort((a, b) => a - b);
  for (const dir of ["down", "up"]) {
    const before = [...stopIdxs].reverse().find((i) => i < idx);
    const after = stopIdxs.find((i) => i > idx);
    if (before == null || after == null) continue;
    const [b1, b2] = await Promise.all([fetchBoard(before, dir), fetchBoard(after, dir)]);
    const map = new Map();
    for (const r of b1) map.set(r.name, { before: r.depMin, type: r.type });
    for (const r of b2) { const e = map.get(r.name) || { type: r.type }; e.after = r.depMin; map.set(r.name, e); }
    for (const [, e] of map) {
      if (e.before == null || e.after == null) continue;
      events.push({ type: e.type, dir, timeMin: interpolate(before, e.before, after, e.after, idx), stops: false });
    }
  }
  events.sort((a, b) => a.timeMin - b.timeMin);
  return events;
}

module.exports = async (req, res) => {
  const id = (req.query.station || "odawara").toString();
  const idx = idOf(id);
  if (idx < 0) { res.status(400).json({ error: "unknown station id" }); return; }
  if (process.env.BRIGHTDATA_API_TOKEN) {
    try {
      const events = await buildLiveEvents(idx);
      if (events.length) { res.status(200).json({ source: "brightdata", station: id, events }); return; }
    } catch { /* fall back to simulation */ }
  }
  res.status(200).json({ source: "simulation", station: id, events: buildSimEvents(idx) });
};
