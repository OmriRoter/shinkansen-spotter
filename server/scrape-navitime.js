/* =========================================================================
   scrape-navitime.js — מושך לו"ז אמיתי של רכבות Nozomi/Hikari/Kodama דרך
   Bright Data Web Unlocker, ומחשב את זמן ה*מעבר* בתחנה שבה הרכבת לא עוצרת
   (אינטרפולציה לפי מרחק בין שתי תחנות-העצירה העוטפות).

   למה דרך Bright Data: הדפים הרשמיים של JR מחזירים 403 ל-scraper רגיל,
   ו-NAVITIME מוגן anti-bot. Web Unlocker עוקף את שניהם ומחזיר HTML נקי.

   מבנה הנתונים ב-NAVITIME: עמוד הלו"ז (diagram) מוגש בצד-השרת כ-HTML
   עם השעות *לא* בפורמט HH:MM אלא כ"diagram": שעה ב-data-hour ודקות ב-<dt>.
   כל רכבת היא בלוק:
     <dl class="timetable-area__list--definition"
         data-train-name="Nozomi 1 Go" data-hour="6"
         data-direction="down" data-destination="Hakata">
       <dt class="time">00</dt> <dd class="type">Nozomi</dd> ...
   הפענוח מרוכז ב-parseStationTimetable; אם NAVITIME ישנה מבנה — מעדכנים שם.
   בכל כשל פענוח, server/index.js נופל אוטומטית לסימולציה.
   ========================================================================= */
"use strict";

const { unlock } = require("./brightdata");
const Spotter = require("../engine");

/* קו טוקאידו–סאניו שינקנסן ב-NAVITIME japantravel */
const LINE_ID = "00000110";

/* מזהי-node של NAVITIME לכל תחנה, לפי סדר התחנות ב-engine (idx 0..16).
   נדלו מעמוד הקו: /en/area/jp/railroad/00000110/ . */
const NODE_IDS = {
  tokyo: "00006668", shinagawa: "00007825", shinyokohama: "00004179", odawara: "00003742",
  atami: "00007326", mishima: "00003056", shinfuji: "00004358", shizuoka: "00004995",
  kakegawa: "00001232", hamamatsu: "00007841", toyohashi: "00008206", mikawaanjo: "00002968",
  nagoya: "00008576", gifuhashima: "00001468", maibara: "00008117", kyoto: "00001756",
  shinosaka: "00004305",
};

/* ממפה כינוי-רכבת ל-type של המנוע */
function classify(name) {
  const s = (name || "").toLowerCase();
  if (s.includes("nozomi")) return "nozomi";
  if (s.includes("hikari")) return "hikari";
  if (s.includes("kodama")) return "kodama";
  return null;
}

/* "HH:MM" -> דקות מחצות (נשמר לשירות כללי/בדיקות) */
function hhmmToMin(t) {
  const m = /(\d{1,2}):(\d{2})/.exec(t || "");
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/* ----- פענוח עמוד-הלו"ז (diagram) של NAVITIME — selectors מרוכזים כאן -----
   מחזיר רשומות { trainName, type, dir, depMin, destination } לתחנה.
   מחלץ כל בלוק רכבת ושולף data-train-name / data-hour / data-direction /
   data-destination יחד עם דקות (<dt class="time">) וסוג (<dd class="type">). */
function parseStationTimetable(html, dir) {
  const out = [];
  const blocks = String(html).split("timetable-area__list--definition").slice(1);
  for (const blk of blocks) {
    const seg = blk.slice(0, 600); // גבול בלוק — מונע דליפה לרכבת הבאה
    const name = (seg.match(/data-train-name="([^"]*)"/) || [])[1];
    const hour = (seg.match(/data-hour="(\d+)"/) || [])[1];
    const ddir = (seg.match(/data-direction="([^"]*)"/) || [])[1] || dir;
    const dest = (seg.match(/data-destination="([^"]*)"/) || [])[1] || "";
    const tm = seg.match(/<dt class="time">\s*(\d{1,2})\s*<\/dt>/);
    const ty = seg.match(/<dd class="type"[^>]*>\s*([^<]+?)\s*<\/dd>/);
    const plat = seg.match(/Platform:\s*(\d+)/i);
    const type = classify(name) || (ty ? classify(ty[1]) : null);
    if (name && hour != null && tm && type) {
      out.push({
        trainName: name, type, dir: ddir, depMin: (+hour) * 60 + (+tm[1]),
        destination: dest, platform: plat ? +plat[1] : null,
      });
    }
  }
  return out;
}

/* מושך את לו"ז התחנה (כל הרכבות שעוצרות בה) בכיוון נתון */
async function fetchStationBoard(stationIdx, dir) {
  const st = Spotter.STATIONS[stationIdx];
  const node = NODE_IDS[st.id];
  if (!node) return [];
  const url = `https://japantravel.navitime.com/en/area/jp/timetable/${node}/${LINE_ID}?direction=${dir}`;
  const html = await unlock(url, { country: "jp" });
  return parseStationTimetable(html, dir);
}

/**
 * בונה אירועי-רכבת אמיתיים בתחנה idx בפורמט המנוע { type, dir, timeMin, stops }.
 *  - אם idx היא תחנת-עצירה ראשית של Nozomi: הרכבות המהירות עוצרות (לא חולפות),
 *    ולכן מחזירים את לו"ז התחנה עצמה (stops:true).
 *  - אחרת: מחזירים גם את הרכבות שעוצרות ב-idx (Kodama/Hikari, stops:true) וגם
 *    את הרכבות החולפות (Nozomi וכו') — זמן-מעבר באינטרפולציה בין שתי תחנות-
 *    העצירה של Nozomi שעוטפות את idx (stops:false).
 */
async function buildLiveEvents(idx) {
  const events = [];
  const stopIdxs = [...Spotter.STOPS.nozomi].sort((a, b) => a - b);
  const isStop = Spotter.STOPS.nozomi.has(idx);

  for (const dir of ["down", "up"]) {
    const before = [...stopIdxs].reverse().find((i) => i < idx);
    const after = stopIdxs.find((i) => i > idx);

    // לו"ז התחנה עצמה (רכבות שעוצרות כאן)
    const ownP = fetchStationBoard(idx, dir);
    // תחנות-העצירה העוטפות (לחישוב מעבר) — רק אם idx אינה תחנת-עצירה בעצמה
    const wrap = !isStop && before != null && after != null;
    const beforeP = wrap ? fetchStationBoard(before, dir) : Promise.resolve([]);
    const afterP = wrap ? fetchStationBoard(after, dir) : Promise.resolve([]);
    const [own, boardBefore, boardAfter] = await Promise.all([ownP, beforeP, afterP]);

    for (const r of own) events.push({
      type: r.type, dir, timeMin: r.depMin, stops: true, dest: r.destination, platform: r.platform,
    });

    if (wrap) {
      const ownNames = new Set(own.map((r) => r.trainName));
      const byName = new Map();
      for (const r of boardBefore) byName.set(r.trainName, { before: r.depMin, type: r.type, dest: r.destination });
      for (const r of boardAfter) { const e = byName.get(r.trainName); if (e) e.after = r.depMin; }
      for (const [name, e] of byName) {
        if (e.before == null || e.after == null) continue;
        if (ownNames.has(name)) continue; // למעשה עוצרת ב-idx — לא מעבר
        // זמן ה"after" הוא יציאה מהתחנה הבאה וכולל את זמן-העצירה (dwell) שלה;
        // מחסירים אותו כדי לקבל את זמן-ההגעה האמיתי ולדייק את האינטרפולציה.
        const dwell = (Spotter.TRAIN_META[e.type] || {}).dwell || 0;
        const t = Spotter.interpolatePass(
          [{ idx: before, timeMin: e.before }, { idx: after, timeMin: e.after - dwell }], idx, dir);
        if (t == null) continue;
        events.push({ type: e.type, dir, timeMin: t, stops: false, dest: e.dest });
      }
    }
  }

  events.sort((a, b) => a.timeMin - b.timeMin);
  return events;
}

module.exports = { buildLiveEvents, parseStationTimetable, fetchStationBoard, hhmmToMin, classify, NODE_IDS, LINE_ID };
