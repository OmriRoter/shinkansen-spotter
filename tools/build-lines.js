/* Regenerates lines-data.js from the harvested data/lines.json.
   data/lines.json holds the scraped station lists + per-type stop patterns
   (node, name, kanji, lat, lon, stops). This script layers on the display
   names, the curated hub set per line (used to bracket pass-throughs), and
   the per-train-type metadata, then emits the UMD module the app consumes.

   Run:  npm run build:data
*/
"use strict";
const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/lines.json"), "utf8"));

const LINE_META = {
  tokaido:  { name: "Tokaido",  jp: "東海道", express: "nozomi",   hubs: ["Tokyo", "Shinagawa", "Shin-Yokohama", "Nagoya", "Kyoto", "Shin-osaka"] },
  sanyo:    { name: "Sanyo",    jp: "山陽",   express: "mizuho",   hubs: ["Shin-osaka", "Shin-kobe", "Himeji", "Okayama", "Fukuyama", "Hiroshima", "Shin-Yamaguchi", "Kokura(Fukuoka)", "Hakata"] },
  tohoku:   { name: "Tohoku",   jp: "東北",   express: "hayabusa", hubs: ["Tokyo", "Ueno", "Omiya (Saitama)", "Sendai", "Morioka", "Shin-Aomori"] },
  kyushu:   { name: "Kyushu",   jp: "九州",   express: "mizuho",   hubs: ["Hakata", "Kurume", "Kumamoto", "Sendai(Kagoshima)", "Kagoshima-chuo"] },
  hokuriku: { name: "Hokuriku", jp: "北陸",   express: "kagayaki", hubs: ["Tokyo", "Ueno", "Omiya (Saitama)", "Nagano", "Toyama", "Kanazawa", "Fukui(Fukui)", "Tsuruga"] },
};

// cls tiers: ltd = premier express, rapid = limited-stop, local = all-stops
const TYPE_META = {
  nozomi:   { en: "Nozomi",   jp: "のぞみ",   cls: "ltd",   cruise: 285, dwell: 1.5 },
  mizuho:   { en: "Mizuho",   jp: "みずほ",   cls: "ltd",   cruise: 300, dwell: 1.5 },
  hayabusa: { en: "Hayabusa", jp: "はやぶさ", cls: "ltd",   cruise: 320, dwell: 1.5 },
  kagayaki: { en: "Kagayaki", jp: "かがやき", cls: "ltd",   cruise: 260, dwell: 1.0 },
  hikari:   { en: "Hikari",   jp: "ひかり",   cls: "rapid", cruise: 270, dwell: 1.5 },
  sakura:   { en: "Sakura",   jp: "さくら",   cls: "rapid", cruise: 285, dwell: 1.5 },
  hakutaka: { en: "Hakutaka", jp: "はくたか", cls: "rapid", cruise: 260, dwell: 1.0 },
  hayate:   { en: "Hayate",   jp: "はやて",   cls: "rapid", cruise: 275, dwell: 1.5 },
  komachi:  { en: "Komachi",  jp: "こまち",   cls: "rapid", cruise: 320, dwell: 1.0 },
  tsubasa:  { en: "Tsubasa",  jp: "つばさ",   cls: "rapid", cruise: 275, dwell: 1.0 },
  yamabiko: { en: "Yamabiko", jp: "やまびこ", cls: "local", cruise: 275, dwell: 1.0 },
  kodama:   { en: "Kodama",   jp: "こだま",   cls: "local", cruise: 230, dwell: 1.0 },
  tsubame:  { en: "Tsubame",  jp: "つばめ",   cls: "local", cruise: 260, dwell: 1.0 },
  nasuno:   { en: "Nasuno",   jp: "なすの",   cls: "local", cruise: 240, dwell: 1.0 },
  asama:    { en: "Asama",    jp: "あさま",   cls: "local", cruise: 260, dwell: 1.0 },
  tsurugi:  { en: "Tsurugi",  jp: "つるぎ",   cls: "local", cruise: 260, dwell: 1.0 },
};

let ok = true;
for (const [k, L] of Object.entries(data)) {
  const meta = LINE_META[k];
  if (!meta) { console.error("no LINE_META for " + k); ok = false; continue; }
  L.name = meta.name; L.jp = meta.jp; L.express = meta.express;
  L.types = Object.keys(L.stops);
  L.hubs = meta.hubs.map(nm => {
    const i = L.stations.findIndex(s => s.name === nm);
    if (i < 0) { console.error(k + ": hub not found: " + nm); ok = false; }
    return i;
  }).filter(i => i >= 0).sort((a, b) => a - b);
}
if (!ok) process.exit(1);

const used = new Set();
for (const L of Object.values(data)) L.types.forEach(t => used.add(t));
const tmeta = {};
for (const t of used) {
  if (!TYPE_META[t]) { console.warn("no TYPE_META for " + t + " (using default)"); tmeta[t] = { en: t, jp: t, cls: "rapid", cruise: 270, dwell: 1.5 }; }
  else tmeta[t] = TYPE_META[t];
}

const out = '(function(root,factory){const m=factory();if(typeof module!=="undefined"&&module.exports)module.exports=m;root.SpotterLines=m;})(typeof self!=="undefined"?self:this,function(){return '
  + JSON.stringify({ LINES: data, TYPE_META: tmeta }) + ";});\n";
fs.writeFileSync(path.join(__dirname, "../lines-data.js"), out);
console.log("wrote lines-data.js — " + Object.keys(data).length + " lines, "
  + Object.values(data).reduce((a, L) => a + L.stations.length, 0) + " stations, " + used.size + " train types");
