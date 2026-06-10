/* Sanity tests for the multi-line engine and the NAVITIME board parser. */
"use strict";
const assert = require("assert");
const S = require("../engine");
const api = require("../api/next-trains.js");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

console.log("engine (multi-line):");
t("5 lines load with stations + hubs", () => {
  assert.deepStrictEqual(S.LINE_KEYS, ["tokaido", "sanyo", "tohoku", "kyushu", "hokuriku"]);
  for (const k of S.LINE_KEYS) {
    const v = S.line(k);
    assert.ok(v.N >= 10, k + " has stations");
    assert.ok(v.hubs().length >= 3, k + " has hubs");
  }
});
t("Tokaido is unchanged: 17 stations, Tokyo->Shin-Osaka ~485km, nozomi stops at 6", () => {
  const v = S.line("tokaido");
  assert.strictEqual(v.N, 17);
  assert.ok(v.CUM[v.N - 1] > 450 && v.CUM[v.N - 1] < 550);
  assert.strictEqual(v.STOPS.nozomi.size, 6);
});
t("nearestStation finds the right line+station", () => {
  const near = S.nearestStation(34.7025, 135.4959); // Shin-Osaka
  assert.ok(["tokaido", "sanyo"].includes(near.lineKey));
  assert.strictEqual(S.line(near.lineKey).STATIONS[near.idx].id, "shinosaka");
  const t2 = S.nearestStation(35.681, 139.767); // Tokyo
  assert.strictEqual(S.line(t2.lineKey).STATIONS[t2.idx].id, "tokyo");
});
t("interpolatePass is distance-weighted between two hubs", () => {
  const v = S.line("tokaido");
  const before = v.indexOfId("shinyokohama"), after = v.indexOfId("nagoya"), idx = v.indexOfId("odawara");
  const tt = v.interpolatePass([{ idx: before, timeMin: 600 }, { idx: after, timeMin: 700 }], idx, "down");
  assert.ok(tt > 600 && tt < 700);
});
t("approachBearing differs by direction", () => {
  const v = S.line("tokaido"), i = v.indexOfId("odawara");
  assert.notStrictEqual(Math.round(v.approachBearing(i, "down")), Math.round(v.approachBearing(i, "up")));
});
t("blockingTrain flags a same-direction stopped train, carries platform", () => {
  const ev = [{ type: "kodama", dir: "down", timeMin: 600, stops: true, platform: 13 }];
  const blk = S.blockingTrain(ev, 602, "down");
  assert.ok(blk && blk.platform === 13);
  assert.ok(!S.blockingTrain(ev, 602, "up"));
});
t("meta() resolves every train type used across the lines", () => {
  const types = new Set();
  for (const k of S.LINE_KEYS) S.line(k).types.forEach(x => types.add(x));
  for (const x of types) assert.ok(S.meta(x).cls, "meta for " + x);
});

console.log("board parser:");
t("classify maps service names to types", () => {
  assert.strictEqual(api.classify("Nozomi 1 Go"), "nozomi");
  assert.strictEqual(api.classify("Hayabusa 5 Go"), "hayabusa");
  assert.strictEqual(api.classify("Mizuho 601 Go"), "mizuho");
  assert.strictEqual(api.classify("Nonsense"), null);
});
t("parseBoard extracts trains from NAVITIME diagram HTML", () => {
  const html =
    `<dl class="timetable-area__list--definition" data-destination="Hakata" ` +
    `data-train-name="Nozomi 1 Go" data-hour="6" data-direction="down">` +
    `<dt class="time">00</dt><dd class="type">Nozomi</dd><dd class="destination"> Platform: 14</dd></dl>`;
  const rows = api.parseBoard(html, "down");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].type, "nozomi");
  assert.strictEqual(rows[0].depMin, 360);
  assert.strictEqual(rows[0].platform, 14);
  assert.strictEqual(rows[0].dest, "Hakata");
});

console.log(`\n${pass} checks passed ✓`);
