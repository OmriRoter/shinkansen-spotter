/* =========================================================================
   scrape-navitime.js — מושך לו"ז אמיתי של רכבות Nozomi/Hikari דרך Bright Data,
   ומחשב את זמן ה*מעבר* בתחנה שבה הרכבת לא עוצרת (אינטרפולציה לפי מרחק).

   למה דרך Bright Data: הדפים הרשמיים של JR (traininfo.jr-central.co.jp)
   מחזירים 403 ל-scraper רגיל, ו-NAVITIME מוגן anti-bot + מרונדר ב-JS.
   Web Unlocker עוקף את שניהם ומחזיר HTML נקי.

   הערה: ה-DOM של NAVITIME משתנה מדי פעם. ה-selectors כאן מרוכזים ב-PARSE
   ומתועדים, כך שעדכון עתידי הוא שינוי במקום אחד. אם הפענוח נכשל,
   server/index.js נופל אוטומטית לסימולציה.
   ========================================================================= */
"use strict";

const { unlock } = require("./brightdata");
const Spotter = require("../engine");

/* כתובות לוח-הזמנים לכל תחנה בקו (down/up) ב-NAVITIME.
   הבסיס משותף; ה-id הספציפי לכל תחנה ניתן להרחבה בהמשך. כאן אנו סורקים
   את לוחות הזמנים של תחנות העצירה העוטפות כדי לבנות לו"ז-רכבת ואז לחשב מעבר. */
const NAVITIME_BASE = "https://japantravel.navitime.com/en/area/jp/timetable";

/* ממפה כינוי-רכבת ל-type של המנוע */
function classify(name) {
  const s = (name || "").toLowerCase();
  if (s.includes("nozomi")) return "nozomi";
  if (s.includes("hikari")) return "hikari";
  if (s.includes("kodama")) return "kodama";
  return null;
}

/* "HH:MM" -> דקות מחצות */
function hhmmToMin(t) {
  const m = /(\d{1,2}):(\d{2})/.exec(t || "");
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/* ----- פענוח HTML של NAVITIME (selectors מרוכזים כאן) -----
   מחזיר רשומות { trainName, type, dir, departures:[{hhmm}] } לתחנה.
   זהו פענוח best-effort עמיד: מחפש בלוקי-שעה ושמות-רכבת בטקסט. */
function parseStationTimetable(html, dir) {
  const out = [];
  // NAVITIME מציג כל רכבת כבלוק עם שעה ושם שירות. אנו מחלצים זוגות (שעה, שם).
  // דפוס עמיד-יחסית: שעה HH:MM קרובה למילה Nozomi/Hikari/Kodama.
  const re = /(\d{1,2}:\d{2})[\s\S]{0,120}?(Nozomi|Hikari|Kodama)\s*(\d+)?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const type = classify(m[2]);
    if (!type) continue;
    out.push({ trainName: `${m[2]} ${m[3] || ""}`.trim(), type, dir, depMin: hhmmToMin(m[1]) });
  }
  return out;
}

/* מושך את לוח-הזמנים של תחנה אחת (כל הרכבות) בכיוון נתון */
async function fetchStationBoard(stationIdx, dir) {
  // NAVITIME דורש מזהי-תחנה ספציפיים; כאן נשתמש בחיפוש לפי שם כ-fallback יציב.
  const st = Spotter.STATIONS[stationIdx];
  const url = `${NAVITIME_BASE}/search?word=${encodeURIComponent(st.jp)}&direction=${dir}&type=Nozomi`;
  const html = await unlock(url, { country: "jp" });
  return parseStationTimetable(html, dir);
}

/**
 * בונה אירועי-מעבר אמיתיים בתחנה idx ע"י סריקת שתי תחנות-העצירה העוטפות.
 * עבור רכבת שלא עוצרת ב-idx, לוקחים את זמן-היציאה שלה בתחנת-העצירה הקודמת
 * ובתחנה הבאה, ומבצעים אינטרפולציה לפי מרחק -> זמן מעבר משוער.
 * מחזיר אירועים בפורמט { type, dir, timeMin, stops }.
 */
async function buildLiveEvents(idx) {
  const events = [];
  for (const dir of ["down", "up"]) {
    // תחנות העצירה הקרובות של Nozomi משני צידי idx (לקו טוקאידו)
    const stopIdxs = [...Spotter.STOPS.nozomi].sort((a, b) => a - b);
    const before = [...stopIdxs].reverse().find(i => i < idx);
    const after = stopIdxs.find(i => i > idx);
    if (before == null || after == null) continue; // idx עצמה תחנת-קצה ראשית

    const [boardBefore, boardAfter] = await Promise.all([
      fetchStationBoard(before, dir),
      fetchStationBoard(after, dir),
    ]);

    // מתאימים רכבות לפי שם-שירות (Nozomi NNN) בין שתי התחנות
    const byName = new Map();
    for (const r of boardBefore) byName.set(r.trainName, { before: r.depMin });
    for (const r of boardAfter) {
      const e = byName.get(r.trainName) || {};
      e.after = r.depMin; e.type = r.type;
      byName.set(r.trainName, e);
    }
    for (const [, e] of byName) {
      if (e.before == null || e.after == null || e.type == null) continue;
      const t = Spotter.interpolatePass(
        [{ idx: before, timeMin: e.before }, { idx: after, timeMin: e.after }], idx, dir);
      if (t == null) continue;
      events.push({ type: e.type, dir, timeMin: t, stops: false });
    }
  }
  events.sort((a, b) => a.timeMin - b.timeMin);
  return events;
}

module.exports = { buildLiveEvents, parseStationTimetable, hhmmToMin, classify };
