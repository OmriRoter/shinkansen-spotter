# 🚄 Shinkansen Spotter

Stand on a Japanese Shinkansen platform and see **when the next bullet train blasts
through without stopping** — which direction it comes from, which side to point your
camera, and a live countdown. Built for trainspotters and photographers.

**Live:** https://shinkansen-spotter.vercel.app/

A non-stopping train never appears in a station's departure board, so the app
**interpolates its pass-through time** from the timetables of the surrounding hub
stations where it *does* stop. Live timetables are scraped from public NAVITIME
pages through the Bright Data Web Unlocker; if that's unavailable it falls back to a
deterministic simulation, so the UI always works.

## Features

- **5 lines:** Tokaido, Sanyo, Tohoku, Kyushu, Hokuriku (84 stations).
- **Auto-locate** the nearest station across all lines via GPS.
- **Pass-through countdown** with train type (Nozomi/Mizuho/Hayabusa/…), destination
  and estimated speed.
- **Platform aware:** pick which side you're on to see the trains in front of you,
  with the opposite "far track" shown separately.
- **Live device compass:** the dial turns with your phone and tells you whether the
  train enters from your **left / right / ahead**.
- **Blocking alert:** warns when a stopping train on your platform (with its real
  platform number) may hide the shot.
- Japan-time (JST) clock, 5-minute auto-refresh, CDN + in-memory caching.

## How it works

```
lines-data.js   station + stop data for every line (generated from data/lines.json)
engine.js       shared logic: geometry, nearest-station, simulation, interpolation,
                blocking — exposes a per-line "view". Runs in browser and Node.
index.html      the UI (loads lines-data.js + engine.js)
api/next-trains.js  serverless function: scrapes NAVITIME via Bright Data, brackets
                each pass-through between the nearest hubs it stops at, caches results.
                The Bright Data token is read only from server env — never sent to the browser.
server/index.js     local dev server; delegates /api/next-trains to the same handler
data/lines.json     source-of-truth dataset (node ids, names, kanji, coords, stop patterns)
tools/build-lines.js  regenerates lines-data.js from data/lines.json
```

Request flow (live): `index.html → /api/next-trains?line=&station= → Bright Data
(NAVITIME) → interpolated pass-through events → UI`. On any failure (no token, scrape
error, 0 results) it falls back to the simulation engine automatically.

## Run locally

```bash
npm install            # no external dependencies
cp .env.example .env    # add BRIGHTDATA_API_TOKEN + BRIGHTDATA_ZONE for live data
npm start               # http://localhost:8080
npm test                # engine + parser sanity checks
```

Without a Bright Data token it runs in simulation mode. Node ≥ 18 (uses built-in `fetch`).

## Deploy

Vercel (static front-end + the `api/next-trains.js` function). Set the project env vars
`BRIGHTDATA_API_TOKEN` and `BRIGHTDATA_ZONE`, then push. Responses are CDN-cached
(`s-maxage=1800`) and hub timetable boards are cached in-memory and shared across
stations, so live scraping stays minimal under load.

## Updating / extending the data

`data/lines.json` is the source of truth. After editing it (or re-harvesting), run
`npm run build:data` to regenerate `lines-data.js`. Adding a line = adding its stations,
stop patterns, and a hub set in `data/lines.json` + `tools/build-lines.js`.

## Limitations (honest)

- Pass-through times are **estimates** (distance interpolation, ~±1 minute) — JR
  publishes platforms only for *stopping* trains, not the exact track a passing train uses.
- **Scheduled** timetables only; real-time delays are not reflected.
- Bearings are computed from station coordinates, approximating track curves.

## ⚠️ Safety

A spotting tool. **Never cross beyond the yellow tactile line.** Bullet trains pass at
very high speed.

## License

MIT.
