/* בדיקות שפיות בסיסיות למנוע ולמסלול ה-Bright Data (פענוח). */
"use strict";
const assert = require("assert");
const S = require("../engine");
const { parseStationTimetable, hhmmToMin, classify } = require("../server/scrape-navitime");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

console.log("engine:");
t("17 stations, Tokyo→Shin-Osaka ~485km", () => {
  assert.strictEqual(S.N, 17);
  assert.ok(S.CUM[S.N - 1] > 450 && S.CUM[S.N - 1] < 550);
});
t("Odawara has frequent passing Nozomi", () => {
  const ev = S.buildSimEvents(S.indexOfId("odawara"));
  const passes = ev.filter(e => !e.stops && (e.type === "nozomi" || e.type === "hikari"));
  assert.ok(passes.length > 50, "expected many passes, got " + passes.length);
});
t("Nagoya (major stop) has zero passes", () => {
  const ev = S.buildSimEvents(S.indexOfId("nagoya"));
  assert.strictEqual(ev.filter(e => !e.stops && e.type === "nozomi").length, 0);
});
t("blockingTrain flags a same-direction stopped train", () => {
  const ev = [{ type: "kodama", dir: "down", timeMin: 600, stops: true }];
  assert.ok(S.blockingTrain(ev, 602, "down"));
  assert.ok(!S.blockingTrain(ev, 602, "up"));
});
t("interpolatePass is distance-weighted between two stops", () => {
  const before = S.indexOfId("shinyokohama"), after = S.indexOfId("nagoya");
  const idx = S.indexOfId("odawara");
  const tt = S.interpolatePass([{ idx: before, timeMin: 600 }, { idx: after, timeMin: 700 }], idx, "down");
  assert.ok(tt > 600 && tt < 700);
});
t("approachBearing differs by direction", () => {
  const i = S.indexOfId("odawara");
  assert.notStrictEqual(Math.round(S.approachBearing(i, "down")), Math.round(S.approachBearing(i, "up")));
});

console.log("scraper parser:");
t("hhmmToMin parses HH:MM", () => assert.strictEqual(hhmmToMin("10:35"), 635));
t("classify maps service names", () => {
  assert.strictEqual(classify("Nozomi 225"), "nozomi");
  assert.strictEqual(classify("Kodama 631"), "kodama");
});
t("parseStationTimetable extracts trains from NAVITIME diagram HTML", () => {
  const html =
    `<dl class="timetable-area__list--definition" data-destination="Hakata" ` +
    `data-train-name="Nozomi 1 Go" data-hour="6" data-direction="down">` +
    `<dt class="time">00</dt><dd class="type" style="color:#DBAF00;">Nozomi</dd></dl>` +
    `<dl class="timetable-area__list--definition" data-destination="Shin-osaka" ` +
    `data-train-name="Hikari 631 Go" data-hour="6" data-direction="down">` +
    `<dt class="time">21</dt><dd class="type" style="color:#FF0000;">Hikari</dd></dl>`;
  const rows = parseStationTimetable(html, "down");
  assert.ok(rows.length >= 2);
  assert.strictEqual(rows[0].type, "nozomi");
  assert.strictEqual(rows[0].depMin, 360);
  assert.strictEqual(rows[0].trainName, "Nozomi 1 Go");
  assert.strictEqual(rows[1].depMin, 381);
});

console.log(`\n${pass} checks passed ✓`);
